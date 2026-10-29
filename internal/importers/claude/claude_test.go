package claude

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"repotory/internal/core/plugin"
	"repotory/internal/db"
	"repotory/internal/importers/imptest"
)

// fakeHome redirects os.UserHomeDir at a throwaway dir.
func fakeHome(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	imptest.SetHome(t, dir)
	return dir
}

func TestStripFrontmatter(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"no frontmatter here", "no frontmatter here"},
		{"---\ntitle: x\n---\nBody text", "Body text"},
		{"---\ntitle: x\n---", ""},
		{"---\ntitle: x\nbody", "title: x\nbody"}, // no closing marker
		{"---\n---\nBody", "Body"},
	}
	for _, c := range cases {
		if got := StripFrontmatter(c.in); got != c.want {
			t.Errorf("StripFrontmatter(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestNoteTitle(t *testing.T) {
	if got := NoteTitle("project"); got != "项目知识" {
		t.Errorf("NoteTitle(project) = %q", got)
	}
	if got := NoteTitle("user"); got != "用户信息" {
		t.Errorf("NoteTitle(user) = %q", got)
	}
	if got := NoteTitle("custom"); got != "custom" {
		t.Errorf("NoteTitle(custom) = %q", got)
	}
}

func TestDisplayName(t *testing.T) {
	cases := map[string]string{
		"-Users-name-Workspace-MyApp": "MyApp",
		"MyApp":                       "MyApp",
	}
	for in, want := range cases {
		if got := DisplayName(in); got != want {
			t.Errorf("DisplayName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestMatchProjectExactName(t *testing.T) {
	projects := []db.Project{{ID: 3, Name: "MyApp"}}
	if got := MatchProject("MyApp", projects, nil); got != 3 {
		t.Errorf("exact name match = %d, want 3", got)
	}
}

func TestMatchProjectRepoPath(t *testing.T) {
	pid := int64(5)
	repos := []db.Repository{{Path: "/home/user/code/MyApp", ProjectID: &pid}}
	if got := MatchProject("MyApp", nil, repos); got != 5 {
		t.Errorf("repo path match = %d, want 5", got)
	}
}

func TestImportScansMemoryDir(t *testing.T) {
	home := fakeHome(t)
	claudeDir := filepath.Join(home, ".claude", "projects")
	memDir := filepath.Join(claudeDir, "-Users-u-Workspace-Proj", "memory")
	// The sample tree holds both cases: project.md (imported, frontmatter
	// stripped) and notes.txt (ignored — not markdown).
	imptest.CopySample(t, "testdata/memory", memDir)

	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	imp := New(db)
	docs, err := imp.Import()
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if len(docs) != 1 {
		t.Fatalf("expected 1 doc, got %d", len(docs))
	}
	d := docs[0]
	if d.Source != "claude" {
		t.Errorf("source = %q", d.Source)
	}
	if d.Title != "项目知识" {
		t.Errorf("title = %q", d.Title)
	}
	if !strings.Contains(d.Content, "hello world") {
		t.Errorf("content = %q", d.Content)
	}
	if d.ProjectID != 0 {
		t.Errorf("no project should match, got project %d", d.ProjectID)
	}
}

func TestImportMissingDirIsNoop(t *testing.T) {
	fakeHome(t) // fresh empty home
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	imp := New(db)
	docs, err := imp.Import()
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if len(docs) != 0 {
		t.Fatalf("expected no docs, got %d", len(docs))
	}
}

// An oversized memory file must be skipped, not imported: os.ReadFile would
// load the whole file into memory before any bound check could reject it.
func TestImportSkipsOversizedFile(t *testing.T) {
	home := fakeHome(t)
	claudeDir := filepath.Join(home, ".claude", "projects")
	memDir := filepath.Join(claudeDir, "-Users-u-Workspace-Proj", "memory")
	imptest.CopySample(t, "testdata/oversize", memDir)
	// The oversized file is generated rather than stored: a sample big enough
	// to exceed the cap would put a megabyte of 'x' into the repository, and
	// its size is defined by db.MaxNoteContentLen anyway.
	if err := os.WriteFile(filepath.Join(memDir, "huge.md"),
		[]byte(strings.Repeat("x", db.MaxNoteContentLen+1)), 0o644); err != nil {
		t.Fatal(err)
	}

	database, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	imp := New(database)
	docs, err := imp.Import()
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if len(docs) != 1 {
		t.Fatalf("expected only the small doc, got %d", len(docs))
	}
	if !strings.Contains(docs[0].Content, "hello world") {
		t.Errorf("kept doc content = %q", docs[0].Content)
	}
}

// TestImporterImplementsInterface guards the interface contract.
func TestImporterImplementsInterface(t *testing.T) {
	db, _ := sql.Open("sqlite", ":memory:")
	defer db.Close()
	var _ plugin.KnowledgeImporter = New(db)
}
