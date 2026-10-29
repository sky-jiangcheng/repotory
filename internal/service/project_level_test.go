package service

import (
	"database/sql"
	"errors"
	"path/filepath"
	"testing"

	"repotory/internal/db"
	"repotory/internal/domain"
)

// Regression guard for a bug where MergeProjectUp / SplitProjectDown computed
// the new level and returned it, but never wrote it back — the UPDATE only
// touched is_auto_grouped / root_path / name. The project detail page renders
// level_override as "分组层级", so the number never moved no matter how many
// times the user clicked, and every later call recomputed from the same stale
// column.
func TestUpdateProjectLevel_PersistsLevelOverride(t *testing.T) {
	svc, _ := setupService(t)
	root := "/tmp/leveltest"
	pid := seedProject(t, svc.db, "grp", root)
	seedRepo(t, svc.db, root+"/a", pid)
	seedRepo(t, svc.db, root+"/b", pid)

	assertLevel := func(step string, want int) {
		t.Helper()
		p, err := db.GetProjectByID(svc.db, pid)
		if err != nil {
			t.Fatalf("%s: GetProjectByID: %v", step, err)
		}
		if p.LevelOverride != want {
			t.Errorf("%s: stored level_override = %d, want %d", step, p.LevelOverride, want)
		}
	}

	// Split creates per-repo projects and drops the group to -1.
	if _, err := svc.UpdateProjectLevel(pid, "down", false); err != nil {
		t.Fatalf("down: %v", err)
	}
	assertLevel("after down", -1)

	// Merging back must climb out of -1, not stay there reporting +1 forever.
	if _, err := svc.UpdateProjectLevel(pid, "up", true); err != nil {
		t.Fatalf("up: %v", err)
	}
	assertLevel("after up", 0)
}

// Two consecutive "up" calls must each advance the stored level. Before the
// fix both returned 1 while the second was a no-op.
func TestUpdateProjectLevel_ConsecutiveUpEachAdvance(t *testing.T) {
	svc, _ := setupService(t)
	dir := "/tmp/leveltest2"
	pid := seedProject(t, svc.db, "only", dir)

	var last int
	for i := 1; i <= 3; i++ {
		res, err := svc.UpdateProjectLevel(pid, "up", true)
		if err != nil {
			t.Fatalf("up #%d: %v", i, err)
		}
		p, err := db.GetProjectByID(svc.db, pid)
		if err != nil {
			t.Fatalf("up #%d: GetProjectByID: %v", i, err)
		}
		if res.NewLevel != i {
			t.Errorf("up #%d: returned new_level = %d, want %d", i, res.NewLevel, i)
		}
		if p.LevelOverride != i {
			t.Errorf("up #%d: stored level_override = %d, want %d", i, p.LevelOverride, i)
		}
		last = i
	}
	if last != 3 {
		t.Fatalf("expected to reach level 3, got %d", last)
	}
}

// Splitting a single-repo project has nothing to split off, but the level must
// still move — otherwise the "-" button looks dead on leaf projects.
func TestUpdateProjectLevel_DownOnSingleRepoStillMovesLevel(t *testing.T) {
	svc, _ := setupService(t)
	dir := "/tmp/leveltest3"
	pid := seedProject(t, svc.db, "leaf", dir)
	seedRepo(t, svc.db, dir+"/only", pid)

	res, err := svc.UpdateProjectLevel(pid, "down", false)
	if err != nil {
		t.Fatalf("down: %v", err)
	}
	p, err := db.GetProjectByID(svc.db, pid)
	if err != nil {
		t.Fatalf("GetProjectByID: %v", err)
	}
	if res.NewLevel != -1 || p.LevelOverride != -1 {
		t.Errorf("down on single-repo project: returned %d, stored %d; want -1/-1", res.NewLevel, p.LevelOverride)
	}
}

