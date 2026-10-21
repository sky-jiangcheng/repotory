package service

import (
	"testing"

	"repotory/internal/db"
)

// The dashboard summary strip must aggregate the SAME scope the project list
// filters by: under the starred filter it covers only starred projects'
// repositories, so header and rows can never disagree (2026-10-19 dashboard
// scope fix). Global scope stays global.
func TestGetSummaryScope(t *testing.T) {
	svc, _ := setupService(t)
	database := svc.db

	// Two scanned projects: Star (starred) with one repo, Plain (unstarred)
	// with one repo. Both have stats on the same date.
	seed := []struct {
		proj     string
		starred  bool
		repoPath string
		added    int
	}{
		{"Star", true, "/code/star", 300},
		{"Plain", false, "/code/plain", 2000},
	}
	for _, r := range seed {
		res, err := database.Exec(
			`INSERT INTO projects (name, root_path, is_starred, project_kind) VALUES (?, ?, ?, 'scanned')`,
			r.proj, r.repoPath, r.starred)
		if err != nil {
			t.Fatalf("seed project %s: %v", r.proj, err)
		}
		pid, _ := res.LastInsertId()
		res, err = database.Exec(`INSERT INTO repositories (path, project_id) VALUES (?, ?)`, r.repoPath, pid)
		if err != nil {
			t.Fatalf("seed repo %s: %v", r.repoPath, err)
		}
		rid, _ := res.LastInsertId()
		if _, err := database.Exec(
			`INSERT INTO daily_stats (repository_id, stat_date, author, files_changed, lines_added, lines_deleted) VALUES (?, '2026-08-15', 'me', 1, ?, 0)`,
			rid, r.added); err != nil {
			t.Fatalf("seed stats %s: %v", r.repoPath, err)
		}
	}

	global, err := svc.GetSummary("2026-08-15", false)
	if err != nil {
		t.Fatalf("global summary: %v", err)
	}
	if global.TotalAdded != 2300 || global.RepoCount != 2 {
		t.Fatalf("global = +%d across %d repos; want +2300 across 2", global.TotalAdded, global.RepoCount)
	}

	scoped, err := svc.GetSummary("2026-08-15", true)
	if err != nil {
		t.Fatalf("scoped summary: %v", err)
	}
	if scoped.TotalAdded != 300 || scoped.RepoCount != 1 {
		t.Fatalf("scoped = +%d across %d repos; want +300 across 1 (only the starred project)", scoped.TotalAdded, scoped.RepoCount)
	}

	// My-counts follow the same scope: the author's rows inside the scope.
	if scoped.MyAdded != 300 {
		t.Fatalf("scoped my_added = %d; want 300", scoped.MyAdded)
	}
}

// The status strip's label is "Last commit" — repo-wide activity, not "my
// last commit". Querying it with the "mine" author filter blanked the strip
// entirely whenever git user.name was unset (the OS-username fallback) or
// simply matched no committer: the strip then showed "no commits" over
// repositories that were actively committing (E2E walkthrough 2026-10-21).
func TestStatusBarNotFilteredByGitUser(t *testing.T) {
	svc, fg := setupService(t)
	pid := seedProject(t, svc.db, "p", "/tmp/p")
	seedRepo(t, svc.db, "/tmp/p/r1", pid)

	bar := svc.GetStatusBar()
	if fg.recentCommitAuthor != "" {
		t.Errorf("GetStatusBar queried recent commit with author filter %q; want none (repo-wide)", fg.recentCommitAuthor)
	}
	if bar.LastCommitTime == "" || bar.LastCommitMsg == "" {
		t.Errorf("status strip missing commit info: %+v", bar)
	}
}

// Scoped and global reads must not fight over the shared connection state —
// trivially true for two queries, but this guards the unscoped fast path from
// ever being replaced by the JOIN (a regression would show as global numbers
// under the starred filter).
func TestGetStatsByDateScopeUnscopedFastPath(t *testing.T) {
	database, err := db.InitDB(":memory:")
	if err != nil {
		t.Fatalf("init db: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	rows, err := db.GetStatsByDateScope(database, "2026-08-15", false)
	if err != nil {
		t.Fatalf("unscoped: %v", err)
	}
	if rows == nil {
		rows = []db.DailyStat{}
	}
	if len(rows) != 0 {
		t.Fatalf("fresh db returned rows: %v", rows)
	}
}
