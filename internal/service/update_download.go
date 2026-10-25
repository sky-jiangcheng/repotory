package service

// Update download: fetch a release bundle into a local file, report progress
// while it runs, and verify the bytes against the digest the release API
// reports for that asset.
//
// Why this exists next to update.go. The check in update.go answers "is there
// a newer version"; it deliberately hands the download to the system browser,
// because an app that silently replaces its own binary is a large trust
// surface. That reasoning still holds for the INSTALL. It does not hold for
// the DOWNLOAD: the browser handoff loses every bit of progress feedback
// (percent, bytes, speed, ETA) that a user actually wants while waiting for
// a 100 MB+ bundle, and it cannot report a checksum verdict — which is the
// one thing that makes an in-app download safer than a browser one.
//
// So the boundary this file draws is deliberate and narrow:
//
//   - The app DOWNLOADS the bundle to a file under the platform data dir and
//     verifies its SHA256 against the digest GitHub's release API reports for
//     that asset ("sha256:..."). A mismatch fails loudly and the file is
//     deleted.
//   - The app NEVER touches the installation. Nothing here writes to the
//     directory the running binary lives in, and nothing here replaces or
//     renames the running executable. The verified file is handed to the OS
//     (open the .dmg, reveal the .zip) so the user performs the install with
//     the same consent they give a browser download.
//
// This is the shape every mainstream desktop updater uses: the app fetches
// and verifies, the OS installer does the replacing.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"repotory/internal/db"
)

// Download phase names. The frontend switches on these; they are part of the
// binding contract and must not be renamed without updating it.
const (
	// DownloadIdle is the state before any download starts.
	DownloadIdle = "idle"
	// DownloadRunning means bytes are moving.
	DownloadRunning = "running"
	// DownloadVerifying means the file is complete and its digest is being
	// checked against the release's published digest.
	DownloadVerifying = "verifying"
	// DownloadDone means the file is downloaded and its digest matched.
	DownloadDone = "done"
	// DownloadFailed means the download or the verification failed.
	DownloadFailed = "failed"
	// DownloadCanceled means the user canceled it.
	DownloadCanceled = "canceled"
)

// DownloadState is the progress snapshot of the current (or last) download.
//
// DownloadSpeed is a smoothed bytes-per-second figure rather than an
// instantaneous one: a raw last-chunk rate reads as wildly jittery and makes
// the ETA flip between nonsense values, which is worse than no ETA at all.
//
// RemainingSeconds is -1 when the speed is not yet known (the first chunk
// has not arrived) or when the total size is unknown.
type DownloadState struct {
	// Phase is one of the Download* constants.
	Phase string `json:"phase"`
	// Version is the release tag this download belongs to ("2.13.1").
	Version string `json:"version"`
	// FileName is the bundle's file name (e.g. "repotory-darwin-arm64.dmg").
	FileName string `json:"file_name"`
	// Downloaded is the number of bytes written so far.
	Downloaded int64 `json:"downloaded"`
	// Total is the expected size in bytes, 0 when the server did not say.
	Total int64 `json:"total"`
	// Speed is the smoothed transfer rate in bytes per second.
	Speed int64 `json:"speed"`
	// RemainingSeconds is the ETA, -1 when it cannot be estimated.
	RemainingSeconds int64 `json:"remaining_seconds"`
	// Path is the local file path, set once the download completes.
	Path string `json:"path"`
	// Error carries the failure reason when Phase is DownloadFailed.
	Error string `json:"error"`
	// ChecksumVerified reports whether the digest matched the one the
	// release published. False for a download whose release shipped no
	// digest (never for a verified one).
	ChecksumVerified bool `json:"checksum_verified"`
}

