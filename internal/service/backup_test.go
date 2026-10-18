package service

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"repotory/internal/db"
)

func newBackupTestService(t *testing.T) *Service {
	t.Helper()
	database, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "svc.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	// RunBackupNow/backupRetain 读 app_config；给测试库装上最小表。
	if _, err := database.Exec("CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT)"); err != nil {
		t.Fatal(err)
	}
	s := New(database, "")
	s.backupDir = t.TempDir() // 绝不写进真实用户数据目录
	return s
}

func TestRunBackupNowCreatesDailySnapshot(t *testing.T) {
	s := newBackupTestService(t)
	path, err := s.RunBackupNow()
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	today := time.Now().Format("2006-01-02")
	if !strings.Contains(filepath.Base(path), today) {
		t.Fatalf("snapshot name = %s, want today %s", path, today)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("snapshot missing: %v", err)
	}
	// 立即再跑（ticker 语义）：幂等返回同一路径。
	again, err := s.RunBackupNow()
	if err != nil || again != path {
		t.Fatalf("second run = %q (err=%v), want same %q", again, err, path)
	}
}

func TestRunBackupNowRespectsDisabledGate(t *testing.T) {
	s := newBackupTestService(t)
	if err := db.SetConfig(s.db, "backup_enabled", "0"); err != nil {
		t.Fatal(err)
	}
	path, err := s.RunBackupNow()
	if err == nil || !strings.Contains(err.Error(), "backup is off") {
		t.Fatalf("err = %v, want the explicit refusal", err)
	}
	if path != "" {
		t.Fatalf("path = %q, want empty", path)
	}
	entries, _ := os.ReadDir(s.backupDir)
	if len(entries) != 0 {
		t.Fatalf("disabled backup must not write files, got %d", len(entries))
	}
}

func TestBackupRetainFromConfig(t *testing.T) {
	s := newBackupTestService(t)
	if got := s.backupRetain(); got != backupDefaultRetain {
		t.Fatalf("default retain = %d, want %d", got, backupDefaultRetain)
	}
	if err := db.SetConfig(s.db, "backup_retain", "7"); err != nil {
		t.Fatal(err)
	}
	if got := s.backupRetain(); got != 7 {
		t.Fatalf("configured retain = %d, want 7", got)
	}
	if err := db.SetConfig(s.db, "backup_retain", "not-a-number"); err != nil {
		t.Fatal(err)
	}
	if got := s.backupRetain(); got != backupDefaultRetain {
		t.Fatalf("invalid retain should fall back to default, got %d", got)
	}
}

func TestBackupKeysAreUserSettable(t *testing.T) {
	s := newBackupTestService(t)
	// allowedConfigKeys 里注册了这两个键（backup.go init()），UpdateConfig 才放行。
	if err := s.UpdateConfig("backup_enabled", "1"); err != nil {
		t.Fatalf("backup_enabled not settable: %v", err)
	}
	if err := s.UpdateConfig("backup_retain", "7"); err != nil {
		t.Fatalf("backup_retain not settable: %v", err)
	}
}
