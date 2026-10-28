package service

import (
	"testing"

	"repotory/internal/db"
)

// Reading the approved knowledge layer (ADR-0032).
//
// The properties worth pinning:
//
//  1. only approved pages are readable — the gate decides what may be READ,
//     not only what may be cited;
//  2. the project scope is the evidence path's scope (own pages + global);
//  3. reading a page is not using it: access_count keeps meaning "surfaced
//     into an answer's evidence", so browsing must leave it alone;
//  4. the detail carries the graph around the page, not just its body.

func browseService(t *testing.T) (*Service, int64) {
	t.Helper()
	svc, _ := setupService(t)
	pid := seedProject(t, svc.db, "browse-project", "/tmp/browse-project")
	return svc, pid
}

func browsePage(t *testing.T, svc *Service, kind, slug string, projectID int64, content, status string) *db.WikiPage {
	t.Helper()
	page, err := db.CreateWikiPageAs(svc.db, kind, slug, slug, projectID, content, status, "manual")
	if err != nil {
		t.Fatal(err)
	}
	return page
}

// The feed lists approved pages and hides the rest.
func TestBrowseWikiPages_ListsOnlyApprovedPages(t *testing.T) {
	svc, pid := browseService(t)
	browsePage(t, svc, db.WikiKindConcept, "approved-page", pid, "body", db.WikiStatusApproved)
	browsePage(t, svc, db.WikiKindConcept, "pending-page", pid, "body", db.WikiStatusPending)
	browsePage(t, svc, db.WikiKindConcept, "rejected-page", pid, "body", db.WikiStatusRejected)

	pages, err := svc.BrowseWikiPages(pid, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(pages) != 1 {
		t.Fatalf("got %d pages, want 1 (only the approved one)", len(pages))
	}
	if pages[0].Slug != "approved-page" {
		t.Errorf("slug = %q, want approved-page", pages[0].Slug)
	}
}

// The scope is the evidence path's: the project's own pages plus the global
// ones. The global page must be visibly global — the UI has to be able to
// label it, and it can only do that if the summary says so.
func TestBrowseWikiPages_ProjectScopeKeepsGlobalPagesVisible(t *testing.T) {
	svc, pid := browseService(t)
	other := seedProject(t, svc.db, "other-browse-project", "/tmp/other-browse-project")
	browsePage(t, svc, db.WikiKindConcept, "own-page", pid, "body", db.WikiStatusApproved)
	browsePage(t, svc, db.WikiKindConcept, "global-page", 0, "body", db.WikiStatusApproved)
	browsePage(t, svc, db.WikiKindConcept, "foreign-page", other, "body", db.WikiStatusApproved)

	pages, err := svc.BrowseWikiPages(pid, 0)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]int64{}
	for _, p := range pages {
		seen[p.Slug] = p.ProjectID
	}
	if _, ok := seen["own-page"]; !ok {
		t.Error("the project's own page is missing from its scope")
	}
	projectID, ok := seen["global-page"]
	if !ok {
		t.Fatal("a global page must be visible from every project")
	}
	if projectID != 0 {
		t.Errorf("global page ProjectID = %d, want 0 — the UI cannot label what it cannot see", projectID)
	}
	if _, ok := seen["foreign-page"]; ok {
		t.Error("another project's page leaked into the scope")
	}
}

// A pending page is not readable through this surface. Copying the gate's
// output into a second screen would blur "to be judged" and "published".
func TestGetWikiPage_RefusesUnapprovedPages(t *testing.T) {
	svc, pid := browseService(t)
	pending := browsePage(t, svc, db.WikiKindConcept, "pending-page", pid, "body", db.WikiStatusPending)

	if _, err := svc.GetWikiPage(pending.ID); err == nil {
		t.Fatal("expected an error for a pending page")
	}
}

// Reading a page is not using it. access_count means "surfaced into an
// answer's evidence" (schema v26); a human opening a page is another kind of
// visit, and mixing them would make one column carry two meanings.
func TestBrowsingDoesNotCountAsAccess(t *testing.T) {
	svc, pid := browseService(t)
	page := browsePage(t, svc, db.WikiKindConcept, "read-page", pid, "the body of the page", db.WikiStatusApproved)

	if _, err := svc.BrowseWikiPages(pid, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SearchWikiPages(pid, "body", 0); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.GetWikiPage(page.ID); err != nil {
		t.Fatal(err)
	}

	got, err := db.GetWikiPageByID(svc.db, page.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.AccessCount != 0 {
		t.Errorf("access_count = %d after browsing, want 0 — browsing is not answering", got.AccessCount)
	}
}

// The detail carries the graph around the page: what it links to, what links
// to it, and which notes it was compiled from.
func TestGetWikiPage_CarriesEdgesAndSourceNotes(t *testing.T) {
	svc, pid := browseService(t)
	target := browsePage(t, svc, db.WikiKindConcept, "target-page", pid, "target body", db.WikiStatusApproved)
	source := browsePage(t, svc, db.WikiKindConcept, "source-page", pid, "source body", db.WikiStatusApproved)
	if err := db.LinkWikiPages(svc.db, source.ID, target.ID, db.RelationRef); err != nil {
		t.Fatal(err)
	}
	note, err := db.CreateNoteEx(svc.db, pid, "Origin note", "note body", "", "knowledge", "manual")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AttachNoteToPage(svc.db, note.ID, target.ID); err != nil {
		t.Fatal(err)
	}

	detail, err := svc.GetWikiPage(target.ID)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Content != "target body" {
		t.Errorf("content = %q, want the page body", detail.Content)
	}
	if len(detail.InLinks) != 1 || detail.InLinks[0].Slug != "source-page" {
		t.Errorf("in-links = %+v, want the page that links here", detail.InLinks)
	}
	if len(detail.OutLinks) != 0 {
		t.Errorf("out-links = %+v, want none", detail.OutLinks)
	}
	if len(detail.SourceNoteIDs) != 1 || detail.SourceNoteIDs[0] != note.ID {
		t.Errorf("source notes = %v, want [%d]", detail.SourceNoteIDs, note.ID)
	}
}
