package service

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"repotory/internal/db"
)

// noModeBits is the guard for the two "unwritable" tests below: they stage
// unwritability with chmod 0500, which Windows does not honour (there is no
// mode-bit permission model — a directory's read-only attribute does not stop
// file creation), so the condition cannot be staged there at all.
func noModeBits(t *testing.T) {
	t.Helper()
	if os.Getuid() == 0 {
		t.Skip("root ignores directory permissions")
	}
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no mode-bit permissions — chmod 0500 does not make a directory unwritable")
	}
}

// The off-disk exit (ADR-0025 L3). The point of these tests is the promise
// the feature makes: a second copy, on another disk, that nobody has to set
// up an object store for — and nothing at all when the user did not ask for
// it.

func newCopyTestService(t *testing.T) *Service {
	t.Helper()
	s := newBackupTestService(t)
	// The live database path is what the "is it really another disk?" check
	// compares against. Point it at the test's own file so the check never
	// touches the real user data directory.
	s.liveDbPath = filepath.Join(t.TempDir(), "live.db")
	return s
}

// waitForSnapshot polls dir until a snapshot file shows up in it and returns
// its path.
//
// The copy runs in the background (a stale network mount must not wedge the
// backup ticker), so the test has to wait for it the way a user would — by
// looking at the directory.
func waitForSnapshot(t *testing.T, dir string) string {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		entries, err := os.ReadDir(dir)
		if err == nil {
			for _, e := range entries {
				if !e.IsDir() && strings.HasPrefix(e.Name(), "repotory-") && strings.HasSuffix(e.Name(), ".db") {
					return filepath.Join(dir, e.Name())
				}
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for a snapshot copy in %s", dir)
	return ""
}

func TestOffDiskCopyHappensWhenConfigured(t *testing.T) {
	s := newCopyTestService(t)
	target := t.TempDir()
	if err := db.SetConfig(s.db, "backup_copy_dir", target); err != nil {
		t.Fatal(err)
	}

	if _, err := s.RunBackupNow(); err != nil {
		t.Fatalf("backup: %v", err)
	}

	copied := waitForSnapshot(t, target)
	// The copy must be a real database, not a byte-identical blob that SQLite
	// refuses to open: "a copy nobody can restore is worse than no copy".
	if err := db.VerifySnapshot(copied); err != nil {
		t.Fatalf("the copy is not a readable database: %v", err)
	}
	entries, err := os.ReadDir(target)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("target holds %d files, want 1 snapshot copy", len(entries))
	}
}

func TestNoOffDiskCopyByDefault(t *testing.T) {
	s := newCopyTestService(t)
	// No backup_copy_dir configured: the feature is off, and nothing outside
	// the local snapshot directory may be created.
	if _, err := s.RunBackupNow(); err != nil {
		t.Fatalf("backup: %v", err)
	}
	entries, err := os.ReadDir(s.backupDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("the snapshot dir holds %d files, want just today's snapshot", len(entries))
	}
}

// The path is free text, so the config write guard must accept it. It did
// not: backup_copy_dir was missing from the string-key table, so every save
// failed with "config value must be a number" and the feature was
// unreachable from the settings page.
func TestBackupCopyDirIsUserSettable(t *testing.T) {
	s := newCopyTestService(t)
	if err := s.UpdateConfig("backup_copy_dir", "/tmp/repotory-offdisk"); err != nil {
		t.Fatalf("backup_copy_dir not settable: %v", err)
	}
	if got := s.backupCopyDir(); got != "/tmp/repotory-offdisk" {
		t.Fatalf("stored dir = %q", got)
	}
}

// Clearing the path turns the feature off again — the promise is "empty means
// no copies", and that has to be reachable through the same write path.
func TestBackupCopyDirCanBeCleared(t *testing.T) {
	s := newCopyTestService(t)
	if err := s.UpdateConfig("backup_copy_dir", "/tmp/repotory-offdisk"); err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateConfig("backup_copy_dir", ""); err != nil {
		t.Fatalf("clearing backup_copy_dir: %v", err)
	}
	if got := s.backupCopyDir(); got != "" {
		t.Fatalf("stored dir = %q, want empty", got)
	}
}

func TestCheckBackupCopyTargetFlagsSameDiskAsAdvice(t *testing.T) {
	s := newCopyTestService(t)
	// The target is a sibling of the live database: same device by
	// construction, which is exactly the case the user cannot see by
	// looking at the path.
	liveDir := filepath.Dir(s.liveDbPath)
	target := filepath.Join(liveDir, "backups-offdisk")
	if err := os.MkdirAll(target, 0o700); err != nil {
		t.Fatal(err)
	}

	report, err := s.CheckBackupCopyTarget(target)
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if !report.Exists {
		t.Fatalf("report says the target does not exist: %+v", report)
	}
	if !report.Writable {
		t.Fatalf("report says the target is not writable: %+v", report)
	}
	if !report.DeviceKnown {
		t.Skip("platform cannot determine the device id (Windows); nothing to assert")
	}
	if !report.SameDevice {
		t.Fatalf("report must flag a target on the same disk: %+v", report)
	}
	if report.Code != BackupCopySameDevice {
		t.Fatalf("code = %q, want %q", report.Code, BackupCopySameDevice)
	}
	// The advice is NOT a verdict: the copy works, it just is not the
	// disaster insurance it looks like. Blocking it would be a lie about
	// what the feature can do.
	if report.Blocking {
		t.Fatalf("a same-disk target must not be blocking: %+v", report)
	}
}

func TestCheckBackupCopyTargetRejectsRelativePath(t *testing.T) {
	s := newCopyTestService(t)
	report, err := s.CheckBackupCopyTarget("backups/offdisk")
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if report.Code != BackupCopyRelativePath {
		t.Fatalf("code = %q, want %q", report.Code, BackupCopyRelativePath)
	}
	if !report.Blocking {
		t.Fatal("a relative path cannot work as intended and must be blocking")
	}
}

func TestCheckBackupCopyTargetReportsUnconfigured(t *testing.T) {
	s := newCopyTestService(t)
	report, err := s.CheckBackupCopyTarget("")
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if report.Path != "" {
		t.Fatalf("path = %q, want empty", report.Path)
	}
	if report.Code != BackupCopyNotConfigured {
		t.Fatalf("code = %q, want %q", report.Code, BackupCopyNotConfigured)
	}
	// "Not configured" is the feature's default state, not a failure.
	if report.Blocking {
		t.Fatal("an unconfigured target must not be blocking")
	}
}

// A directory that does not exist yet is fine — it is created on the first
// copy — so the check must not turn it into a problem. The same-disk advice
// may still apply (in the test environment every temp dir is on one volume),
// which is exactly why the two verdicts are separate fields.
func TestCheckBackupCopyTargetReportsMissingDirectory(t *testing.T) {
	s := newCopyTestService(t)
	target := filepath.Join(t.TempDir(), "not-created-yet")
	report, err := s.CheckBackupCopyTarget(target)
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if report.Exists {
		t.Fatalf("report says the target exists: %+v", report)
	}
	if !report.Writable {
		t.Fatalf("a creatable target must be reported as writable: %+v", report)
	}
	if report.Blocking {
		t.Fatalf("a creatable target must not be blocking: %+v", report)
	}
}

func TestCheckBackupCopyTargetReportsUnwritableDirectory(t *testing.T) {
	noModeBits(t)
	s := newCopyTestService(t)
	target := t.TempDir()
	if err := os.Chmod(target, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(target, 0o700) })

	report, err := s.CheckBackupCopyTarget(target)
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if report.Writable {
		t.Fatalf("report says an unwritable directory is writable: %+v", report)
	}
	if report.Code != BackupCopyUnwritable {
		t.Fatalf("code = %q, want %q", report.Code, BackupCopyUnwritable)
	}
	if !report.Blocking {
		t.Fatal("an unwritable target must be blocking")
	}
}

