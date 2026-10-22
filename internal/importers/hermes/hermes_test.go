package hermes

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	"repotory/internal/core/plugin"
	"repotory/internal/importers/imptest"
)

func TestImportUsesHermesHomeAndAllowlist(t *testing.T) {
	hermesHome := t.TempDir()
	t.Setenv("HERMES_HOME", hermesHome)
	// A bogus HOME proves $HERMES_HOME wins.
	t.Setenv("HOME", t.TempDir())

	// The sample tree holds the cases at once: two imported files
	// (memories/*.md) and three that must be ignored — a non-md file inside
	// memories/, a .md sibling of the memories dir, and a secrets file next
	// to it. The allowlist is memories/*.md ONLY, so nothing outside that
	// one flat directory may ever be read.
	imptest.CopySample(t, "testdata/memories", filepath.Join(hermesHome, "memories"))
	imptest.CopySample(t, "testdata/sibling", hermesHome)

	database, _ := sql.Open("sqlite", ":memory:")
	defer database.Close()
	docs, err := New(database).Import()
	if err != nil {
		t.Fatal(err)
	}
	if len(docs) != 2 {
		t.Fatalf("expected 2 docs (MEMORY, USER), got %d: %v", len(docs), titles(docs))
	}
	for _, d := range docs {
		if d.Source != "hermes" {
			t.Errorf("source = %q", d.Source)
		}
		if strings.Contains(d.Title, "leak") {
			t.Fatalf("allowlist violation: imported %q", d.Title)
		}
	}
}

func TestImportDefaultsToHomeWhenNoHermesHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("HERMES_HOME", "") // unset override -> use ~/.hermes
	imptest.CopySample(t, "testdata/memories/MEMORY.md", filepath.Join(home, ".hermes", "memories", "MEMORY.md"))

	database, _ := sql.Open("sqlite", ":memory:")
	defer database.Close()
	docs, err := New(database).Import()
	if err != nil {
		t.Fatal(err)
	}
	if len(docs) != 1 || docs[0].Title != "Hermes · MEMORY" {
		t.Fatalf("expected 1 MEMORY doc, got %v", titles(docs))
	}
	if !strings.Contains(docs[0].Content, "agent notes body") {
		t.Errorf("content = %q", docs[0].Content)
	}
}

func TestImportMissingIsNoop(t *testing.T) {
	hermesHome := t.TempDir() // exists but has no memories/ dir
	t.Setenv("HERMES_HOME", hermesHome)
	database, _ := sql.Open("sqlite", ":memory:")
	defer database.Close()
	docs, err := New(database).Import()
	if err != nil || len(docs) != 0 {
		t.Fatalf("expected noop, got err=%v docs=%d", err, len(docs))
	}
}

func TestImplementsInterface(t *testing.T) {
	var _ plugin.KnowledgeImporter = New((*sql.DB)(nil))
}

func titles(docs []plugin.ImportDoc) []string {
	var out []string
	for _, d := range docs {
		out = append(out, d.Title)
	}
	return out
}
