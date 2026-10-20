package stats

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// initRepoWithCommit creates a git repository holding exactly one commit dated
// `date` (RFC3399), so "newest" is deterministic without sleeping.
func initRepoWithCommit(t *testing.T, dir, date, msg string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	// Identity is pinned via env because GIT_AUTHOR_NAME/GIT_COMMITTER_NAME
	// outrank `-c user.name`, and some agent harnesses export them process-wide
	// (observed: GIT_AUTHOR_NAME=zwork) — with that leak, `--author=Tester`
	// matched nothing and the author-filter test failed deterministically while
	// passing on developer machines. Strip every ambient GIT_* first so our
	// values cannot collide with an earlier duplicate in the environ slice.
	clean := make([]string, 0, len(os.Environ()))
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(kv, "GIT_") {
			clean = append(clean, kv)
		}
	}
	env := append(clean,
		"GIT_AUTHOR_NAME=Tester", "GIT_AUTHOR_EMAIL=tester@example.invalid",
		"GIT_COMMITTER_NAME=Tester", "GIT_COMMITTER_EMAIL=tester@example.invalid",
		"GIT_AUTHOR_DATE="+date, "GIT_COMMITTER_DATE="+date,
		// Isolate from the developer's global config and hooks.
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
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte(msg), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	run("add", "f.txt")
	run("-c", "user.name=Tester", "-c", "user.email=tester@example.invalid",
		"commit", "-m", msg)
}

// The concurrent fan-out must still return the single newest commit across repos,
// which is the whole point of the status bar.
func TestGetRecentCommitPicksNewestAcrossRepos(t *testing.T) {
	base := t.TempDir()
	older := filepath.Join(base, "older")
	newer := filepath.Join(base, "newer")
	initRepoWithCommit(t, older, "2026-01-02T10:00:00", "older commit")
	initRepoWithCommit(t, newer, "2026-03-04T10:00:00", "newer commit")

	got, err := GetRecentCommit([]string{older, newer}, "")
	if err != nil {
		t.Fatalf("GetRecentCommit: %v", err)
	}
	if got == nil {
		t.Fatal("got nil, want the newer commit")
	}
	if got.Message != "newer commit" {
		t.Errorf("message = %q, want the newer commit (order of the input must not matter)", got.Message)
	}
	if got.Repo != newer {
		t.Errorf("repo = %q, want %q", got.Repo, newer)
	}
	if got.Hash == "" || got.Branch == "" {
		t.Errorf("hash/branch must be populated, got %q / %q", got.Hash, got.Branch)
	}

	// Reversing the input must not change the answer (goroutine completion order
	// used to be irrelevant in the sequential loop; it is a real risk now).
	rev, err := GetRecentCommit([]string{newer, older}, "")
	if err != nil || rev == nil || rev.Message != "newer commit" {
		t.Errorf("reversed input: got %+v err %v, want the same newer commit", rev, err)
	}
}

// Scanned folders that are not git repositories are ordinary, and they arrive mixed
// into this list. They must be skipped inside the workers without failing the call —
// previously a failing repo was just `continue`d in the loop.
func TestGetRecentCommitToleratesNonRepos(t *testing.T) {
	base := t.TempDir()
	good := filepath.Join(base, "good")
	initRepoWithCommit(t, good, "2026-05-05T10:00:00", "real commit")
	junk := filepath.Join(base, "not-a-repo")
	if err := os.MkdirAll(junk, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	got, err := GetRecentCommit([]string{junk, good, filepath.Join(base, "missing")}, "")
	if err != nil {
		t.Fatalf("non-repo paths must not error the call: %v", err)
	}
	if got == nil || got.Message != "real commit" {
		t.Fatalf("got %+v, want the real commit past the junk entries", got)
	}
}

func TestGetRecentCommitAuthorFilterAndEmptyList(t *testing.T) {
	dir := t.TempDir()
	initRepoWithCommit(t, dir, "2026-06-06T10:00:00", "by tester")

	empty, err := GetRecentCommit(nil, "")
	if err != nil || empty != nil {
		t.Errorf("empty path list: got %+v, %v; want nil, nil", empty, err)
	}
	miss, err := GetRecentCommit([]string{dir}, "Nobody Else")
	if err != nil {
		t.Fatalf("filtered scan: %v", err)
	}
	if miss != nil {
		t.Errorf("non-matching author: got %+v, want nil", miss)
	}
	hit, err := GetRecentCommit([]string{dir}, "Tester")
	if err != nil || hit == nil {
		t.Fatalf("matching author should be found: %+v %v", hit, err)
	}
}
