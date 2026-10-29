package db

import (
	"database/sql"
	"path/filepath"
	"testing"

	"repotory/internal/domain"
)

// scannedProjects returns only the scanner-origin projects, excluding the seeded
// default ("Uncategorized") landing project (ADR-0023) that otherwise inflates
// every whole-table project count and would be mistaken for a split child in the
// "any project that isn't the original" loops below.
func scannedProjects(t *testing.T, database *sql.DB) []Project {
	t.Helper()
	all, err := GetAllProjects(database)
	if err != nil {
		t.Fatalf("GetAllProjects: %v", err)
	}
	out := make([]Project, 0, len(all))
	for _, p := range all {
		if p.ProjectKind == domain.ProjectKindScanned {
			out = append(out, p)
		}
	}
	return out
}

// mustExecProject inserts a project and returns its id.
func mustExecProject(t *testing.T, database *sql.DB, name, rootPath string) int64 {
	t.Helper()
	res, err := database.Exec("INSERT INTO projects (name, root_path) VALUES (?, ?)", name, rootPath)
	if err != nil {
		t.Fatalf("insert project %s: %v", name, err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("project id: %v", err)
	}
	return id
}

// mustExecRepo inserts a repository bound to a project and returns its id.
func mustExecRepo(t *testing.T, database *sql.DB, path string, projectID int64) int64 {
	t.Helper()
	res, err := database.Exec("INSERT INTO repositories (path, project_id) VALUES (?, ?)", path, projectID)
	if err != nil {
		t.Fatalf("insert repo %s: %v", path, err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("repo id: %v", err)
	}
	return id
}

func TestSplitProjectDownMultiRepo(t *testing.T) {
	database := setupTestDB(t)

	// Parent project with two repos under /tmp/workspace.
	pid := mustExecProject(t, database, "workspace", "/tmp/workspace")
	repo1 := mustExecRepo(t, database, "/tmp/workspace/repo-a", pid)
	repo2 := mustExecRepo(t, database, "/tmp/workspace/repo-b", pid)

	newLevel, err := SplitProjectDown(database, pid)
	if err != nil {
		t.Fatalf("SplitProjectDown failed: %v", err)
	}
	if newLevel != -1 {
		t.Errorf("expected new level -1, got %d", newLevel)
	}

	projects := scannedProjects(t, database)
	if len(projects) != 2 {
		t.Fatalf("expected 2 projects after split, got %d", len(projects))
	}

	// The original keeps the first repo; the second repo moved to a new project.
	r1, _ := GetRepositoriesByProjectID(database, pid)
	if len(r1) != 1 || r1[0].ID != repo1 {
		t.Errorf("original project should keep only repo-a, got %d repos", len(r1))
	}
	var otherID int64
	for _, p := range projects {
		if p.ID != pid {
			otherID = p.ID
		}
	}
	r2, _ := GetRepositoriesByProjectID(database, otherID)
	if len(r2) != 1 || r2[0].ID != repo2 {
		t.Errorf("new project should hold repo-b, got %d repos", len(r2))
	}

	// The split project is no longer auto-grouped.
	p, _ := GetProjectByID(database, pid)
	if p.IsAutoGrouped {
		t.Error("project should not be auto-grouped after manual split")
	}
}

func TestSplitProjectDownSingleRepo(t *testing.T) {
	database := setupTestDB(t)
	pid := mustExecProject(t, database, "solo", "/tmp/solo")
	mustExecRepo(t, database, "/tmp/solo/repo", pid)

	if _, err := SplitProjectDown(database, pid); err != nil {
		t.Fatalf("SplitProjectDown on single-repo project failed: %v", err)
	}
	projects := scannedProjects(t, database)
	if len(projects) != 1 {
		t.Errorf("single-repo split must not create projects, got %d", len(projects))
	}
}

func TestMergeProjectUp(t *testing.T) {
	database := setupTestDB(t)

	// A sits one level under the temp root; B is a true sibling (direct child
	// of the same root); C is nested deeper and must NOT be merged. The root
	// comes from TempDir rather than a /tmp literal: merging goes through
	// filepath.Dir, so a POSIX literal lands on a different path on Windows.
	base := t.TempDir()
	dirA := filepath.Join(base, "workspace")
	dirB := filepath.Join(base, "sibling-b")
	dirC := filepath.Join(base, "other", "repo-c")
	pidA := mustExecProject(t, database, "workspace", dirA)
	pidB := mustExecProject(t, database, "sibling-b", dirB)
	pidC := mustExecProject(t, database, "elsewhere", dirC)
	mustExecRepo(t, database, filepath.Join(dirA, "repo-a"), pidA)
	mustExecRepo(t, database, filepath.Join(dirB, "repo"), pidB)
	mustExecRepo(t, database, dirC, pidC)

	newLevel, err := MergeProjectUp(database, pidA)
	if err != nil {
		t.Fatalf("MergeProjectUp failed: %v", err)
	}
	if newLevel != 1 {
		t.Errorf("expected new level 1, got %d", newLevel)
	}

	projects := scannedProjects(t, database)
	if len(projects) != 2 {
		t.Fatalf("expected 2 projects after merge (workspace + elsewhere), got %d", len(projects))
	}

	// The merged project holds both workspace repos; notes/todos follow too.
	repos, _ := GetRepositoriesByProjectID(database, pidA)
	if len(repos) != 2 {
		t.Errorf("merged project should hold 2 repos, got %d", len(repos))
	}
	// The unrelated project is untouched.
	reposC, _ := GetRepositoriesByProjectID(database, pidC)
	if len(reposC) != 1 {
		t.Errorf("unrelated project should be untouched, got %d repos", len(reposC))
	}
	p, _ := GetProjectByID(database, pidA)
	if p.RootPath != base || p.Name != filepath.Base(base) {
		t.Errorf("merged project should take the parent dir identity (%s), got %s/%s", base, p.RootPath, p.Name)
	}
	if p.IsAutoGrouped {
		t.Error("merged project should not be auto-grouped")
	}
}

func TestGetHeatmapDataProjectFilter(t *testing.T) {
	database := setupTestDB(t)

	pidA := mustExecProject(t, database, "a", "/tmp/a")
	pidB := mustExecProject(t, database, "b", "/tmp/b")
	repoA := mustExecRepo(t, database, "/tmp/a/r1", pidA)
	repoB := mustExecRepo(t, database, "/tmp/b/r2", pidB)

	if err := UpsertDailyStat(database, repoA, "2026-08-01", "all", 1, 10, 2, 3); err != nil {
		t.Fatal(err)
	}
	if err := UpsertDailyStat(database, repoB, "2026-08-01", "all", 1, 5, 1, 1); err != nil {
		t.Fatal(err)
	}

	global, err := GetHeatmapData(database, "2026-01-01", "2026-12-31", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(global) != 1 || global[0].LinesAdded != 15 {
		t.Fatalf("global heatmap should aggregate both repos (15 added), got %+v", global)
	}
	if global[0].Commits != 4 {
		t.Fatalf("global heatmap should sum commits (4), got %+v", global)
	}

	filtered, err := GetHeatmapData(database, "2026-01-01", "2026-12-31", "", pidA)
	if err != nil {
		t.Fatal(err)
	}
	if len(filtered) != 1 || filtered[0].LinesAdded != 10 {
		t.Fatalf("project heatmap should only count project A (10 added), got %+v", filtered)
	}
	if filtered[0].Commits != 3 {
		t.Fatalf("project heatmap should sum project A commits (3), got %+v", filtered)
	}
}

// Regression: the sibling pre-filter used root_path LIKE parentDir || '/%'
// with an unescaped pattern. A '%' or '_' in the parent directory name
// over-matched (harmlessly, thanks to the exact re-check), but on Windows the
// '\' in every stored path acted as the LIKE escape character, so nothing
// matched and MergeProjectUp silently merged nothing. Matching is now an
// exact filepath.Dir comparison, so metacharacters in the path are inert.
func TestMergeProjectUpWithMetacharactersInPath(t *testing.T) {
	database := setupTestDB(t)

	// Parent directory name carries '%' and '_' — the old LIKE pattern
	// treated both as wildcards. Windows-style backslash separators can't be
	// exercised on a darwin/linux test machine, but the same escaping defect
	// applies: an exact comparison has no metacharacters at all.
	parent := "/tmp/work_space%100"
	target := mustExecProject(t, database, "alpha", parent+"/alpha")
	repoA := mustExecRepo(t, database, parent+"/alpha", target)
	sibling := mustExecProject(t, database, "beta", parent+"/beta")
	repoB := mustExecRepo(t, database, parent+"/beta", sibling)
	stranger := mustExecProject(t, database, "elsewhere", "/tmp/other/beta")
	mustExecRepo(t, database, "/tmp/other/beta", stranger)

	newLevel, err := MergeProjectUp(database, target)
	if err != nil {
		t.Fatalf("MergeProjectUp: %v", err)
	}
	if newLevel != 1 {
		t.Errorf("expected new level 1, got %d", newLevel)
	}

	// The true sibling's repos, notes and todos move to the target and the
	// sibling project is deleted; the look-alike under /tmp/other survives.
	var n int
	if err := database.QueryRow("SELECT COUNT(*) FROM projects WHERE id = ?", sibling).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("sibling under the same parent should be merged away")
	}
	if err := database.QueryRow("SELECT COUNT(*) FROM projects WHERE id = ?", stranger).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("project under a different parent must survive the merge")
	}
	if err := database.QueryRow(
		"SELECT COUNT(*) FROM repositories WHERE id IN (?, ?) AND project_id = ?",
		repoA, repoB, target).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Errorf("both repos should belong to the merged project, got %d", n)
	}
}

