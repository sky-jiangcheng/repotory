package db

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// BackupSnapshotPrefix is the filename prefix of every snapshot CreateBackup
// writes. Rotation only ever deletes files carrying this prefix — a user's own
// files dropped into the same directory are never touched.
const BackupSnapshotPrefix = "repotory-"

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
		if verr := verifySnapshot(path); verr == nil {
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
	if verr := verifySnapshot(path); verr != nil {
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
func verifySnapshot(path string) error {
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

// rotateBackups deletes the oldest snapshots beyond retain. Names sort in
// chronological order by construction (ISO date inside the filename).
func rotateBackups(dir string, retain int) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	var snaps []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasPrefix(e.Name(), BackupSnapshotPrefix) && strings.HasSuffix(e.Name(), ".db") {
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
