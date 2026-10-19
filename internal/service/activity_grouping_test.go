package service

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"repotory/internal/db"
	"repotory/internal/knowledge"
)

// initGitRepoWithCommit makes dir a git repository holding one commit authored
// today, so activity metrics are non-zero without depending on a fixed clock.
func initGitRepoWithCommit(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	// Identity is pinned via env (same reason as stats/commits_recent_test.go):
	// GIT_AUTHOR_NAME outranks `-c user.name`, and agent harnesses may export it
	// process-wide. Strip every ambient GIT_* first so our values win outright.
	clean := make([]string, 0, len(os.Environ()))
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "GIT_") {
			clean = append(clean, kv)
		}
	}
	env := append(clean,
		"GIT_AUTHOR_NAME=Tester", "GIT_AUTHOR_EMAIL=tester@example.invalid",
		"GIT_COMMITTER_NAME=Tester", "GIT_COMMITTER_EMAIL=tester@example.invalid",
		// Isolate from the developer's global config and any hooks.
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null",
	)
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = env
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Skipf("git unavailable: git %v: %v (%s)", args, err, out)
		}
	}
	run("init", "--initial-branch=main")
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte("x"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	run("add", "f.txt")
	run("-c", "user.name=Tester", "-c", "user.email=tester@example.invalid", "commit", "-m", "seed")
}

// A grouping whose single repository sits one level below the project root used to
// cache a zeroed activity: knowledge.Mine ran git in the container directory (not a
// repository, so every probe failed silently into zero) and the "aggregate across the
// real repositories" branch only fired for len(repos) > 1. This is the ordinary
// shape after scanning a group folder, and it is what produced 4 poisoned repo_meta
// rows on a real library, one of them a repository with 6,660 commits.
func TestMineAndCache_SingleRepoGroupingCachesRealActivity(t *testing.T) {
	svc, _ := setupService(t)

	groupRoot := t.TempDir()
	repoDir := filepath.Join(groupRoot, "midplatform-data-monitor")
	initGitRepoWithCommit(t, repoDir)

	pid := seedProject(t, svc.db, "MiddlePlatform", groupRoot)
	rid := seedRepo(t, svc.db, repoDir, pid)

	repos, err := db.GetRepositoriesByProjectID(svc.db, pid)
	if err != nil || len(repos) != 1 {
		t.Fatalf("repos for the grouping: %v (%d)", err, len(repos))
	}
	svc.mineAndCache(rid, groupRoot, repos)

	meta, err := db.GetRepoMeta(svc.db, rid)
	if err != nil {
		t.Fatalf("the mining result must be cached: %v", err)
	}
	var act knowledge.ActivityStat
	if err := json.Unmarshal([]byte(meta.Activity), &act); err != nil {
		t.Fatalf("cached activity is not JSON (%q): %v", meta.Activity, err)
	}
	if act.TotalCommits != 1 {
		t.Errorf("total_commits = %d, want 1: only the per-repository aggregation can see this commit",
			act.TotalCommits)
	}
	if act.LastCommitDate == "" {
		t.Errorf("last_commit_date is empty; the cached activity is the zero placeholder again")
	}
	if act.ActiveDays < 1 || act.CommitRate30d < 1 {
		t.Errorf("windowed metrics must not be zero for a commit made today: days=%d rate30=%d",
			act.ActiveDays, act.CommitRate30d)
	}
	if want := time.Now().Format("2006-01-02"); act.LastCommitDate != want {
		t.Errorf("last_commit_date = %q, want today %q", act.LastCommitDate, want)
	}
}
