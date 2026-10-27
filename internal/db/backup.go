package db

import (
	"database/sql"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// BackupSnapshotPrefix is the filename prefix of every snapshot CreateBackup
// writes. Rotation only ever deletes files carrying this prefix — a user's own
// files dropped into the same directory are never touched.
const BackupSnapshotPrefix = "repotory-"

// snapshotName matches the exact shape of a snapshot file: the prefix, an ISO
// date, and the .db suffix.
//
// The prefix alone is too loose for a directory the USER chooses (the
// off-disk copy target): a file a user happens to name "repotory-notes.db"
// would be deleted by rotation, in a directory they may be using for other
// things. Matching the whole name makes the blast radius exactly "the files
// this product wrote".
var snapshotName = regexp.MustCompile(`^` + BackupSnapshotPrefix + `\d{4}-\d{2}-\d{2}\.db$`)

// CreateBackup produces one consistent snapshot of the live database with
// VACUUM INTO (ADR-0025 L1) and rotates old snapshots.
//
// The snapshot is taken on the LIVE connection, so WAL content is included and
// mid-write state is consistent — the same guarantee the pre-reimport /
// post-reimport manual restore points relied on. Cadence is "one snapshot per
// day": the daily filename doubles as the idempotency key, so an hourly ticker
// calling this is a no-op after the first success of the day.
//
// dir is created if missing (0700 — snapshots carry the full dataset). retain
// bounds how many snapshots survive; rotation only removes files matching
// BackupSnapshotPrefix. Returns the snapshot path.
//
// "The file for today already exists" is NOT treated as success on its own.
// A VACUUM INTO killed by SIGKILL leaves a half-written file behind, and the
// old code returned that path as today's backup — after which every later
// tick of the day saw the same file and skipped, so a broken snapshot was
// reported as a healthy one for the rest of the day. The file is now verified
// (see verifySnapshot) before it is accepted, and rebuilt when it is not.
func CreateBackup(database *sql.DB, dir string, now time.Time, retain int) (string, error) {
	if dir == "" {
		return "", fmt.Errorf("a backup directory is required")
	}
	if retain < 1 {
		retain = 1
	}
	path := filepath.Join(dir, fmt.Sprintf("%s%s.db", BackupSnapshotPrefix, now.Format("2006-01-02")))
	if _, err := os.Stat(path); err == nil {
		if verr := VerifySnapshot(path); verr == nil {
			return path, nil // today's snapshot exists and is readable: daily idempotency
		} else {
			// Unreadable or half-written (most often a VACUUM INTO that was
			// killed mid-flight). Remove it and rebuild, so the day gets a real
			// snapshot instead of a corrupt one that every later tick would
			// accept as done.
			log.Printf("backup: today's snapshot %s is not a readable database (%v) — rebuilding", path, verr)
			if rerr := os.Remove(path); rerr != nil {
				return "", fmt.Errorf("remove invalid snapshot %s: %w", path, rerr)
			}
		}
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("create backup dir: %w", err)
	}
	// VACUUM INTO takes a SQL string literal; single quotes must be doubled.
	// On failure the half-written target is removed — a partial snapshot is
	// worse than no snapshot.
	q := strings.ReplaceAll(path, "'", "''")
	if _, err := database.Exec("VACUUM INTO '" + q + "'"); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("vacuum into %s: %w", path, err)
	}
	// VACUUM INTO 用进程 umask 落盘（常见 0644）；快照携带全量数据集，与数据
	// 目录同一纪律收紧到 0600。
	if err := os.Chmod(path, 0o600); err != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("chmod snapshot: %w", err)
	}
	// The write succeeded, but "succeeded" is not "the file on disk is a
	// database": a disk that fills up mid-write, or a filesystem that
	// reordered the flush, can leave a file SQLite would refuse to read.
	// Verify before the snapshot is ever reported as a backup, and drop it
	// if it is not — a backup that exists but cannot be restored is worse
	// than a missing one, because it silences the "I have no backup" signal.
	if verr := VerifySnapshot(path); verr != nil {
		_ = os.Remove(path)
		return "", fmt.Errorf("verify snapshot %s: %w", path, verr)
	}
	if err := rotateBackups(dir, retain); err != nil {
		// Rotation is housekeeping — a failed prune must not fail the backup
		// that already succeeded on disk.
		return path, nil
	}
	return path, nil
}

// verifySnapshot opens a snapshot read-only and asks SQLite whether it can
// read the file at all.
//
// mode=ro is enforced by SQLite, not by convention: the check never writes, so
// it creates no -wal/-shm sidecars next to the snapshot and cannot modify the
// thing it is inspecting.
//
// The query is a cheap schema count, not PRAGMA integrity_check on purpose.
// integrity_check walks every page of the file (seconds on a 10MB snapshot)
// and answers a broader question than the one here. What matters for the
// daily-idempotency decision is narrower: "is this a readable database, or a
// fragment VACUUM INTO left behind when it was killed?" — a fragment fails to
// open or to read sqlite_master, which is exactly what this detects.
//
// Exported because the off-disk copy (CopyBackupTo) is verified by exactly the
// same question: a copy nobody can restore is worse than no copy, because it
// silences the "I have no second copy" signal.
func VerifySnapshot(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve %s: %w", path, err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return err
	}
	if info.Size() == 0 {
		return fmt.Errorf("snapshot file is empty")
	}
	conn, err := sql.Open("sqlite", "file:"+filepath.ToSlash(abs)+"?mode=ro")
	if err != nil {
		return err
	}
	defer conn.Close()
	var objects int
	if err := conn.QueryRow("SELECT count(*) FROM sqlite_master").Scan(&objects); err != nil {
		return err
	}
	if objects == 0 {
		return fmt.Errorf("snapshot contains no schema objects")
	}
	return nil
}

