package service

import (
	"testing"

	"repotory/internal/db"
)

// TestGetProjects_MyAdded7dSurvivesAnEmptyAnchorDay pins the reason
// ProjectResponse carries a second, windowed field.
//
// MyAdded is anchored on GetProjects' default date (yesterday). On any day
// without personal commits it is 0 for every project, so the search page's
// "hot projects" ordering degenerated to alphabetical and every card read
// "recently +0" — the exact state the screenshot sweep caught. MyAdded7d sums
// the trailing 7-day window on the same anchor, which keeps a real ranking.
func TestGetProjects_MyAdded7dSurvivesAnEmptyAnchorDay(t *testing.T) {
	svc, _ := setupService(t)
	database := svc.db

	pid := seedProject(t, database, "p", "/tmp/p")
	rid := seedRepo(t, database, "/tmp/p/r1", pid)

	// Anchor day (2026-10-20) has nothing; the activity sits three days back.
	if err := db.UpsertDailyStat(database, rid, "2026-10-20", "me", 0, 0, 0, 0); err != nil {
		t.Fatal(err)
	}
	if err := db.UpsertDailyStat(database, rid, "2026-10-17", "me", 3, 120, 8, 2); err != nil {
		t.Fatal(err)
	}
	// Outside the window: must not leak in.
	if err := db.UpsertDailyStat(database, rid, "2026-10-01", "me", 9, 9999, 0, 9); err != nil {
		t.Fatal(err)
	}
	// Another author's line inside the window: must not count as "mine".
	if err := db.UpsertDailyStat(database, rid, "2026-10-18", "teammate", 5, 7777, 0, 5); err != nil {
		t.Fatal(err)
	}

	got := projectByName(t, svc.GetProjects("2026-10-20", false), "p")

	if got.MyAdded != 0 {
		t.Errorf("MyAdded = %d on an empty anchor day; want 0 (the day metric stays single-day)", got.MyAdded)
	}
	if got.MyAdded7d != 120 {
		t.Errorf("MyAdded7d = %d; want 120 (window sum, teammate and out-of-window rows excluded)", got.MyAdded7d)
	}
}

// TestGetProjects_MyAdded7dWindowIsSevenDaysWide pins the window edges, since
// "3 days back counted" says nothing about whether day 6 or day 8 is in.
func TestGetProjects_MyAdded7dWindowIsSevenDaysWide(t *testing.T) {
	svc, _ := setupService(t)
	database := svc.db

	pid := seedProject(t, database, "p", "/tmp/p")
	rid := seedRepo(t, database, "/tmp/p/r1", pid)

	// Anchor 2026-10-20; window is 2026-10-14..2026-10-20 inclusive (7 days).
	seeds := map[string]int{
		"2026-10-20": 1,   // in
		"2026-10-14": 10,  // in — first day
		"2026-10-13": 100, // out — one day before the window
	}
	for date, added := range seeds {
		if err := db.UpsertDailyStat(database, rid, date, "me", 1, added, 0, 1); err != nil {
			t.Fatal(err)
		}
	}

	got := projectByName(t, svc.GetProjects("2026-10-20", false), "p")
	if want := 11; got.MyAdded7d != want {
		t.Errorf("MyAdded7d = %d; want %d (7-day window inclusive of both edges)", got.MyAdded7d, want)
	}
}

// projectByName picks the seeded project out of the list. GetProjects also
// returns the always-present default bucket, so indexing by position would
// make these assertions depend on unrelated rows.
func projectByName(t *testing.T, list []ProjectResponse, name string) ProjectResponse {
	t.Helper()
	for _, pr := range list {
		if pr.Name == name {
			return pr
		}
	}
	t.Fatalf("project %q not found in %d projects", name, len(list))
	return ProjectResponse{}
}
