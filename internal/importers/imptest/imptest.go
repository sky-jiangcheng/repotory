// Package imptest holds the test-only helpers shared by the built-in memory
// importers' golden-file tests.
//
// It exists because ADR-0011 decision 5 asks each source to pin its parse
// result against sample files, and every one of those tests needs the same
// thing: take a sample out of testdata/ and put it where the importer will
// find it. Duplicating that helper in eight packages would be eight copies to
// drift; this package is the one copy.
//
// Nothing here is production code — no importer imports it, so it never
// reaches the binary. It lives under internal/importers/ because that is
// where its only callers are.
package imptest

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

// CopySample copies a sample from testdata/ into dest. The sample may be a
// single file or a whole directory tree.
//
// The samples live as files rather than inline strings (ADR-0011 decision 5):
// when a source format drifts, the diff then shows the sample that drifted
// next to the test that broke — an inline fixture only shows a string that
// changed, with no indication of what the real format looks like.
func CopySample(t *testing.T, src, dest string) {
	t.Helper()
	info, err := os.Stat(src)
	if err != nil {
		t.Fatalf("stat sample %s: %v", src, err)
	}
	if !info.IsDir() {
		body, err := os.ReadFile(src)
		if err != nil {
			t.Fatalf("read sample %s: %v", src, err)
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(dest, body, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	err = filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dest, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, body, 0o644)
	})
	if err != nil {
		t.Fatalf("copy sample %s: %v", src, err)
	}
}

// ExecScript runs a .sql sample against an open database.
//
// It exists for the two sources whose sample is a SQLite database (Hermes
// state.db, Cursor state.vscdb). Committing a binary .db file would make the
// diff unreadable — the schema and the rows are exactly what has to be
// reviewable, and a binary blob shows nothing when the format drifts. A .sql
// dump is the same data, diffable line by line, and it can be applied to a
// throwaway database in one Exec.
//
// The sample may hold several statements separated by semicolons; the sqlite
// driver executes them in order.
func ExecScript(t *testing.T, db *sql.DB, sample string) {
	t.Helper()
	body, err := os.ReadFile(sample)
	if err != nil {
		t.Fatalf("read sql sample %s: %v", sample, err)
	}
	if _, err := db.Exec(string(body)); err != nil {
		t.Fatalf("exec sql sample %s: %v", sample, err)
	}
}
