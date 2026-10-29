package hermes

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"repotory/internal/core/plugin"
	"repotory/internal/importers/imptest"
)

// writeStateDB materializes a Hermes state.db from the committed .sql sample.
//
// The sample mirrors the layout confirmed against
// TencentCloud/TencentDB-Agent-Memory's asset importer: a messages table
// with (session_id, role, content, tool_call_id, tool_calls, tool_name,
// timestamp). Two sessions plus one tool-only session.
//
// A .sql dump rather than a committed .db file: a binary blob shows nothing
// when the format drifts, while the dump reads as the schema and the rows it
// is supposed to be (ADR-0011 decision 5).
func writeStateDB(t *testing.T, path string) {
	t.Helper()
	st, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	imptest.ExecScript(t, st, "testdata/state.sql")
}

func TestImportSessionsFromStateDB(t *testing.T) {
	hermesHome := t.TempDir()
	t.Setenv("HERMES_HOME", hermesHome)
	imptest.SetHome(t, t.TempDir()) // bogus HOME proves $HERMES_HOME wins
	writeStateDB(t, filepath.Join(hermesHome, "state.db"))

	database, _ := sql.Open("sqlite", ":memory:")
	defer database.Close()
	docs, err := New(database).Import()
	if err != nil {
		t.Fatal(err)
	}
	if len(docs) != 2 {
		t.Fatalf("expected 2 session docs, got %d: %v", len(docs), titles(docs))
	}
	var foundAlpha bool
	for _, d := range docs {
		if d.Source != "hermes" {
			t.Errorf("source = %q", d.Source)
		}
		if d.Kind != "log" {
			t.Errorf("kind = %q, sessions are log notes", d.Kind)
		}
		if !strings.HasPrefix(d.Title, "帮我修一下") && !strings.HasPrefix(d.Title, "解释一下") {
			t.Errorf("title %q should start with the first prompt", d.Title)
		}
		if strings.Contains(d.Title, "sess-alpha-0001") {
			t.Errorf("title %q leaks the full session id; expect an 8-char tail", d.Title)
		}
		if strings.Contains(d.Content, "已修复") {
			foundAlpha = true
			if !strings.Contains(d.Content, "sess-alpha-0001") {
				t.Errorf("body should carry the session id for provenance:\n%s", d.Content)
			}
			if strings.Contains(d.Content, "tool output noise") {
				t.Errorf("tool noise must not be in the note:\n%s", d.Content)
			}
		}
	}
	if !foundAlpha {
		t.Error("session alpha's reply not found in any doc")
	}
}

func TestImportSessionsNoStateDBIsNoop(t *testing.T) {
	hermesHome := t.TempDir() // has memories/ but no state.db
	t.Setenv("HERMES_HOME", hermesHome)
	imptest.SetHome(t, t.TempDir())
	if err := os.MkdirAll(filepath.Join(hermesHome, "memories"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(hermesHome, "memories", "MEMORY.md"), []byte("body"), 0o644); err != nil {
		t.Fatal(err)
	}
	database, _ := sql.Open("sqlite", ":memory:")
	defer database.Close()
	docs, err := New(database).Import()
	if err != nil {
		t.Fatal(err)
	}
	if len(docs) != 1 {
		t.Fatalf("expected only the MEMORY doc, got %d", len(docs))
	}
}

func TestImportSessionsDriftFailsLoudly(t *testing.T) {
	hermesHome := t.TempDir()
	t.Setenv("HERMES_HOME", hermesHome)
	imptest.SetHome(t, t.TempDir())

	// A state.db with a messages table missing the columns we read: this must
	// NOT look like "no sessions".
	st, err := sql.Open("sqlite", "file:"+filepath.Join(hermesHome, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.Exec(`CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT)`); err != nil {
		t.Fatal(err)
	}
	_ = st.Close()

	database, _ := sql.Open("sqlite", ":memory:")
	defer database.Close()
	_, err = New(database).Import()
	if err == nil || !strings.Contains(err.Error(), "unrecognized Hermes state layout") {
		t.Fatalf("expected a loud layout-drift error, got %v", err)
	}
}

func TestImportSessionsAttachesToConfiguredProject(t *testing.T) {
	hermesHome := t.TempDir()
	t.Setenv("HERMES_HOME", hermesHome)
	imptest.SetHome(t, t.TempDir())
	writeStateDB(t, filepath.Join(hermesHome, "state.db"))

	database, _ := sql.Open("sqlite", ":memory:")
	defer database.Close()
	if _, err := database.Exec(
		`CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT)`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(
		`INSERT INTO app_config(key, value) VALUES (?, ?)`, ProjectConfigKey, "99"); err != nil {
		t.Fatal(err)
	}

	docs, err := New(database).Import()
	if err != nil {
		t.Fatal(err)
	}
	if len(docs) != 2 {
		t.Fatalf("expected 2 docs, got %d", len(docs))
	}
	for _, d := range docs {
		if d.ProjectID != 99 {
			t.Errorf("doc %q ProjectID = %d, want configured 99", d.Title, d.ProjectID)
		}
	}
}

func TestImporterImplementsInterfaceWithSessions(t *testing.T) {
	var _ plugin.KnowledgeImporter = New((*sql.DB)(nil))
}