// A path that does not exist is only a problem when the directory could
// never be created — which is decided by the nearest EXISTING ancestor, not
// by the immediate parent (CopyBackupTo creates missing parents itself).
func TestCheckBackupCopyTargetReportsUnwritableAncestor(t *testing.T) {
	noModeBits(t)
	s := newCopyTestService(t)
	parent := t.TempDir()
	if err := os.Chmod(parent, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(parent, 0o700) })

	report, err := s.CheckBackupCopyTarget(filepath.Join(parent, "not-created-yet"))
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if report.Writable {
		t.Fatalf("report says an uncreatable target is writable: %+v", report)
	}
	if report.Code != BackupCopyAncestorUnwritable {
		t.Fatalf("code = %q, want %q", report.Code, BackupCopyAncestorUnwritable)
	}
	if !report.Blocking {
		t.Fatal("an uncreatable target must be blocking")
	}
}

func TestCheckBackupCopyTargetReportsNotADirectory(t *testing.T) {
	s := newCopyTestService(t)
	target := filepath.Join(t.TempDir(), "a-file")
	if err := os.WriteFile(target, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	report, err := s.CheckBackupCopyTarget(target)
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if report.Code != BackupCopyNotADirectory {
		t.Fatalf("code = %q, want %q", report.Code, BackupCopyNotADirectory)
	}
	if !report.Blocking {
		t.Fatal("a file path must be blocking")
	}
}