// A split must be reversible. The project a split came out of still occupies
// the exact path the merge tries to move back into, and projects.root_path is
// UNIQUE — so the sibling scan (which only compared filepath.Dir) missed it and
// every merge failed with "UNIQUE constraint failed: projects.root_path",
// rolling the whole thing back. The user-visible effect was a one-way door:
// split once, never regroup again.
func TestUpdateProjectLevel_SplitThenMergeIsReversible(t *testing.T) {
	svc, _ := setupService(t)
	// The merge walks up with filepath.Dir, so the fixture root has to be a
	// real temp dir rather than a /tmp literal — on Windows a "/tmp/..." string
	// does not survive that walk.
	root := t.TempDir()
	group := seedProject(t, svc.db, "grp", root)
	seedRepo(t, svc.db, filepath.Join(root, "a"), group)
	seedRepo(t, svc.db, filepath.Join(root, "b"), group)
	seedRepo(t, svc.db, filepath.Join(root, "c"), group)

	if _, err := svc.UpdateProjectLevel(group, "down", false); err != nil {
		t.Fatalf("down: %v", err)
	}
	// Collect the ids that still exist: the group plus whatever the split
	// created (the survivors keep their notes, so the group id is still live).
	var live []int64
	for id := int64(1); id <= 8; id++ {
		if p, err := db.GetProjectByID(svc.db, id); err == nil && p != nil && p.ProjectKind == domain.ProjectKindScanned {
			live = append(live, p.ID)
		}
	}
	if len(live) != 3 {
		t.Fatalf("after split want 3 projects, got %d (ids %v)", len(live), live)
	}

	// Merge any of the split-off projects back up. This is the step that used
	// to abort on the root_path unique constraint.
	if _, err := svc.UpdateProjectLevel(live[0], "up", true); err != nil {
		t.Fatalf("up after split: %v", err)
	}

	var after []int64
	for id := int64(1); id <= 8; id++ {
		if p, err := db.GetProjectByID(svc.db, id); err == nil && p != nil && p.ProjectKind == domain.ProjectKindScanned {
			after = append(after, p.ID)
		}
	}
	if len(after) != 1 {
		t.Fatalf("after merge want 1 project, got %d (ids %v)", len(after), after)
	}
	p, err := db.GetProjectByID(svc.db, after[0])
	if err != nil {
		t.Fatalf("GetProjectByID: %v", err)
	}
	// Back at the original root, holding all three repos.
	if p.RootPath != root {
		t.Errorf("merged root_path = %q, want %q", p.RootPath, root)
	}
	repos, err := db.GetRepositoriesByProjectID(svc.db, p.ID)
	if err != nil {
		t.Fatalf("GetRepositoriesByProjectID: %v", err)
	}
	if len(repos) != 3 {
		t.Errorf("merged project holds %d repos, want 3", len(repos))
	}
}

// A confirmed "merge up" deletes sibling projects and moves their notes, todos and
// repositories into the survivor. That is deletion, so the binding must refuse an
// unconfirmed call outright — and the refusal must not leave partial damage behind.
// Enforced at the service layer on purpose: the same method is reachable over plain
// HTTP by any client, so a UI-only guard would be a suggestion.
func TestUpdateProjectLevel_UpRefusesWithoutConfirmation(t *testing.T) {
	svc, _ := setupService(t)
	parent := "/tmp/mergeconfirm"
	group := seedProject(t, svc.db, "grp", parent+"/grp")
	sibling := seedProject(t, svc.db, "sibling", parent+"/sibling")
	seedRepo(t, svc.db, parent+"/grp/repo-a", group)
	if _, err := db.CreateNoteEx(svc.db, sibling, "兄弟笔记", "内容", "", "knowledge", "manual"); err != nil {
		t.Fatalf("seed note: %v", err)
	}

	if _, err := svc.UpdateProjectLevel(group, "up", false); !errors.Is(err, ErrMergeNeedsConfirmation) {
		t.Fatalf("unconfirmed merge must be refused with ErrMergeNeedsConfirmation, got %v", err)
	}
	if _, err := db.GetProjectByID(svc.db, sibling); err != nil {
		t.Fatalf("the refusal must destroy nothing, but the sibling is gone: %v", err)
	}

	if _, err := svc.UpdateProjectLevel(group, "up", true); err != nil {
		t.Fatalf("confirmed merge: %v", err)
	}
	if _, err := db.GetProjectByID(svc.db, sibling); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("a confirmed merge should delete the sibling, got err=%v", err)
	}
}

