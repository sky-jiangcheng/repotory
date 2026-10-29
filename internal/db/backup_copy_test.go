package db

import (
	"database/sql"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// The off-disk exit (ADR-0025 L3): the daily snapshot is copied into a
// directory the user chose. These tests pin the three properties that make
// the copy trustworthy — it is a real database, it is idempotent per day, and
// it never touches anything in the destination directory that this product
// did not write.

func makeSnapshot(t *testing.T, dir string, day string) string {
	t.Helper()
	database := openSourceDB(t)
	now, err := time.Parse("2006-01-02", day)
	if err != nil {
		t.Fatal(err)
	}
	path, err := CreateBackup(database, dir, now, 14)
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	return path
}

func TestCopyBackupToProducesRestorableCopy(t *testing.T) {
	src := makeSnapshot(t, t.TempDir(), "2026-10-18")
	dstDir := t.TempDir()

	dst, err := CopyBackupTo(src, dstDir, 14)
	if err != nil {
		t.Fatalf("copy: %v", err)
	}
	if filepath.Base(dst) != filepath.Base(src) {
		t.Fatalf("copy name = %s, want the same daily filename as the source", filepath.Base(dst))
	}
	if filepath.Dir(dst) != dstDir {
		t.Fatalf("copy landed in %s, want %s", filepath.Dir(dst), dstDir)
	}
	// The copy must be a real database, not a byte-identical blob that SQLite
	// refuses to open.
	copied, err := sql.Open("sqlite", dst)
	if err != nil {
		t.Fatal(err)
	}
	defer copied.Close()
	var v string
	if err := copied.QueryRow("SELECT v FROM t WHERE id = 1").Scan(&v); err != nil || v != "hello" {
		t.Fatalf("restored row = %q (err=%v)", v, err)
	}
	info, err := os.Stat(dst)
	if err != nil {
		t.Fatal(err)
	}
	// POSIX-only assertion: Windows ignores the OpenFile mode argument, so
	// there are no permission bits to check there.
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("copy perms = %o, want 0600 (it carries the full dataset)", info.Mode().Perm())
	}
}

func TestCopyBackupToIsDailyIdempotent(t *testing.T) {
	src := makeSnapshot(t, t.TempDir(), "2026-10-18")
	dstDir := t.TempDir()

	first, err := CopyBackupTo(src, dstDir, 14)
	if err != nil {
		t.Fatalf("first copy: %v", err)
	}
	// Replace the copy with a broken file: the next attempt must rebuild it
	// rather than trust "the file exists" — that is the same lesson the local
	// snapshot learned (a VACUUM INTO killed mid-flight leaves a fragment
	// that every later tick of the day would accept as done).
	if err := os.WriteFile(first, []byte("truncated"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := CopyBackupTo(src, dstDir, 14); err != nil {
		t.Fatalf("second copy: %v", err)
	}
	if err := VerifySnapshot(first); err != nil {
		t.Fatalf("copy was not rebuilt: %v", err)
	}
	// A third attempt with an intact copy must leave it alone.
	before, err := os.Stat(first)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := CopyBackupTo(src, dstDir, 14); err != nil {
		t.Fatalf("third copy: %v", err)
	}
	after, err := os.Stat(first)
	if err != nil {
		t.Fatal(err)
	}
	if !after.ModTime().Equal(before.ModTime()) {
		t.Fatalf("an intact copy was rewritten (mtime %s → %s)", before.ModTime(), after.ModTime())
	}
}

func TestCopyBackupToRotatesOldestAndKeepsForeignFiles(t *testing.T) {
	src := makeSnapshot(t, t.TempDir(), "2026-10-18")
	dstDir := t.TempDir()

	// Older snapshots in the destination, as a previous run would have left.
	for _, d := range []string{"01", "02", "03", "04"} {
		if err := os.WriteFile(filepath.Join(dstDir, "repotory-2026-10-"+d+".db"), []byte("old"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// The destination is the USER's directory: files that merely look like
	// ours must survive.
	foreign := filepath.Join(dstDir, "repotory-notes.db")
	if err := os.WriteFile(foreign, []byte("mine"), 0o600); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(dstDir, "my-notes.txt")
	if err := os.WriteFile(other, []byte("keep me"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := CopyBackupTo(src, dstDir, 3); err != nil {
		t.Fatalf("copy: %v", err)
	}
	entries, err := os.ReadDir(dstDir)
	if err != nil {
		t.Fatal(err)
	}
	var snaps []string
	for _, e := range entries {
		if e.Name() == filepath.Base(foreign) || e.Name() == filepath.Base(other) {
			continue
		}
		snaps = append(snaps, e.Name())
	}
	if len(snaps) != 3 {
		t.Fatalf("snapshot count = %d, want 3 (retain): %v", len(snaps), snaps)
	}
	for _, s := range snaps {
		if s != "repotory-2026-10-18.db" && s != "repotory-2026-10-04.db" && s != "repotory-2026-10-03.db" {
			t.Fatalf("unexpected survivor: %s", s)
		}
	}
	for _, keep := range []string{foreign, other} {
		if _, err := os.Stat(keep); err != nil {
			t.Fatalf("user file %s must survive rotation: %v", filepath.Base(keep), err)
		}
	}
	// No leftover temp file: the copy is published by rename, so the
	// directory never keeps a half-written ".repotory-copy-*.tmp".
	for _, e := range entries {
		if len(e.Name()) > 0 && e.Name()[0] == '.' && filepath.Ext(e.Name()) == ".tmp" {
			t.Fatalf("temp file left behind: %s", e.Name())
		}
	}
}

func TestCopyBackupToRejectsMissingSource(t *testing.T) {
	_, err := CopyBackupTo(filepath.Join(t.TempDir(), "nope.db"), t.TempDir(), 14)
	if err == nil {
		t.Fatal("copying a missing source must fail")
	}
}

func TestCopyBackupToRejectsEmptyDestination(t *testing.T) {
	src := makeSnapshot(t, t.TempDir(), "2026-10-18")
	if _, err := CopyBackupTo(src, "", 14); err == nil {
		t.Fatal("an empty destination must fail")
	}
}
