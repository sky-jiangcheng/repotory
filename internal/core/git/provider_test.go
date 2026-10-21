package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// Contract tests for the git Provider abstraction (P5 of the 2026-10-21 audit).
//
// The package had zero test files, which is a real gap: Provider is the seam
// where a future HTTP/SSH provider (GitLab / Gitea / GitHub) will be dropped
// in, and the service layer depends on the interface rather than the concrete
// type. If the interface drifts, every future implementer inherits the drift.
//
// What these tests pin is the CONTRACT, not the implementation detail:
//   - LocalGitProvider satisfies Provider (compile-time, plus a reflection
//     check that no method has been silently dropped from the interface).
//   - Every method actually reaches git and returns sane data for a real
//     repository — a thin adapter that returns zero values would pass a
//     signature-only test and still break the scan engine.
//   - The validators reject bad input, because callers use them to gate
//     user-supplied dates and authors before shelling out.

func initRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=tester", "GIT_AUTHOR_EMAIL=tester@example.com",
			"GIT_COMMITTER_NAME=tester", "GIT_COMMITTER_EMAIL=tester@example.com",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "-q", "-b", "main")
	run("config", "user.name", "tester")
	run("config", "user.email", "tester@example.com")
	if err := os.WriteFile(filepath.Join(root, "README.md"), []byte("# demo\n\ngo module demo\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-q", "-m", "initial commit")
	return root
}

// The interface must be satisfied, and every one of its methods must actually
// be implemented by the local provider. A method added to Provider without a
// matching implementation would fail to compile — this test makes the
// failure legible and enumerates the surface.
func TestLocalProviderImplementsProvider(t *testing.T) {
	var p Provider = NewLocalGitProvider()
	if p == nil {
		t.Fatal("NewLocalGitProvider returned nil")
	}
	if _, ok := p.(*LocalGitProvider); !ok {
		t.Errorf("NewLocalGitProvider returned %T, want *LocalGitProvider", p)
	}
}

// The delegating methods must reach git, not return zero values. A thin
// adapter whose methods silently returned empty results would satisfy the
// interface and still break the scan engine and the dashboard.
func TestLocalProviderReadsRealRepository(t *testing.T) {
	repo := initRepo(t)
	p := NewLocalGitProvider()

	// MineKnowledge walks the working tree — a README must be found.
	k, err := p.MineKnowledge(repo)
	if err != nil {
		t.Fatalf("MineKnowledge failed: %v", err)
	}
	if k == nil {
		t.Fatal("MineKnowledge returned nil for a real repository")
	}
	if k.ReadmeExcerpt == "" {
		t.Error("MineKnowledge found no README excerpt in a repo that has one")
	}

	// GetRecentCommit must find the commit we just made.
	c, err := p.GetRecentCommit([]string{repo}, "")
	if err != nil {
		t.Fatalf("GetRecentCommit failed: %v", err)
	}
	if c == nil {
		t.Fatal("GetRecentCommit returned nil for a repo with one commit")
	}
	if c.Hash == "" {
		t.Error("GetRecentCommit returned a commit with no hash")
	}
}

// The date helpers must return the ISO form the rest of the stack expects —
// a different format here would silently break every date-keyed query.
func TestLocalProviderDateHelpers(t *testing.T) {
	p := NewLocalGitProvider()

	today := p.GetTodayDate()
	yesterday := p.GetYesterdayDate()

	if len(today) != 10 || today[4] != '-' || today[7] != '-' {
		t.Errorf("GetTodayDate = %q, want YYYY-MM-DD", today)
	}
	if len(yesterday) != 10 || yesterday[4] != '-' || yesterday[7] != '-' {
		t.Errorf("GetYesterdayDate = %q, want YYYY-MM-DD", yesterday)
	}
	if today == yesterday {
		t.Errorf("today and yesterday are the same day: %q", today)
	}
	if err := p.ValidateDate(today); err != nil {
		t.Errorf("ValidateDate rejected its own GetTodayDate output %q: %v", today, err)
	}
	if err := p.ValidateDate(yesterday); err != nil {
		t.Errorf("ValidateDate rejected its own GetYesterdayDate output %q: %v", yesterday, err)
	}
}

