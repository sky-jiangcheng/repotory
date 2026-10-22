package opencode

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"repotory/internal/core/plugin"
	"repotory/internal/db"
	"repotory/internal/importers/memsrc"
)

// fakeXDGData points XDG_DATA_HOME at a temp dir so sessionRoot resolves there.
func fakeXDGData(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_DATA_HOME", dir)
	return dir
}

func writeSession(t *testing.T, root, hash, name, body string) {
	t.Helper()
	dir := filepath.Join(root, "opencode", "storage", "session", hash)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// sampleSession copies a session sample from testdata/ into the session root
// and returns its body. The samples live as files (ADR-0011 decision 5) so a
// drift in the on-disk format shows up as a diff on the sample, next to the
// test that broke.
func sampleSession(t *testing.T, root, hash, sample, name string) {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("testdata", sample))
	if err != nil {
		t.Fatalf("read sample %s: %v", sample, err)
	}
	writeSession(t, root, hash, name, string(body))
}

func TestImportProducesNote(t *testing.T) {
	root := fakeXDGData(t)
	sampleSession(t, root, "projhash", "session.json", "ses_abc.json")

	database, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	docs, err := New(database).Import()
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if len(docs) != 1 {
		t.Fatalf("expected 1 doc, got %d", len(docs))
	}
	d := docs[0]
	if d.Source != "opencode" || d.Kind != "log" {
		t.Errorf("source/kind = %q/%q", d.Source, d.Kind)
	}
	if !strings.Contains(d.Title, "Add caching layer") || !strings.Contains(d.Title, "mJ8UpQ") {
		t.Errorf("title = %q (want title + id suffix)", d.Title)
	}
	if !strings.Contains(d.Content, "/Users/u/Workspace/CodeStat") {
		t.Errorf("content missing directory: %q", d.Content)
	}
	if !strings.Contains(d.Content, "in-memory cache") {
		t.Errorf("content missing summary: %q", d.Content)
	}
	if d.ProjectID != 0 {
		t.Errorf("empty db should match no project, got %d", d.ProjectID)
	}
}

func TestImportToleratesObjectSummary(t *testing.T) {
	root := fakeXDGData(t)
	sampleSession(t, root, "h", "object-summary.json", "real.json")

	database, _ := sql.Open("sqlite", ":memory:")
	defer database.Close()

	docs, err := New(database).Import()
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if len(docs) != 1 {
		t.Fatalf("expected 1 doc, got %d", len(docs))
	}

	d := docs[0]
	if d.Source != "opencode" || d.Kind != "log" {
		t.Errorf("source/kind = %q/%q", d.Source, d.Kind)
	}
	if !strings.Contains(d.Title, "会话标题") || !strings.Contains(d.Title, "12345678") {
		t.Errorf("title = %q (want title + id suffix)", d.Title)
	}
	if !strings.Contains(d.Content, "/some/path") {
		t.Errorf("content missing directory: %q", d.Content)
	}
	if strings.Contains(d.Content, "summary") {
		t.Errorf("content should not contain summary, got: %q", d.Content)
	}
	if d.ProjectID != 0 {
		t.Errorf("empty db should match no project, got %d", d.ProjectID)
	}
	if d.Tags != "opencode" || d.Source != "opencode" || d.Kind != "log" {
		t.Errorf("source/kind/tags = %q/%q/%q", d.Source, d.Kind, d.Tags)
	}
}
func TestImportIgnoresGarbageAndEmpty(t *testing.T) {
	root := fakeXDGData(t)
	sampleSession(t, root, "h", "session.json", "good.json")
	sampleSession(t, root, "h", "notjson.json", "notjson.json")
	sampleSession(t, root, "h", "empty.json", "empty.json")

	database, _ := sql.Open("sqlite", ":memory:")
	defer database.Close()
	docs, err := New(database).Import()
	if err != nil {
		t.Fatal(err)
	}
	if len(docs) != 1 {
		t.Fatalf("expected only the good session, got %d", len(docs))
	}
}

func TestImportMissingDirIsNoop(t *testing.T) {
	fakeXDGData(t)
	database, _ := sql.Open("sqlite", ":memory:")
	defer database.Close()
	docs, err := New(database).Import()
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if len(docs) != 0 {
		t.Fatalf("expected no docs, got %d", len(docs))
	}
}

func TestNoteTitleStable(t *testing.T) {
	a := noteTitle("Add caching layer", "ses_3dd894b12ffeUXjGy50UmJ8UpQ")
	b := noteTitle("Add caching layer", "ses_3dd894b12ffeUXjGy50UmJ8UpQ")
	if a != b {
		t.Fatalf("noteTitle not deterministic: %q vs %q", a, b)
	}
	if !strings.HasSuffix(a, "mJ8UpQ") {
		t.Errorf("title should end with id tail, got %q", a)
	}
}

func TestMatchProjectFromDirectory(t *testing.T) {
	projects := []db.Project{{ID: 9, Name: "CodeStat"}}
	if got := memsrc.MatchProject(memsrc.LastPathSegment("/Users/u/Workspace/CodeStat"), projects, nil); got != 9 {
		t.Fatalf("match = %d, want 9", got)
	}
}

func TestImporterImplementsInterface(t *testing.T) {
	var _ plugin.KnowledgeImporter = New((*sql.DB)(nil))
}
