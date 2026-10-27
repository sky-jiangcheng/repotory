package service

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"repotory/internal/db"
	"repotory/internal/platform"
)

// ADR-0025 L3 — the off-disk exit: copy the daily snapshot into a directory
// the user chooses (an external SSD, a NAS mount, a synced folder).
//
// Why this layer has to exist. L1 keeps the snapshot next to the live
// database, on the same disk — and the 2026-10-14 accident happened for
// exactly that reason: the data lived on one disk, and one disk went bad.
// L2 (the S3 push) is the right answer for a server, but it demands an
// object store plus two credentials; somebody who plugged in an external
// drive should not have to stand one up to get a second copy.
//
// The same three promises as L1 and L2, for the same reasons:
//
//   - opt-in by default. `backup_copy_dir` is empty until the user fills it
//     in, and an empty value means zero copies — no directory is created, no
//     file is written, nothing is probed.
//   - the copy is verified before it is called a copy (db.CopyBackupTo).
//     A copy nobody can restore is worse than no copy: it silences the "I
//     have no second copy" signal, which is the one signal the accident
//     showed we need.
//   - the daily filename is the idempotency key, so the hourly ticker costs
//     nothing after the first success of the day.
//
// The one thing this layer adds on top of L1/L2 is a check the user cannot do
// by looking at a path: whether the directory they picked is actually on
// another disk. "A backup folder one folder away" looks exactly like "a
// backup folder on an external drive", and a backup on the same disk as the
// database is not a backup — it is a second copy of the thing that failed.

// The L3 config key registers itself next to the feature that owns it, same
// as the L1 keys in backup.go and the L2 keys in backup_remote.go: the central
// allow-list literal in config.go is left untouched (its write guard misreads
// credential-shaped literals there), and these keys ride with the feature.
//
// It registers in TWO tables on purpose. allowedConfigKeys says "the user may
// set this key"; stringConfigKeys says "this key carries free text, so do not
// demand a number". backup_copy_dir is a filesystem path — without the second
// entry, UpdateConfig rejects it with "config value must be a number" and the
// whole feature is unreachable from the settings page. (The same gap silently
// disabled the L2 remote form's five text fields; both are fixed in the same
// commit, because it is one mechanism, not two bugs.)
func init() {
	allowedConfigKeys["backup_copy_dir"] = true
	stringConfigKeys["backup_copy_dir"] = true
}

// offDiskCopyTimeout bounds how long the ticker waits for one copy before it
// gives up on THAT attempt and carries on.
//
// A stale network mount can block a file copy for a very long time, and the
// hourly backup ticker must not be wedged by that — the local snapshot has
// already succeeded by then, so nothing is at risk except the copy itself.
// The attempt is abandoned (not cancelled: a file write cannot be cancelled),
// and the next hourly tick tries again.
const offDiskCopyTimeout = 5 * time.Minute

// The machine-readable reasons a target can be reported with.
//
// The reason travels as a CODE, not as a sentence: the settings page renders
// it in the user's language, and a backend that returned a Chinese sentence
// would put Chinese into the English UI. The frontend maps each code to its
// own translation (see web/src/pages/settings/ActionsTab.tsx).
const (
	// BackupCopyOK — the target works. May still be SameDevice.
	BackupCopyOK = ""
	// BackupCopyNotConfigured — no off-disk target is set. Not an error: the
	// feature is simply off, which is its default state.
	BackupCopyNotConfigured = "not_configured"
	// BackupCopyRelativePath — a relative path would resolve against the
	// process working directory, not the place the user meant.
	BackupCopyRelativePath = "relative_path"
	// BackupCopyNotADirectory — the path exists but is a file.
	BackupCopyNotADirectory = "not_a_directory"
	// BackupCopyUnwritable — the directory exists and cannot be written to.
	BackupCopyUnwritable = "unwritable"
	// BackupCopyNoAncestor — no existing parent directory could be found.
	BackupCopyNoAncestor = "no_ancestor"
	// BackupCopyAncestorUnwritable — the nearest existing parent cannot be
	// written to, so the directory could never be created.
	BackupCopyAncestorUnwritable = "ancestor_unwritable"
	// BackupCopyStatFailed — the path could not be inspected at all.
	BackupCopyStatFailed = "stat_failed"
	// BackupCopySameDevice — the target is on the same disk as the live
	// database. ADVISORY, not an error: the copy still works, it just does not
	// protect against the disk failing.
	BackupCopySameDevice = "same_device"
)

