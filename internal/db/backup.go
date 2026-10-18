package db

import (
	"database/sql"
	"fmt"
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
func CreateBackup(database *sql.DB, dir string, now time.Time, retain int) (string, error) {
	if dir == "" {
		return "", fmt.Errorf("a backup directory is required")
	}
	if retain < 1 {
		retain = 1
	}
	path := filepath.Join(dir, fmt.Sprintf("%s%s.db", BackupSnapshotPrefix, now.Format("2006-01-02")))
	if _, err := os.Stat(path); err == nil {
		return path, nil // today's snapshot already exists: daily idempotency
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
	if err := rotateBackups(dir, retain); err != nil {
		// Rotation is housekeeping — a failed prune must not fail the backup
		// that already succeeded on disk.
		return path, nil
	}
	return path, nil
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