// Percent returns the completion percentage, 0 when the total size is
// unknown. The frontend uses it for the progress bar; the backend keeps the
// arithmetic in one place so the bar and the byte counter can never disagree.
func (d DownloadState) Percent() float64 {
	if d.Total <= 0 {
		return 0
	}
	p := float64(d.Downloaded) / float64(d.Total) * 100
	if p > 100 {
		return 100
	}
	return p
}

// updateDownloader owns the one in-flight download.
//
// One at a time, on purpose: two concurrent downloads would race on the
// progress snapshot (which is a single object, not a history) and the user
// has no way to tell which file a stale progress bar belongs to. A second
// StartUpdateDownload while one is running is rejected with a clear error
// rather than silently replacing the state.
type updateDownloader struct {
	mu sync.Mutex

	state DownloadState
	// cancel aborts the in-flight HTTP request.
	cancel context.CancelFunc
	// running marks an active download (as opposed to a finished one whose
	// state is still worth showing).
	running bool
}

// newUpdateDownloader returns a downloader in the idle state.
func newUpdateDownloader() *updateDownloader {
	return &updateDownloader{state: DownloadState{Phase: DownloadIdle, RemainingSeconds: -1}}
}

// snapshot returns a copy of the current state.
func (d *updateDownloader) snapshot() DownloadState {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.state
}

// begin starts a new download, replacing any finished state.
//
// It also creates the cancellable context, so a cancel that arrives
// immediately after begin() is never lost to a race with the download
// goroutine still setting up.
//
// The caller has already validated the URL, the target file name and the
// destination directory.
func (d *updateDownloader) begin(ctx context.Context, version, fileName string, total int64) (context.Context, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.running {
		return nil, errors.New("已有更新正在下载")
	}
	reqCtx, cancel := context.WithCancel(ctx)
	d.cancel = cancel
	d.state = DownloadState{
		Phase:            DownloadRunning,
		Version:          version,
		FileName:         fileName,
		Total:            total,
		RemainingSeconds: -1,
	}
	d.running = true
	return reqCtx, nil
}

// setState applies a mutation to the snapshot under the lock.
func (d *updateDownloader) setState(fn func(*DownloadState)) {
	d.mu.Lock()
	defer d.mu.Unlock()
	fn(&d.state)
}

// finish marks the download as no longer running (success, failure or
// cancel) and records the terminal phase.
func (d *updateDownloader) finish(phase, errMsg string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.running = false
	d.state.Phase = phase
	d.state.Error = errMsg
	if phase != DownloadDone {
		d.state.Speed = 0
		d.state.RemainingSeconds = -1
	}
}

// cancelCurrent aborts the in-flight download, if any.
func (d *updateDownloader) cancelCurrent() {
	d.mu.Lock()
	cancel := d.cancel
	d.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// isRunning reports whether a download is in flight.
func (d *updateDownloader) isRunning() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.running
}

// downloadProgressReporter accumulates the byte counters and derives the
// smoothed speed and the ETA.
//
// The smoothing is an exponential moving average over per-chunk rates rather
// than total/total-time: the total average includes the connection
// handshake and the server's first-byte latency, which on a GitHub release
// redirect chain is seconds — long enough to make the ETA read as
// "42 minutes" for a 90 MB file that actually arrives in 40.
type downloadProgressReporter struct {
	total      int64
	downloaded int64
	// ema is the smoothed bytes-per-second.
	ema float64
	// lastSample is when the last chunk was accounted.
	lastSample time.Time
	// started is when the first chunk arrived.
	started time.Time
}

// newDownloadProgressReporter returns a reporter for a transfer of total
// bytes (0 when unknown).
func newDownloadProgressReporter(total int64) *downloadProgressReporter {
	return &downloadProgressReporter{total: total}
}