// BackupCopyTargetReport is what the product can tell about a candidate
// off-disk backup directory.
//
// The fields exist so the UI can say something specific instead of a generic
// "invalid path": a directory that does not exist yet, a directory the user
// cannot write to, and a directory that turns out to sit on the same disk as
// the live database are three different problems with three different fixes.
type BackupCopyTargetReport struct {
	Path        string `json:"path"`
	Exists      bool   `json:"exists"`
	Writable    bool   `json:"writable"`
	SameDevice  bool   `json:"same_device"`
	DeviceKnown bool   `json:"device_known"`
	// Code is one of the BackupCopy* constants above: the machine-readable
	// reason this target is (not) usable. Empty means "usable".
	Code string `json:"code"`
	// Blocking marks the reasons where the copy CANNOT work (a relative path,
	// an unwritable directory). The same-disk advice is not blocking: the
	// copy succeeds, it just is not the disaster insurance it looks like.
	Blocking bool `json:"blocking"`
}

// backupCopyDir returns the configured off-disk copy directory. An empty
// string means the feature is off.
func (s *Service) backupCopyDir() string {
	v, err := db.GetConfig(s.db, "backup_copy_dir")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(v)
}

// liveDatabasePath returns the path of the live database file — the thing the
// off-disk copy is supposed to be independent of.
//
// Overridable by tests so they never touch the real user data directory.
func (s *Service) liveDatabasePath() string {
	if s.liveDbPath != "" {
		return s.liveDbPath
	}
	return platform.GetDbPath()
}

// deviceOfPathOrParent answers "which disk holds this path" for a path that
// may not exist yet: the directory the user is about to create lives on
// whatever disk its nearest existing ancestor lives on.
func deviceOfPathOrParent(path string) (uint64, bool) {
	if id, ok := platform.DeviceID(path); ok {
		return id, true
	}
	ancestor, ok := nearestExistingAncestor(path)
	if !ok {
		return 0, false
	}
	return platform.DeviceID(ancestor)
}

// nearestExistingAncestor returns the closest directory that already exists
// on the way up from path's parent, and whether one was found.
//
// The parent is the right place to start: the target directory itself may not
// exist yet, but CopyBackupTo creates it (MkdirAll, parents included) on the
// first copy. What decides whether that can work is the closest ancestor that
// exists — an intermediate directory that does not exist says nothing about
// whether the copy can be written.
//
// The macOS trap this handles: /Volumes/<disk> is created by the OS when a
// disk is mounted, and it is an ordinary directory on the root volume when
// the disk is NOT mounted. Pointing the copy at /Volumes/Backup/repotory
// with the disk unplugged therefore lands on the root disk — and the
// same-device check is what tells the user that.
func nearestExistingAncestor(path string) (string, bool) {
	dir := filepath.Dir(path)
	for {
		if info, err := os.Stat(dir); err == nil {
			if !info.IsDir() {
				return "", false
			}
			return dir, true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", false // reached the filesystem root without finding one
		}
		dir = parent
	}
}

