package db

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// The topic layer (v27). The migration must work on a REAL pre-v27 database —
// one whose project_notes has no topic_id column — because that is the only
// shape an upgrading user has. A test that only opens a fresh database would
// pass even if the migration were broken, because createTables already
// creates the new shape.

// legacyDB builds a pre-v27 database: the current schema minus the topic
// table and the topic_id column, stamped at the version before v27.
//
// The pre-v27 shape is rebuilt by hand rather than by dropping columns from
// the current schema: SQLite refuses to DROP COLUMN a column that a foreign
// key definition still names, and the topic_id column is exactly that.
func legacyDB(t *testing.T, path string) *sql.DB {
	t.Helper()
	database, err := InitDB(path)
	if err != nil {
		t.Fatalf("InitDB: %v", err)
	}
	// Rebuild project_notes without topic_id. The table is empty at this
	// point (the test seeds it afterwards), so the copy-and-swap is lossless.
	if _, err := database.Exec(`
		CREATE TABLE project_notes_legacy (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			project_id INTEGER NOT NULL,
			title TEXT DEFAULT '',
			content TEXT NOT NULL,
			tags TEXT DEFAULT '',
			kind TEXT DEFAULT 'other',
			pinned INTEGER DEFAULT 0,
			source TEXT DEFAULT 'manual',
			sort_order INTEGER DEFAULT 0,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
		)`); err != nil {
		t.Fatalf("create the legacy table: %v", err)
	}
	if _, err := database.Exec("DROP TABLE project_notes"); err != nil {
		t.Fatalf("drop the current table: %v", err)
	}
	if _, err := database.Exec("ALTER TABLE project_notes_legacy RENAME TO project_notes"); err != nil {
		t.Fatalf("rename the legacy table: %v", err)
	}
	if _, err := database.Exec("DROP TABLE IF EXISTS note_topics"); err != nil {
		t.Fatalf("drop note_topics: %v", err)
	}
	if err := SetConfig(database, migrationVersionKey, "26"); err != nil {
		t.Fatal(err)
	}
	return database
}

func TestMigrationV27AddsTheTopicLayer(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")

	legacy := legacyDB(t, dbPath)
	// A note that existed before the upgrade must survive it.
	if _, err := legacy.Exec(
		"INSERT INTO projects (name, root_path) VALUES ('p', '/tmp/p')"); err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.Exec(
		"INSERT INTO project_notes (project_id, title, content) VALUES (1, 'kept', 'body')"); err != nil {
		t.Fatal(err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}

	upgraded, err := InitDB(dbPath)
	if err != nil {
		t.Fatalf("InitDB (upgrade): %v", err)
	}
	defer upgraded.Close() //nolint:errcheck // test teardown

	if v := readConfig(t, upgraded, migrationVersionKey); !versionAtLeast(v, 27) {
		t.Errorf("schema_version = %q, want >= 27", v)
	}

	// The note survived, still under its project, with no topic.
	var title, topicID string
	err = upgraded.QueryRow("SELECT title, COALESCE(CAST(topic_id AS TEXT), 'NULL') FROM project_notes WHERE id = 1").
		Scan(&title, &topicID)
	if err != nil {
		t.Fatalf("read the surviving note: %v", err)
	}
	if title != "kept" {
		t.Errorf("note title = %q, want %q", title, "kept")
	}
	if topicID != "0" && topicID != "NULL" {
		t.Errorf("topic_id = %q, want no topic", topicID)
	}

	// The topic table exists and accepts a topic.
	if _, err := upgraded.Exec(
		"INSERT INTO note_topics (project_id, name) VALUES (1, '网关')"); err != nil {
		t.Fatalf("insert a topic: %v", err)
	}
}

func TestMigrationV27IsIdempotent(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")

	legacy := legacyDB(t, dbPath)
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}

	// First upgrade applies the migration.
	db1, err := InitDB(dbPath)
	if err != nil {
		t.Fatalf("InitDB (first): %v", err)
	}
	if err := db1.Close(); err != nil {
		t.Fatal(err)
	}

	// Second open must not fail on the already-applied migration.
	db2, err := InitDB(dbPath)
	if err != nil {
		t.Fatalf("InitDB (second): %v", err)
	}
	defer db2.Close() //nolint:errcheck // test teardown
	if v := readConfig(t, db2, migrationVersionKey); !versionAtLeast(v, 27) {
		t.Errorf("schema_version = %q, want >= 27", v)
	}
}

func TestMigrationV27KeepsExistingNotesIntact(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")

	legacy := legacyDB(t, dbPath)
	if _, err := legacy.Exec(
		"INSERT INTO projects (name, root_path) VALUES ('p', '/tmp/p')"); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 5; i++ {
		if _, err := legacy.Exec(
			"INSERT INTO project_notes (project_id, title, content, tags, kind) VALUES (1, ?, ?, 'a,b', 'knowledge')",
			"note", "body"); err != nil {
			t.Fatal(err)
		}
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}

	upgraded, err := InitDB(dbPath)
	if err != nil {
		t.Fatalf("InitDB: %v", err)
	}
	defer upgraded.Close() //nolint:errcheck // test teardown

	var count int
	if err := upgraded.QueryRow("SELECT COUNT(*) FROM project_notes").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 5 {
		t.Errorf("note count = %d, want 5 — the upgrade must not drop notes", count)
	}
	// Their tags and kinds must be untouched too.
	var tags, kind string
	if err := upgraded.QueryRow("SELECT tags, kind FROM project_notes LIMIT 1").Scan(&tags, &kind); err != nil {
		t.Fatal(err)
	}
	if tags != "a,b" || kind != "knowledge" {
		t.Errorf("tags/kind = %q/%q, want a,b/knowledge", tags, kind)
	}
}