// add accounts for n more bytes and returns the current smoothed speed.
func (r *downloadProgressReporter) add(n int64, now time.Time) float64 {
	r.downloaded += n
	if r.started.IsZero() {
		r.started = now
		r.lastSample = now
		return 0
	}
	dt := now.Sub(r.lastSample).Seconds()
	if dt <= 0 {
		return r.ema
	}
	inst := float64(n) / dt
	if r.ema == 0 {
		r.ema = inst
	} else {
		// alpha = 0.3: fast enough to follow a real speed change, slow
		// enough that one slow chunk does not collapse the readout.
		r.ema = 0.3*inst + 0.7*r.ema
	}
	r.lastSample = now
	return r.ema
}

// remaining returns the ETA in seconds, -1 when it cannot be estimated.
func (r *downloadProgressReporter) remaining(now time.Time) int64 {
	if r.total <= 0 || r.downloaded <= 0 || r.ema <= 0 {
		return -1
	}
	left := r.total - r.downloaded
	if left <= 0 {
		return 0
	}
	return int64(float64(left) / r.ema)
}

// updateDownloadDir returns the directory the downloaded bundles land in.
//
// It lives under the platform config dir rather than the system temp dir:
// the file must survive the app's restart (the user may close the app
// mid-download and come back to it), and it must not be swept by the OS
// while the user is deciding whether to install it.
//
// The result is resolved once, synchronously, when the download starts —
// the directory is then passed to the download goroutine by value. That
// keeps the lookup off the goroutine, where a test that swaps the
// directory would race with the swap.
func resolveDownloadDir() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("无法定位用户数据目录：%w", err)
	}
	downloadDir := filepath.Join(configDir, "repotory", "updates")
	if err := os.MkdirAll(downloadDir, 0750); err != nil {
		return "", fmt.Errorf("无法创建更新目录：%w", err)
	}
	return downloadDir, nil
}

// downloadDirForTest overrides the download directory in tests, so a test
// never writes into the real user data directory. Nil at runtime.
var downloadDirForTest func() (string, error)

// downloadDirectory resolves the directory the bundles land in.
func downloadDirectory() (string, error) {
	if downloadDirForTest != nil {
		return downloadDirForTest()
	}
	return resolveDownloadDir()
}