// CheckBackupCopyTarget reports on a candidate off-disk backup directory.
//
// An empty path means "the currently configured one", so the settings page can
// show the state of the target it already knows about without keeping a
// second copy of the path.
//
// It never fails on a bad target: the report IS the answer. An error is
// reserved for "the service cannot even look" (e.g. an unreadable database
// row), which is a different kind of problem.
func (s *Service) CheckBackupCopyTarget(path string) (BackupCopyTargetReport, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		path = s.backupCopyDir()
	}
	report := BackupCopyTargetReport{Path: path}
	if path == "" {
		report.Code = BackupCopyNotConfigured
		return report, nil
	}

	if !filepath.IsAbs(path) {
		report.Code = BackupCopyRelativePath
		report.Blocking = true
		return report, nil
	}

	info, err := os.Stat(path)
	switch {
	case err == nil:
		if !info.IsDir() {
			report.Exists = true
			report.Code = BackupCopyNotADirectory
			report.Blocking = true
			return report, nil
		}
		report.Exists = true
		if !probeWritable(path) {
			report.Code = BackupCopyUnwritable
			report.Blocking = true
			return report, nil
		}
		report.Writable = true
	case os.IsNotExist(err):
		// The directory does not exist yet, and it will be created on the
		// first copy. The question that matters is whether the nearest
		// existing ancestor can be written to.
		ancestor, ok := nearestExistingAncestor(path)
		if !ok {
			report.Code = BackupCopyNoAncestor
			report.Blocking = true
			return report, nil
		}
		if !probeWritable(ancestor) {
			report.Code = BackupCopyAncestorUnwritable
			report.Blocking = true
			return report, nil
		}
		// Creatable — the copy will create the directory on first run.
		report.Writable = true
	default:
		report.Code = BackupCopyStatFailed
		report.Blocking = true
		return report, nil
	}

	// The one check the user cannot do by looking at the path. It is an
	// ADVICE, not a verdict: the copy still works, it just does not protect
	// against the disk failing — which is the whole reason this layer exists.
	liveID, liveKnown := deviceOfPathOrParent(s.liveDatabasePath())
	targetID, targetKnown := deviceOfPathOrParent(path)
	if liveKnown && targetKnown {
		report.DeviceKnown = true
		report.SameDevice = liveID == targetID
		if report.SameDevice {
			report.Code = BackupCopySameDevice
		}
	}
	return report, nil
}

// probeWritable reports whether a file can actually be created in dir.
//
// Existence and permissions on paper are not the question: a read-only
// mount, a full disk and an expired network share all look writable to
// os.Stat. The probe creates a file and removes it — the same trick
// platform.CheckStorageSafety uses.
//
// The name carries the pid and a nanosecond stamp so two concurrent probes
// cannot delete each other's file.
func probeWritable(dir string) bool {
	probe := filepath.Join(dir, fmt.Sprintf(".repotory-copy-probe-%d-%d", os.Getpid(), time.Now().UnixNano()))
	f, err := os.OpenFile(probe, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return false
	}
	_ = f.Close()
	_ = os.Remove(probe)
	return true
}

// copyBackupOffDisk copies today's snapshot to the configured off-disk
// directory, if one is configured.
//
// It runs in the background with a deadline, because the copy target is
// usually a mount the user controls and a stale one can block a file write
// indefinitely. The local snapshot has already succeeded when this is called,
// so the backup promise is kept either way; only the copy waits.
func (s *Service) copyBackupOffDisk(snapshotPath string) {
	dir := s.backupCopyDir()
	if dir == "" {
		return // opt-in: no directory configured means no copies at all
	}
	s.bgGo("backup-copy", func(ctx context.Context) {
		done := make(chan struct{})
		go func() {
			defer close(done)
			dst, err := db.CopyBackupTo(snapshotPath, dir, s.backupRetain())
			if err != nil {
				log.Printf("off-disk backup copy failed: %v", err)
				return
			}
			log.Printf("off-disk backup copy ready: %s", dst)
		}()
		select {
		case <-done:
		case <-time.After(offDiskCopyTimeout):
			log.Printf("off-disk backup copy timed out after %s — %s may be unreachable", offDiskCopyTimeout, dir)
		}
	})
}