// A merged project can end up holding repos whose paths are already owned by
// other projects — those per-repo projects survive an earlier "merge up" because
// their own parent directory differs from the merged root, so the merge never
// absorbed them. Split used to INSERT blindly and die on
// `UNIQUE constraint failed: projects.root_path`, rolling the whole change back
// and surfacing raw SQLite text in the UI while leaving the project stuck at the
// merged level. Both the moved repo and the surviving project's rename must
// tolerate an already-owned path.
func TestSplitProjectDownRepoPathAlreadyOwned(t *testing.T) {
	database := setupTestDB(t)

	merged := mustExecProject(t, database, "cbibank", "/tmp/cbibank")
	repoA := mustExecRepo(t, database, "/tmp/cbibank/group/repo-a", merged)
	repoB := mustExecRepo(t, database, "/tmp/cbibank/group/repo-b", merged)
	// Both repo paths are already projects in their own right.
	ownerA := mustExecProject(t, database, "repo-a", "/tmp/cbibank/group/repo-a")
	ownerB := mustExecProject(t, database, "repo-b", "/tmp/cbibank/group/repo-b")

	newLevel, err := SplitProjectDown(database, merged)
	if err != nil {
		t.Fatalf("split must tolerate owned repo paths, got: %v", err)
	}

	var gotB int64
	if err := database.QueryRow("SELECT project_id FROM repositories WHERE id = ?", repoB).Scan(&gotB); err != nil {
		t.Fatalf("scan repo-b owner: %v", err)
	}
	if gotB != ownerB {
		t.Errorf("repo-b should be re-pointed at its existing owner %d, got %d", ownerB, gotB)
	}
	if n := countProjectsAt(database, "/tmp/cbibank/group/repo-b"); n != 1 {
		t.Errorf("split must not create a duplicate project for an owned path, found %d", n)
	}

	// The survivor keeps repo-a but cannot claim a root path somebody else owns.
	var gotA int64
	if err := database.QueryRow("SELECT project_id FROM repositories WHERE id = ?", repoA).Scan(&gotA); err != nil {
		t.Fatalf("scan repo-a owner: %v", err)
	}
	if gotA != merged {
		t.Errorf("repo-a should stay with the original project %d, got %d", merged, gotA)
	}
	p, err := GetProjectByID(database, merged)
	if err != nil {
		t.Fatalf("reload merged project: %v", err)
	}
	if p.RootPath != "/tmp/cbibank" {
		t.Errorf("merged project must keep its own root when repo-a's path is taken, got %q", p.RootPath)
	}
	if p.LevelOverride != newLevel || p.IsAutoGrouped {
		t.Errorf("level/grouping must still update: level_override=%d returned=%d auto=%v", p.LevelOverride, newLevel, p.IsAutoGrouped)
	}
	if ownerAfter, err := GetProjectByID(database, ownerA); err != nil || ownerAfter.ID != ownerA {
		t.Errorf("the pre-existing owner of repo-a must survive untouched: %v", err)
	}
}

func countProjectsAt(database *sql.DB, rootPath string) int {
	var n int
	if err := database.QueryRow("SELECT count(*) FROM projects WHERE root_path = ?", rootPath).Scan(&n); err != nil {
		return -1
	}
	return n
}