// downloadUpdate fetches url into the updates directory, reporting progress
// through the downloader and verifying the digest against expectedSHA256.
//
// expectedSHA256 empty means the release published no digest for this file;
// the download still completes, with ChecksumVerified false, and the UI says
// so rather than implying the bytes were checked.
//
// reqCtx is the cancellable context created by begin(): the user cancelling
// aborts the transfer through it.
//
// downloadDir is the destination and client the HTTP client, both resolved
// before the goroutine started.
//
// The file is written to a ".part" sibling first and renamed only after the
// digest matches, so a half-written file is never mistaken for a complete
// one (a killed app, a full disk, a cancel).
func (s *Service) downloadUpdate(ctx context.Context, d *updateDownloader, downloadDir string, client *http.Client, url, fileName, expectedSHA256 string) {
	// The file name comes from the release API, but it reaches a filesystem
	// path here — so it is reduced to its base name and any path separator is
	// stripped rather than trusted.
	safeName := filepath.Base(strings.ReplaceAll(fileName, "\\", "/"))
	if safeName == "." || safeName == ".." || safeName == string(filepath.Separator) {
		d.finish(DownloadFailed, "下载文件名无效")
		return
	}
	finalPath := filepath.Join(downloadDir, safeName)
	partPath := finalPath + ".part"

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		d.finish(DownloadFailed, fmt.Sprintf("下载请求无效：%v", err))
		return
	}
	req.Header.Set("User-Agent", updateCheckUserAgent)
	req.Header.Set("Accept", "application/octet-stream")

	// The check timeout is right for a metadata GET and wrong for a large
	// file transfer, so the download client gets no overall timeout — the
	// request context (cancellable by the user) is the bound.
	client.Timeout = 0

	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			d.finish(DownloadCanceled, "下载已取消")
			return
		}
		d.finish(DownloadFailed, fmt.Sprintf("下载失败：%v", err))
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		d.finish(DownloadFailed, fmt.Sprintf("下载失败：服务器返回 HTTP %d", resp.StatusCode))
		return
	}

	total := resp.ContentLength
	if total > 0 {
		d.setState(func(st *DownloadState) { st.Total = total })
	}

	f, err := os.OpenFile(partPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		d.finish(DownloadFailed, fmt.Sprintf("无法写入下载文件：%v", err))
		return
	}

	reporter := newDownloadProgressReporter(total)
	hasher := sha256.New()
	buf := make([]byte, 256*1024)

	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			if _, werr := f.Write(chunk); werr != nil {
				f.Close()
				os.Remove(partPath)
				d.finish(DownloadFailed, fmt.Sprintf("写入下载文件失败：%v", werr))
				return
			}
			hasher.Write(chunk)
			reporter.add(int64(n), time.Now())
			downloaded := reporter.downloaded
			speed := int64(reporter.ema)
			remaining := reporter.remaining(time.Now())
			d.setState(func(st *DownloadState) {
				st.Downloaded = downloaded
				st.Speed = speed
				st.RemainingSeconds = remaining
			})
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			f.Close()
			os.Remove(partPath)
			if ctx.Err() != nil {
				d.finish(DownloadCanceled, "下载已取消")
				return
			}
			d.finish(DownloadFailed, fmt.Sprintf("下载中断：%v", readErr))
			return
		}
	}

	if err := f.Close(); err != nil {
		os.Remove(partPath)
		d.finish(DownloadFailed, fmt.Sprintf("下载文件写入未完成：%v", err))
		return
	}

	// A Content-Length mismatch means the transfer was truncated (the
	// connection dropped mid-stream). The digest check would catch it too,
	// but saying so directly is clearer than "checksum mismatch".
	if total > 0 && reporter.downloaded != total {
		os.Remove(partPath)
		d.finish(DownloadFailed, fmt.Sprintf("下载不完整：收到 %d 字节，应为 %d 字节", reporter.downloaded, total))
		return
	}

	d.setState(func(st *DownloadState) { st.Phase = DownloadVerifying })

	got := hex.EncodeToString(hasher.Sum(nil))
	verified := false
	if expectedSHA256 != "" {
		if !strings.EqualFold(got, expectedSHA256) {
			os.Remove(partPath)
			d.finish(DownloadFailed, fmt.Sprintf("校验失败：文件摘要 %s 与发布方声明的 %s 不一致，已删除", got, expectedSHA256))
			return
		}
		verified = true
	}

	// Only now does the file get its real name.
	if err := os.Rename(partPath, finalPath); err != nil {
		os.Remove(partPath)
		d.finish(DownloadFailed, fmt.Sprintf("无法完成下载文件：%v", err))
		return
	}

	d.setState(func(st *DownloadState) {
		st.Phase = DownloadDone
		st.Path = finalPath
		st.Downloaded = reporter.downloaded
		st.ChecksumVerified = verified
		st.Speed = 0
		st.RemainingSeconds = 0
	})
	d.finish(DownloadDone, "")
}

// StartUpdateDownload begins downloading a release bundle.
//
// The URL and the expected digest come from the release check the user just
// did (the caller passes the asset's URL and digest straight out of
// UpdateInfo), so the download always targets the bundle the app itself
// picked for this platform. The URL must be https and must be one of the
// assets GitHub's own release API reported; a caller cannot point it at an
// arbitrary URL.
//
// The download runs in the background: the binding returns as soon as it has
// started, and the frontend polls UpdateDownloadState for progress. That is
// the same shape as the check itself (one HTTP call, one verdict) and avoids
// a second transport for progress events.
func (s *Service) StartUpdateDownload(url, fileName, sha256 string) error {
	if !strings.HasPrefix(url, "https://") {
		return fmt.Errorf("拒绝非 https 下载地址：%q", url)
	}
	proxy, _ := db.GetConfig(s.db, "update_proxy")
	if err := validateUpdateProxy(proxy); err != nil {
		return err
	}
	// The directory and the HTTP client are resolved here, not inside the
	// download goroutine: resolving them in the goroutine would race with a
	// test swapping either of them.
	downloadDir, err := downloadDirectory()
	if err != nil {
		return err
	}
	client, err := newUpdateHTTPClient(strings.TrimSpace(proxy))
	if err != nil {
		return err
	}
	reqCtx, err := s.updates.begin(s.bgContext(), "", fileName, 0)
	if err != nil {
		return err
	}
	go s.downloadUpdate(reqCtx, s.updates, downloadDir, client, url, fileName, normalizeDigest(sha256))
	return nil
}