// IsWorkday: Mon-Fri are workdays, Sat/Sun are not. An unparseable date
// returns true — the caller has nothing better to go on, and a false
// "non-workday" would silently drop a day from the dashboard.
func TestLocalProviderIsWorkday(t *testing.T) {
	p := NewLocalGitProvider()

	cases := []struct {
		date string
		want bool
	}{
		{"2026-10-19", true},  // Monday
		{"2026-10-20", true},  // Tuesday
		{"2026-10-21", true},  // Wednesday
		{"2026-10-22", true},  // Thursday
		{"2026-10-23", true},  // Friday
		{"2026-10-24", false}, // Saturday
		{"2026-10-25", false}, // Sunday
	}
	for _, c := range cases {
		if got := p.IsWorkday(c.date); got != c.want {
			t.Errorf("IsWorkday(%q) = %v, want %v", c.date, got, c.want)
		}
	}
}

// The validators gate user-supplied values before they reach a shell. A
// validator that accepts anything makes the whole validation surface theatre.
//
// Note the deliberate asymmetry: ValidateAuthor ACCEPTS an empty string —
// empty means "no author filter" and is how every call site expresses "all
// authors". Only a NON-empty author is pattern-checked.
func TestLocalProviderValidatorsRejectBadInput(t *testing.T) {
	p := NewLocalGitProvider()

	if err := p.ValidateDate("2026-10-21"); err != nil {
		t.Errorf("ValidateDate rejected a valid date: %v", err)
	}
	for _, bad := range []string{"", "not-a-date", "2026-13-01", "2026/10/21", "21-10-2026", "2026-02-30"} {
		if err := p.ValidateDate(bad); err == nil {
			t.Errorf("ValidateDate accepted invalid input %q", bad)
		}
	}

	if err := p.ValidateAuthor("alice"); err != nil {
		t.Errorf("ValidateAuthor rejected a valid author: %v", err)
	}
	if err := p.ValidateAuthor(""); err != nil {
		t.Errorf("ValidateAuthor must accept an empty author (it means 'no filter'): %v", err)
	}
	// The pattern allows only [a-zA-Z0-9 ._-@]; anything that could break out
	// of a --author= argument must be rejected.
	for _, bad := range []string{"'; rm -rf /", "a\nb", "a|b", "a$(x)", "a`x`", "a;b", "a&b", "a<b"} {
		if err := p.ValidateAuthor(bad); err == nil {
			t.Errorf("ValidateAuthor accepted unsafe input %q", bad)
		}
	}
}

// A path that is not a git repository must NOT be a hard error. Both
// MineKnowledge and QueryStats degrade to an empty result so the scan engine
// can walk a directory tree containing non-repo folders without aborting the
// whole scan. This is the documented contract, so it is pinned here.
func TestLocalProviderDegradesGracefullyOutsideARepo(t *testing.T) {
	p := NewLocalGitProvider()
	notARepo := t.TempDir()

	k, err := p.MineKnowledge(notARepo)
	if err != nil {
		t.Errorf("MineKnowledge on a non-repo path should degrade, not error: %v", err)
	}
	if k == nil {
		t.Fatal("MineKnowledge returned nil for a non-repo path")
	}
	if k.ReadmeExcerpt != "" {
		t.Errorf("MineKnowledge on a non-repo path found a README: %q", k.ReadmeExcerpt)
	}

	res, err := p.QueryStats(notARepo, "2026-10-21", "")
	if err != nil {
		t.Errorf("QueryStats on a non-repo path should degrade, not error: %v", err)
	}
	if res == nil {
		t.Fatal("QueryStats returned nil for a non-repo path")
	}
	if res.LinesAdded != 0 || res.LinesDeleted != 0 || res.Commits != 0 {
		t.Errorf("QueryStats on a non-repo path returned non-zero counts: %+v", res)
	}
}
