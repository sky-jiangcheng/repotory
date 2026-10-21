package memsrc

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"repotory/internal/db"
)

// Direct tests for the shared importer helpers (P5 of the 2026-10-21 audit).
//
// These functions are the shared half of all six built-in memory importers
// (claude / codex / cursor / hermes / openclaw / opencode). They were covered
// only indirectly — each importer's own test exercised them on the way
// through, so a behaviour change in a helper could be masked by whichever
// importer happened to cover it. That is the "cannot drift apart across
// sources" promise the package doc makes, and it was not machine-checked.
//
// The cases below pin the specific behaviours the importers depend on:
// the project-match precedence ladder, the byte cap that must not error on
// oversized files, frontmatter stripping, and the config-driven target
// resolution whose "unknown -> 0" fallback is what keeps a misconfigured
// source from scattering notes across the wrong projects.

func int64Ptr(v int64) *int64 { return &v }

// MatchProject's precedence ladder: exact name, then repository path suffix,
// then containment. Order matters — containment is the loosest and must not
// win over an exact match.
func TestMatchProjectPrecedence(t *testing.T) {
	projects := []db.Project{
		{ID: 1, Name: "alpha"},
		{ID: 2, Name: "alpha-extra"},
	}
	repos := []db.Repository{
		{ID: 10, Path: "/Users/me/code/beta", ProjectID: int64Ptr(3)},
		{ID: 11, Path: "/Users/me/code/beta.git", ProjectID: int64Ptr(4)},
	}

	cases := []struct {
		name    string
		display string
		want    int64
	}{
		{"exact name wins over containment", "alpha", 1},
		{"containment fallback", "alpha-extra", 2},
		{"repo path suffix matches", "beta", 3},
		{"a .git repo path matches its own display name", "beta.git", 4},
		{"no match returns 0", "gamma", 0},
		{"empty display name returns 0", "", 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := MatchProject(c.display, projects, repos)
			if got != c.want {
				t.Errorf("MatchProject(%q) = %d, want %d", c.display, got, c.want)
			}
		})
	}
}

// A repository with no owning project must not be matched at all — returning
// 0 there is correct, but the importer must not be handed a stale id.
func TestMatchProjectSkipsRepoWithoutOwner(t *testing.T) {
	repos := []db.Repository{{ID: 10, Path: "/Users/me/code/beta", ProjectID: nil}}
	if got := MatchProject("beta", nil, repos); got != 0 {
		t.Errorf("MatchProject on an unowned repo = %d, want 0", got)
	}
}

// The repo-suffix match is case-insensitive on both sides; the exact-name
// match is case-SENSITIVE (project names are user-facing labels, not keys),
// but the containment fallback is case-INsensitive — so an uppercase query
// for "alpha" against a project named "Alpha" lands on the containment rung.
func TestMatchProjectCaseHandling(t *testing.T) {
	projects := []db.Project{{ID: 1, Name: "Alpha"}}
	repos := []db.Repository{{ID: 10, Path: "/Users/me/code/Beta", ProjectID: int64Ptr(3)}}

	if got := MatchProject("alpha", projects, repos); got != 1 {
		t.Errorf("lowercase query against 'Alpha' = %d, want 1 (containment is case-insensitive)", got)
	}
	if got := MatchProject("beta", nil, repos); got != 3 {
		t.Errorf("lowercase query against repo path 'Beta' = %d, want 3 (suffix is case-insensitive)", got)
	}
	// The exact-name rung is case-sensitive: "ALPHA" is not "Alpha", so the
	// match falls through to containment rather than the exact rung.
	if got := MatchProject("ALPHA", projects, repos); got != 1 {
		t.Errorf("'ALPHA' should not hit the case-sensitive exact rung, but must still "+
			"land via containment: got %d, want 1", got)
	}
}

// ReadCapped must return exactly limit bytes with NO error for an oversized
// file — that is what lets an importer skip a multi-GB transcript with a clear
// message instead of loading it.
func TestReadCappedTruncatesWithoutError(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "big.txt")
	if err := os.WriteFile(path, []byte(strings.Repeat("x", 5000)), 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := ReadCapped(path, 100)
	if err != nil {
		t.Fatalf("ReadCapped on an oversized file returned an error: %v", err)
	}
	if len(got) != 100 {
		t.Errorf("got %d bytes, want exactly 100", len(got))
	}
}