// normalizeDigest strips the "sha256:" prefix the release API puts in front
// of the digest, and rejects a digest that is not a plain hex string.
func normalizeDigest(raw string) string {
	d := strings.TrimSpace(raw)
	d = strings.TrimPrefix(d, "sha256:")
	if d == "" {
		return ""
	}
	if len(d) != 64 {
		return ""
	}
	if _, err := hex.DecodeString(d); err != nil {
		return ""
	}
	return strings.ToLower(d)
}

// bgContext returns the service's background context, or a fresh one when
// the service was built without dependencies (tests).
func (s *Service) bgContext() context.Context {
	if s.bgCtx != nil {
		return s.bgCtx
	}
	return context.Background()
}

// UpdateDownloadState returns the progress snapshot of the current or last
// download.
func (s *Service) UpdateDownloadState() DownloadState {
	return s.updates.snapshot()
}

// CancelUpdateDownload aborts the in-flight download. It is a no-op when
// nothing is running.
func (s *Service) CancelUpdateDownload() error {
	if !s.updates.isRunning() {
		return nil
	}
	s.updates.cancelCurrent()
	return nil
}

// OpenDownloadedUpdate hands the downloaded bundle to the OS.
//
// macOS gets the .dmg opened (the user drags the app onto Applications);
// Windows gets the containing folder revealed (the bundle is a .zip, and
// there is no installer to run); Linux gets the folder revealed as well.
//
// It never replaces the running application — the user performs the install
// exactly as they would after a browser download.
func (s *Service) OpenDownloadedUpdate(path string) error {
	st := s.updates.snapshot()
	if st.Phase != DownloadDone {
		return fmt.Errorf("没有已完成的下载可打开")
	}
	if path != "" && path != st.Path {
		return fmt.Errorf("打开失败：路径与当前下载不一致")
	}
	return openDownloadedBundle(st.Path)
}

// openDownloadedBundle shows a downloaded bundle to the user in the way that
// platform expects.
func openDownloadedBundle(path string) error {
	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("找不到下载文件：%v", err)
	}
	switch runtime.GOOS {
	case "darwin":
		// "open" on a .dmg mounts it and shows its window; on any other file
		// it opens it with the default handler. Either way the user sees the
		// installer, and the app does not install anything itself.
		return runDetached("open", path)
	case "windows":
		// The bundle is a .zip with no installer, so revealing it in Explorer
		// is the honest action: the user extracts and replaces the app.
		return runDetached("explorer", "/select,"+path)
	default:
		// Linux ships a tar.gz; revealing the directory is the closest
		// equivalent that does not presume a package manager.
		return runDetached("xdg-open", filepath.Dir(path))
	}
}

// runDetached starts a helper process that outlives this one.
//
// The helper is deliberately not waited on: on Windows, Explorer would be
// blocked until the app exits if we waited. The error that matters is the
// "command not found" kind, which Start reports synchronously; anything
// after that is the helper's own business.
func runDetached(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("无法打开（%s）：%v", name, err)
	}
	// Releasing the process handle without waiting keeps it from becoming a
	// zombie on Unix.
	go func() { _ = cmd.Wait() }()
	return nil
}