// The confirmation dialog is only worth having if what it shows is what the merge
// does. Both go through db.MergePlan/the same sibling listing, and this pins the
// agreement numerically: preview counts == what actually arrives.
func TestPreviewProjectMergeUpMatchesTheMerge(t *testing.T) {
	svc, _ := setupService(t)
	parent := t.TempDir()
	group := seedProject(t, svc.db, "grp", filepath.Join(parent, "grp"))
	sibling := seedProject(t, svc.db, "sib", filepath.Join(parent, "sib"))
	seedRepo(t, svc.db, filepath.Join(parent, "grp", "repo-a"), group)
	seedRepo(t, svc.db, filepath.Join(parent, "sib", "repo-b"), sibling)
	for _, title := range []string{"笔记一", "笔记二"} {
		if _, err := db.CreateNoteEx(svc.db, sibling, title, "内容", "", "knowledge", "manual"); err != nil {
			t.Fatalf("seed note %s: %v", title, err)
		}
	}
	if _, err := db.CreateTodo(svc.db, sibling, "待办一"); err != nil {
		t.Fatalf("seed todo: %v", err)
	}

	pre, err := svc.PreviewProjectMergeUp(group)
	if err != nil {
		t.Fatalf("PreviewProjectMergeUp: %v", err)
	}
	if pre.NewRoot != parent {
		t.Errorf("preview NewRoot = %q, want %q", pre.NewRoot, parent)
	}
	if len(pre.Siblings) != 1 || pre.Siblings[0].ID != sibling {
		t.Fatalf("preview must list exactly the one absorbable sibling, got %+v", pre.Siblings)
	}
	if pre.Siblings[0].Name != "sib" {
		t.Errorf("preview should name the sibling for the dialog, got %q", pre.Siblings[0].Name)
	}
	if pre.Notes != 2 || pre.Todos != 1 || pre.Repos != 1 {
		t.Errorf("preview totals = notes %d todos %d repos %d, want 2/1/1", pre.Notes, pre.Todos, pre.Repos)
	}

	if _, err := svc.UpdateProjectLevel(group, "up", true); err != nil {
		t.Fatalf("confirmed merge: %v", err)
	}
	// The survivor must hold exactly what the preview promised it would gain.
	if n, err := db.CountProjectNotes(svc.db, group); err != nil || n != pre.Notes {
		t.Errorf("notes after merge = %d (err %v), preview said %d", n, err, pre.Notes)
	}
	if got := len(svc.ListTodos(group)); got != pre.Todos {
		t.Errorf("todos after merge = %d, preview said %d", got, pre.Todos)
	}
	repos, err := db.GetRepositoriesByProjectID(svc.db, group)
	if err != nil {
		t.Fatalf("repos after merge: %v", err)
	}
	// group kept its own repo and gained the sibling's one.
	if len(repos) != 2 {
		t.Errorf("repos after merge = %d, want 2 (own 1 + previewed 1)", len(repos))
	}
}

// A missing project answers with the domain error rather than a wrapped driver
// message, and a project with nothing to absorb previews an empty list (so the UI can
// say "no sibling here" instead of confirming a no-op).
func TestPreviewProjectMergeUp_Edges(t *testing.T) {
	svc, _ := setupService(t)
	if _, err := svc.PreviewProjectMergeUp(999999); !errors.Is(err, ErrProjectNotFound) {
		t.Fatalf("missing project: got %v, want ErrProjectNotFound", err)
	}

	root := "/tmp/mergealone"
	lonely := seedProject(t, svc.db, "lonely", root+"/lonely")
	seedRepo(t, svc.db, root+"/lonely/repo", lonely)
	pre, err := svc.PreviewProjectMergeUp(lonely)
	if err != nil {
		t.Fatalf("preview of a lonely project: %v", err)
	}
	if len(pre.Siblings) != 0 {
		t.Errorf("nothing should be absorbable here, got %+v", pre.Siblings)
	}
	if pre.Notes != 0 || pre.Todos != 0 || pre.Repos != 0 {
		t.Errorf("empty preview must total zero, got %+v", pre)
	}
}
