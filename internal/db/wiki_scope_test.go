package db

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

// Page scope (ADR-0031): the project tier and the global tier.
//
// The global tier is stored as SQL NULL. That is not a style choice — it is
// forced by the schema, and these tests pin the force so a future "simplify it
// to 0" cannot land silently.

func scopeDB(t *testing.T) *sql.DB {
	t.Helper()
	database, err := InitDB(filepath.Join(t.TempDir(), "scope.db"))
	if err != nil {
		t.Fatalf("init db: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return database
}

func scopeProject(t *testing.T, database *sql.DB, name string) int64 {
	t.Helper()
	tx, err := database.Begin()
	if err != nil {
		t.Fatal(err)
	}
	pid, err := SyncProjectTx(tx, name, "/code/"+name, 0, true)
	if err != nil {
		_ = tx.Rollback()
		t.Fatalf("SyncProjectTx: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	return pid
}

// The global tier must be NULL in the raw column. Every read path projects it
// to 0 through COALESCE, so Go code sees ProjectID == 0 either way — but the
// STORED value has to be NULL, because the column carries a foreign key.
func TestSetWikiPageScope_GlobalIsStoredAsNull(t *testing.T) {
	database := scopeDB(t)
	pid := scopeProject(t, database, "p")
	page, err := CreateWikiPage(database, WikiKindConcept, "scope-page", "Scope", pid, "body")
	if err != nil {
		t.Fatal(err)
	}

	if err := SetWikiPageScope(database, page.ID, 0); err != nil {
		t.Fatalf("SetWikiPageScope: %v", err)
	}

	var isNull int
	if err := database.QueryRow("SELECT project_id IS NULL FROM wiki_pages WHERE id = ?", page.ID).
		Scan(&isNull); err != nil {
		t.Fatal(err)
	}
	if isNull != 1 {
		t.Error("a global page must store project_id as NULL, not 0")
	}

	got, err := GetWikiPageByID(database, page.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ProjectID != 0 {
		t.Errorf("global page ProjectID = %d, want 0", got.ProjectID)
	}
}

// This is the reason the previous test exists: with PRAGMA foreign_keys=ON,
// writing the literal 0 is rejected by the constraint, because there is no
// project row with id 0. If this test ever fails, the schema stopped enforcing
// the foreign key and the NULL convention became merely conventional.
func TestSetWikiPageScope_LiteralZeroIsRejectedByTheForeignKey(t *testing.T) {
	database := scopeDB(t)
	pid := scopeProject(t, database, "p")
	page, err := CreateWikiPage(database, WikiKindConcept, "zero-page", "Zero", pid, "body")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := database.Exec("UPDATE wiki_pages SET project_id = 0 WHERE id = ?", page.ID); err == nil {
		t.Fatal("expected the foreign key to reject project_id = 0 — " +
			"the global tier must be NULL (there is no project row with id 0)")
	}
}

// Moving a page back into a project stores the real project id, and the round
// trip global -> project -> global leaves the row exactly where it started.
func TestSetWikiPageScope_RoundTrip(t *testing.T) {
	database := scopeDB(t)
	pid := scopeProject(t, database, "p")
	page, err := CreateWikiPage(database, WikiKindConcept, "round-trip", "Round", pid, "body")
	if err != nil {
		t.Fatal(err)
	}

	if err := SetWikiPageScope(database, page.ID, 0); err != nil {
		t.Fatal(err)
	}
	if err := SetWikiPageScope(database, page.ID, pid); err != nil {
		t.Fatal(err)
	}
	if err := SetWikiPageScope(database, page.ID, 0); err != nil {
		t.Fatal(err)
	}

	got, err := GetWikiPageByID(database, page.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ProjectID != 0 {
		t.Errorf("ProjectID = %d after the round trip, want 0", got.ProjectID)
	}
}

// An unknown project must fail with a sentence a human can act on, not with
// the constraint's bare "FOREIGN KEY constraint failed".
func TestSetWikiPageScope_RejectsUnknownProject(t *testing.T) {
	database := scopeDB(t)
	pid := scopeProject(t, database, "p")
	page, err := CreateWikiPage(database, WikiKindConcept, "unknown-project", "Unknown", pid, "body")
	if err != nil {
		t.Fatal(err)
	}

	err = SetWikiPageScope(database, page.ID, 4242)
	if err == nil {
		t.Fatal("expected an error for a project that does not exist")
	}
	if !strings.Contains(err.Error(), "no project") {
		t.Errorf("error should name the missing project, got %v", err)
	}
}

// Moving a page that does not exist must be an error too — a silent no-op
// would let the UI claim a scope change that never happened.
func TestSetWikiPageScope_ReportsMissingPage(t *testing.T) {
	database := scopeDB(t)
	if err := SetWikiPageScope(database, 9999, 0); err == nil {
		t.Fatal("expected an error for a page that does not exist")
	}
}