// CopyBackupTo copies an existing snapshot into another directory — the
// off-disk exit (ADR-0025 L3).
//
// Why it exists: L1 keeps the daily snapshot next to the live database, on the
// same disk. The 2026-10-14 accident happened for exactly that reason — the
// data lived on one disk and that disk went bad. L2 (the S3 push) needs an
// object store plus two credentials, which is the right answer for a server
// and the wrong answer for somebody who just plugged in an external SSD or
// mounted a NAS folder.
//
// Three properties, each of them learned the hard way elsewhere in this file:
//
//   - The daily filename is the idempotency key here too. A copy that already
//     exists AND verifies is left alone, so the hourly ticker costs nothing
//     after the first success of the day.
//   - The copy is written to a temporary file in the destination directory and
//     renamed into place. A crash mid-copy must not leave a half-written file
//     under the final name — the next run would find it, see it is broken,
//     and rebuild it, but a user glancing at the directory would see a file
//     that looks like a backup.
//   - The result is verified by exactly the same question as the original
//     (VerifySnapshot). A copy that cannot be restored is worse than no copy:
//     it silences the "I have no second copy" signal, which is the one signal
//     the 2026-10-14 accident showed we need.
//
// The destination directory is the USER's, so rotation there only ever touches
// files whose whole name matches a snapshot this product wrote.
func CopyBackupTo(srcPath, dstDir string, retain int) (string, error) {
	if srcPath == "" {
		return "", fmt.Errorf("a source snapshot path is required")
	}
	if dstDir == "" {
		return "", fmt.Errorf("a destination directory is required")
	}
	if retain < 1 {
		retain = 1
	}
	if _, err := os.Stat(srcPath); err != nil {
		return "", fmt.Errorf("source snapshot %s: %w", srcPath, err)
	}
	dst := filepath.Join(dstDir, filepath.Base(srcPath))

	// Same daily-idempotency rule as the local snapshot: an existing, readable
	// copy means today's copy is done.
	if _, err := os.Stat(dst); err == nil {
		if verr := VerifySnapshot(dst); verr == nil {
			// Housekeeping only — a failed prune must not fail the copy that
			// is already in place.
			_ = rotateBackups(dstDir, retain)
			return dst, nil
		}
		// Unreadable copy (an interrupted write from an earlier run, a full
		// disk, a file the user replaced): replace it rather than keep it.
		log.Printf("backup: off-disk copy %s is not a readable database — replacing", dst)
		if rerr := os.Remove(dst); rerr != nil {
			return "", fmt.Errorf("remove invalid off-disk copy %s: %w", dst, rerr)
		}
	}
	if err := os.MkdirAll(dstDir, 0o700); err != nil {
		return "", fmt.Errorf("create off-disk copy dir: %w", err)
	}

	// Temp file in the DESTINATION directory: the rename that publishes it is
	// then within one filesystem, and therefore atomic.
	tmp, err := os.CreateTemp(dstDir, ".repotory-copy-*.tmp")
	if err != nil {
		return "", fmt.Errorf("create temp file in %s: %w", dstDir, err)
	}
	tmpPath := tmp.Name()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
	}

	src, err := os.Open(srcPath)
	if err != nil {
		cleanup()
		return "", fmt.Errorf("open source snapshot %s: %w", srcPath, err)
	}
	if _, err := io.Copy(tmp, src); err != nil {
		_ = src.Close()
		cleanup()
		return "", fmt.Errorf("copy snapshot to %s: %w", tmpPath, err)
	}
	if err := src.Close(); err != nil {
		cleanup()
		return "", fmt.Errorf("close source snapshot: %w", err)
	}
	// Flush before the rename: the bytes must be on the disk before the file
	// is published under its final name.
	if err := tmp.Sync(); err != nil {
		cleanup()
		return "", fmt.Errorf("sync off-disk copy: %w", err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return "", fmt.Errorf("close off-disk copy: %w", err)
	}
	// The copy carries the whole dataset: same discipline as the local
	// snapshot (0600), and the temp file's 0600 default is not enough to rely
	// on — CreateTemp uses 0600, but the mode is set explicitly anyway so the
	// intent is visible here.
	if err := os.Chmod(tmpPath, 0o600); err != nil {
		_ = os.Remove(tmpPath)
		return "", fmt.Errorf("chmod off-disk copy: %w", err)
	}
	// Verify BEFORE publishing: a copy that cannot be read is never given the
	// name the user would trust.
	if verr := VerifySnapshot(tmpPath); verr != nil {
		_ = os.Remove(tmpPath)
		return "", fmt.Errorf("verify off-disk copy: %w", verr)
	}
	if err := os.Rename(tmpPath, dst); err != nil {
		_ = os.Remove(tmpPath)
		return "", fmt.Errorf("publish off-disk copy %s: %w", dst, err)
	}
	_ = rotateBackups(dstDir, retain)
	return dst, nil
}

// rotateBackups deletes the oldest snapshots beyond retain. Names sort in
// chronological order by construction (ISO date inside the filename).
//
// Only files whose WHOLE name matches the snapshot shape are considered. The
// destination directory is often the user's own (an external disk, a NAS
// folder), so "starts with repotory-" is not enough to justify deleting
// somebody's file.
func rotateBackups(dir string, retain int) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	var snaps []string
	for _, e := range entries {
		if !e.IsDir() && snapshotName.MatchString(e.Name()) {
			snaps = append(snaps, e.Name())
		}
	}
	if len(snaps) <= retain {
		return nil
	}
	sort.Sort(sort.Reverse(sort.StringSlice(snaps))) // newest first
	for _, old := range snaps[retain:] {
		if err := os.Remove(filepath.Join(dir, old)); err != nil {
			return err
		}
	}
	return nil
}
