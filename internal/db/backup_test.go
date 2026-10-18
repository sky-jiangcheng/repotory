package db

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func openSourceDB(t *testing.T) *sql.DB {
	t.Helper()
	path := filepath.Join(t.TempDir(), "source.db")
	database, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	if _, err := database.Exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('hello')"); err != nil {
		t.Fatal(err)
	}
	return database
}

func TestCreateBackupProducesValidSnapshot(t *testing.T) {
	database := openSourceDB(t)
	dir := t.TempDir()
	now := time.Date(2026, 10, 18, 9, 0, 0, 0, time.UTC)

	path, err := CreateBackup(database, dir, now, 14)
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	if filepath.Base(path) != "repotory-2026-10-18.db" {
		t.Fatalf("snapshot name = %s", path)
	}
	backup, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer backup.Close()
	var check string
	if err := backup.QueryRow("PRAGMA quick_check").Scan(&check); err != nil || check != "ok" {
		t.Fatalf("quick_check = %q (err=%v)", check, err)
	}
	var v string
	if err := backup.QueryRow("SELECT v FROM t WHERE id = 1").Scan(&v); err != nil || v != "hello" {
		t.Fatalf("restored row = %q (err=%v)", v, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("snapshot perms = %o, want 0600 (it carries the full dataset)", info.Mode().Perm())
	}
}

func TestCreateBackupDailyIdempotent(t *testing.T) {
	database := openSourceDB(t)
	dir := t.TempDir()
	day := time.Date(2026, 10, 18, 9, 0, 0, 0, time.UTC)

	first, err := CreateBackup(database, dir, day, 14)
	if err != nil {
		t.Fatalf("first backup: %v", err)
	}
	info1, _ := os.Stat(first)
	// 同一天稍后再调（每小时 ticker 的场景）：跳过而非重写。
	second, err := CreateBackup(database, dir, day.Add(3*time.Hour), 14)
	if err != nil {
		t.Fatalf("second backup: %v", err)
	}
	if first != second {
		t.Fatalf("same day should reuse the snapshot: %s vs %s", first, second)
	}
	info2, _ := os.Stat(second)
	if !info1.ModTime().Equal(info2.ModTime()) {
		t.Fatalf("second call rewrote the snapshot (mtime changed)")
	}
	// 次日：产出新的一份。
	next, err := CreateBackup(database, dir, day.Add(24*time.Hour), 14)
	if err != nil {
		t.Fatalf("next-day backup: %v", err)
	}
	if next == first {
		t.Fatalf("next day should produce a new snapshot, got %s", next)
	}
}

func TestCreateBackupRotatesOldest(t *testing.T) {
	database := openSourceDB(t)
	dir := t.TempDir()
	// 预置 5 份历史快照，retain=3 → 最老的 3 份应被清掉。
	for _, d := range []string{"01", "02", "03", "04", "05"} {
		if err := os.WriteFile(filepath.Join(dir, "repotory-2026-10-"+d+".db"), []byte("old"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// 非快照前缀的用户文件绝不能被轮转碰掉。
	foreign := filepath.Join(dir, "my-notes.txt")
	if err := os.WriteFile(foreign, []byte("keep me"), 0o600); err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 10, 18, 9, 0, 0, 0, time.UTC)
	if _, err := CreateBackup(database, dir, now, 3); err != nil {
		t.Fatalf("backup: %v", err)
	}
	entries, _ := os.ReadDir(dir)
	var snaps []string
	for _, e := range entries {
		if e.Name() == "my-notes.txt" {
			continue
		}
		snaps = append(snaps, e.Name())
	}
	if len(snaps) != 3 {
		t.Fatalf("snapshot count = %d, want 3: %v", len(snaps), snaps)
	}
	// 最新的三份是 18（今天）、05、04。
	want := map[string]bool{"repotory-2026-10-18.db": true, "repotory-2026-10-05.db": true, "repotory-2026-10-04.db": true}
	for _, s := range snaps {
		if !want[s] {
			t.Fatalf("unexpected survivor: %s (want %v)", s, want)
		}
	}
	if _, err := os.Stat(foreign); err != nil {
		t.Fatalf("foreign file must survive rotation: %v", err)
	}
}

func TestCreateBackupFailureCleansPartialFile(t *testing.T) {
	// 无效库连接（未建表也能 VACUUM INTO？——用已关闭的连接制造失败）。
	database := openSourceDB(t)
	dir := t.TempDir()
	database.Close()
	if _, err := CreateBackup(database, dir, time.Date(2026, 10, 18, 9, 0, 0, 0, time.UTC), 14); err == nil {
		t.Fatalf("expected an error from a closed connection")
	}
	if _, err := os.Stat(filepath.Join(dir, "repotory-2026-10-18.db")); !os.IsNotExist(err) {
		t.Fatalf("partial snapshot must be cleaned after failure, stat err=%v", err)
	}
}
