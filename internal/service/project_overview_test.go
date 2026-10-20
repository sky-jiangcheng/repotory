package service

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestGetProjectOverview_EmptyArraysNotNil guards against a regression where
// GetProjectOverview returned nil (not empty) slices for recent_commits,
// dependencies and top_contributors. A nil slice marshals to JSON `null`, and
// the project detail page read `overview.recent_commits.length` directly,
// throwing "e.recent_commits is null" and crashing the whole page.
func TestGetProjectOverview_EmptyArraysNotNil(t *testing.T) {
	svc, fg := setupService(t)
	pid := seedProject(t, svc.db, "proj", "/tmp/proj")

	ov, err := svc.GetProjectOverview(pid)
	if err != nil {
		t.Fatalf("GetProjectOverview: %v", err)
	}

	// The recent-commits section feeds the copied AI context: it must carry the
	// repos' latest commits, not only the "mine" author's (see service_test.go
	// fakeGit for the blanking defect this pins).
	if fg.recentCommitsAuthor != "" {
		t.Errorf("recent commits queried with author filter %q; want none (repo-wide)", fg.recentCommitsAuthor)
	}

	if ov.TechStack == nil {
		t.Errorf("TechStack should be non-nil empty slice, got nil")
	}
	if ov.Languages == nil {
		t.Errorf("Languages should be non-nil empty slice, got nil")
	}
	if ov.Dependencies == nil {
		t.Errorf("Dependencies should be non-nil empty slice, got nil")
	}
	if ov.TopContributors == nil {
		t.Errorf("TopContributors should be non-nil empty slice, got nil")
	}
	if ov.RecentCommits == nil {
		t.Errorf("RecentCommits should be non-nil empty slice, got nil")
	}

	// And they must JSON-encode as [] rather than null.
	b, err := json.Marshal(ov)
	if err != nil {
		t.Fatalf("marshal overview: %v", err)
	}
	s := string(b)
	for _, f := range []string{"tech_stack", "languages", "dependencies", "top_contributors", "recent_commits"} {
		if strings.Contains(s, `"`+f+`":null`) {
			t.Errorf("overview JSON contains null array field %q: %s", f, s)
		}
	}
}
