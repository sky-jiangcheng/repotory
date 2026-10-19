package db

import (
	"database/sql"
	"testing"
)

// v25 must drop exactly the rows the single-repo grouping bug could produce: a
// project whose root directory is not the repository it was mined from, with an
// activity cache that says zero (or was never written).
func TestDropPoisonedActivityMeta(t *testing.T) {
	database := setupTestDB(t)

	// pid1: grouping container root, one repo below it, zeroed cache → poisoned.
	pid1 := mustExecProject(t, database, "MiddlePlatform", "/tmp/repair/group")
	rid1 := mustExecRepo(t, database, "/tmp/repair/group/midplatform-data-monitor", pid1)
	// pid2: the project root IS the repo → cannot be poisoned by this bug.
	pid2 := mustExecProject(t, database, "solo", "/tmp/repair/solo")
	rid2 := mustExecRepo(t, database, "/tmp/repair/solo", pid2)
	// pid3: container root, but a healthy cache (mined after the fix).
	pid3 := mustExecProject(t, database, "fixed", "/tmp/repair/fixed")
	rid3 := mustExecRepo(t, database, "/tmp/repair/fixed/repo", pid3)

	for _, r := range []struct {
		repoID int64
		act    string
	}{
		{rid1, `{"total_commits":0,"active_days":0,"last_commit_date":"","commit_rate_30d":0,"active_months":0}`},
		{rid2, `{"total_commits":0,"active_days":0,"last_commit_date":"","commit_rate_30d":0,"active_months":0}`},
		{rid3, `{"total_commits":41,"active_days":9,"last_commit_date":"2026-10-16","commit_rate_30d":12,"active_months":4}`},
	} {
		if err := UpsertRepoMeta(database, r.repoID, "[]", "", "{}", "[]", "[]", r.act); err != nil {
			t.Fatalf("seed repo_meta for %d: %v", r.repoID, err)
		}
	}
	// A never-mined row carries the column default '{}' — poisoned too when the
	// project root is a container.
	if _, err := database.Exec("UPDATE repo_meta SET activity = '{}' WHERE repository_id = ?", rid1); err != nil {
		t.Fatalf("force '{}' form: %v", err)
	}
	// rid1 must survive the '{}' variant check as well; re-seed the zero form for it
	// after testing '{}' below, so both shapes are covered.
	if err := DropPoisonedActivityMeta(database); err != nil {
		t.Fatalf("DropPoisonedActivityMeta: %v", err)
	}
	if _, err := GetRepoMeta(database, rid1); err == nil {
		t.Error("a container-root project's '{}' activity cache must be dropped")
	}

	// Now the explicit-zero shape on the same row.
	if err := UpsertRepoMeta(database, rid1, "[]", "", "{}", "[]", "[]",
		`{"total_commits":0,"active_days":0,"last_commit_date":"","commit_rate_30d":0,"active_months":0}`); err != nil {
		t.Fatalf("re-seed rid1: %v", err)
	}
	if err := DropPoisonedActivityMeta(database); err != nil {
		t.Fatalf("second run: %v", err)
	}
	if _, err := GetRepoMeta(database, rid1); err == nil {
		t.Error("a container-root project's zeroed activity cache must be dropped")
	}
	// Healthy cache is kept, and a repo mined from its own path keeps a zero too —
	// dropping those would cost re-mines for no correctness gain.
	if _, err := GetRepoMeta(database, rid3); err != nil {
		t.Errorf("healthy cache must survive: %v", err)
	}
	if _, err := GetRepoMeta(database, rid2); err != nil {
		t.Errorf("a solo project mined from its own root must keep its cache: %v", err)
	}
	// Idempotent: a third run changes nothing.
	before := countRepoMeta(t, database)
	if err := DropPoisonedActivityMeta(database); err != nil {
		t.Fatalf("third run: %v", err)
	}
	if after := countRepoMeta(t, database); after != before {
		t.Errorf("third run changed the row count: %d -> %d", before, after)
	}
}

func countRepoMeta(t *testing.T, database *sql.DB) int {
	t.Helper()
	var n int
	if err := database.QueryRow(`SELECT count(*) FROM repo_meta`).Scan(&n); err != nil {
		t.Fatalf("count repo_meta: %v", err)
	}
	return n
}
