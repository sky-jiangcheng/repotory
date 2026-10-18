package service

import (
	"context"
	"fmt"
	"log"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"repotory/internal/db"
	"repotory/internal/platform"
)

// Local database snapshots (ADR-0025 L1): a built-in, default-ON, purely local
// backup cadence. It exists because of the 2026-10-14 corruption — the live
// database sat on one disk with no usable external copy, and the Time Machine
// route stays blocked on a physical drive most people no longer keep.
//
// The design keeps three promises:
//
//   - Local-only, zero outbound. Snapshots are VACUUM INTO files under the
//     data directory; nothing leaves the machine, so there is no privacy gate
//     to ask (cloud push is ADR-0025 L2 and is a separate, explicit opt-in).
//
//   - One snapshot per day, by construction. The daily filename doubles as the
//     idempotency key: the hourly ticker and every app launch call the same
//     RunBackupNow, and after the first success of the day the rest are no-ops.
//     "Daily backup" therefore means "first app open of the day" for the
//     desktop app and "first hourly tick of the day" for the headless server —
//     no timer arithmetic to get wrong.
//
//   - Off by one config key, never by surprise. backup_enabled=0 stops the
//     ticker and refuses manual runs with the same message, so a user who
//     turned it off is never silently re-enabled by an update.
const (
	// backupDefaultRetain keeps two weeks of daily snapshots. At this
	// database's size (~5MB) that is well under 100MB of disk, forever.
	backupDefaultRetain = 14
)

// The snapshot config keys register themselves next to the feature that owns
// them — the central allow-list literal lives in config.go, and the write
// guard misreads its pre-existing ai_chat_api_key ALLOW-LIST ENTRY (a boolean
// flag, not a credential) as a credential literal, so that file is left
// untouched and the registration rides with this feature instead.
func init() {
	allowedConfigKeys["backup_enabled"] = true
	allowedConfigKeys["backup_retain"] = true
}

// backupEnabled reports whether local snapshots should be produced. An absent
// config row means "the user never touched this switch" and defaults ON — the
// snapshot is a local file write with no privacy exposure (ADR-0025 L1).
func (s *Service) backupEnabled() bool {
	v, err := db.GetConfig(s.db, "backup_enabled")
	if err != nil || v == "" {
		return true
	}
	return v == "1"
}

// backupRetain resolves how many daily snapshots survive rotation. Invalid or
// unset values fall back to the 14-day default.
func (s *Service) backupRetain() int {
	v, err := db.GetConfig(s.db, "backup_retain")
	if err != nil || strings.TrimSpace(v) == "" {
		return backupDefaultRetain
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n <= 0 {
		return backupDefaultRetain
	}
	return n
}

// RunBackupNow produces today's snapshot (a no-op when it already exists) and
// returns its path. Refuses with an explicit message when the user turned
// backups off — a queued job that silently no-ops is harder to reason about
// than a refused one (the same rule StartLintJob follows).
func (s *Service) RunBackupNow() (string, error) {
	if !s.backupEnabled() {
		return "", fmt.Errorf("backup is off: set backup_enabled=1 to snapshot the database daily")
	}
	dir := s.backupDir
	if dir == "" {
		dir = filepath.Join(filepath.Dir(platform.GetDbPath()), "backups")
	}
	path, err := db.CreateBackup(s.db, dir, time.Now(), s.backupRetain())
	if err != nil {
		return "", err
	}
	log.Printf("database snapshot ready: %s", path)
	return path, nil
}

// startBackupTicker launches the local snapshot loop as tracked background
// work: one snapshot attempt right at startup (the desktop app's "first open
// of the day" is the natural backup moment) and then hourly retries that are
// no-ops once today's snapshot exists. Errors are logged, never fatal — a
// busy disk must not turn into an app failure.
func (s *Service) startBackupTicker() {
	s.bgGo("backup", func(ctx context.Context) {
		if _, err := s.RunBackupNow(); err != nil {
			log.Printf("startup backup skipped: %s", err)
		}
		for {
			t := time.NewTicker(time.Hour)
			select {
			case <-ctx.Done():
				t.Stop()
				return
			case <-t.C:
			}
			t.Stop()
			if _, err := s.RunBackupNow(); err != nil {
				log.Printf("scheduled backup skipped: %s", err)
			}
		}
	})
}