// A file under the cap comes back whole.
func TestReadCappedReadsSmallFileWhole(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "small.txt")
	content := "hello world"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := ReadCapped(path, 100)
	if err != nil {
		t.Fatalf("ReadCapped failed: %v", err)
	}
	if string(got) != content {
		t.Errorf("got %q, want %q", got, content)
	}
}

// A missing file must error — the importer needs to distinguish "unreadable"
// from "oversized".
func TestReadCappedMissingFileErrors(t *testing.T) {
	if _, err := ReadCapped(filepath.Join(t.TempDir(), "nope.txt"), 100); err == nil {
		t.Error("expected an error for a missing file")
	}
}

// LastPathSegment: trailing slashes trimmed, empty input returns "".
func TestLastPathSegment(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"/Users/me/Workspace/Foo", "Foo"},
		{"/Users/me/Workspace/Foo/", "Foo"},
		{"/Users/me/Workspace/Foo///", "Foo"},
		{"Foo", "Foo"},
		{"", ""},
		{"/", ""},
	}
	for _, c := range cases {
		if got := LastPathSegment(c.in); got != c.want {
			t.Errorf("LastPathSegment(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// StripFrontmatter: the block is removed, the body survives, and input
// WITHOUT frontmatter comes back trimmed rather than mangled.
func TestStripFrontmatter(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "removes block and keeps body",
			in:   "---\ntitle: x\n---\nbody line",
			want: "body line",
		},
		{
			name: "no frontmatter returns trimmed input",
			in:   "  just body  ",
			want: "just body",
		},
		{
			name: "frontmatter only, empty body",
			in:   "---\ntitle: x\n---\n",
			want: "",
		},
		{
			name: "unterminated frontmatter keeps the remainder",
			in:   "---\ntitle: x\nbody line",
			want: "title: x\nbody line",
		},
		{
			name: "a body line that merely starts with --- is not frontmatter",
			in:   "intro\n---\nnot frontmatter",
			want: "intro\n---\nnot frontmatter",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := StripFrontmatter(c.in); got != c.want {
				t.Errorf("StripFrontmatter = %q, want %q", got, c.want)
			}
		})
	}
}

// TargetProject resolves a config value naming a project by NAME or by
// NUMERIC ID. Every unknown / empty / malformed case must fall back to 0 —
// that fallback is the whole point: "a misconfigured source therefore lands
// nowhere rather than scattering notes across the wrong projects".
func TestTargetProjectResolution(t *testing.T) {
	database, err := db.InitDB(":memory:")
	if err != nil {
		t.Fatalf("failed to init db: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	tx, err := database.Begin()
	if err != nil {
		t.Fatalf("failed to begin tx: %v", err)
	}
	if _, err := db.SyncProjectTx(tx, "my-project", "/tmp/my-project", 0, true); err != nil {
		t.Fatalf("failed to seed project: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("failed to commit: %v", err)
	}

	projects, err := db.GetAllProjects(database)
	if err != nil {
		t.Fatalf("failed to read projects: %v", err)
	}
	if len(projects) == 0 {
		t.Fatal("expected at least one seeded project")
	}
	seeded := projects[0]

	cases := []struct {
		name  string
		value string
		want  int64
	}{
		{"numeric id resolves directly", "42", 42},
		{"exact project name resolves", "my-project", seeded.ID},
		{"unknown name falls back to 0", "no-such-project", 0},
		{"empty value falls back to 0", "", 0},
		{"whitespace-only value falls back to 0", "   ", 0},
		{"non-numeric garbage falls back to 0", "abc-123", 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if err := db.SetConfig(database, "memsrc_test_key", c.value); err != nil {
				t.Fatalf("failed to set config: %v", err)
			}
			if got := TargetProject(database, "memsrc_test_key"); got != c.want {
				t.Errorf("TargetProject(%q) = %d, want %d", c.value, got, c.want)
			}
		})
	}
}

// An unset config key must resolve to 0 rather than error.
func TestTargetProjectUnsetKeyIsZero(t *testing.T) {
	database, err := db.InitDB(":memory:")
	if err != nil {
		t.Fatalf("failed to init db: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	if got := TargetProject(database, "memsrc_never_set_key"); got != 0 {
		t.Errorf("TargetProject on an unset key = %d, want 0", got)
	}
}
