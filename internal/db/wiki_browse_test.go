package db

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// The visibility rules of the browse surface (ADR-0032 决策 3).
//
// They are the evidence path's rules, not the review queue's: a project scope
// means "that project's pages PLUS the global ones", and only approved pages
// are visible at all.
//
// The third test is the one that cannot be written any other way: it fails if
// the scope filter is applied in Go AFTER the LIMIT, because a foreign page
// then takes the slot the visible page needed. That is the whole reason the
// predicate lives in SQL.

func browseDB(t *testing.T) *sql.DB {
	t.Helper()
	database, err := InitDB(filepath.Join(t.TempDir(), "browse.db"))
	if err != nil {
		t.Fatalf("init db: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	return database
}

func browsePage(t *testing.T, database *sql.DB, kind, slug string, projectID int64, content, status string) *WikiPage {
	t.Helper()
	page, err := CreateWikiPageAs(database, kind, slug, slug, projectID, content, status, "manual")
	if err != nil {
		t.Fatal(err)
	}
	return page
}

// A project scope sees its own pages and the global ones, and nothing else.
func TestSearchWikiPages_ProjectScopeSeesOwnAndGlobalPagesOnly(t *testing.T) {
	database := browseDB(t)
	mine := scopeProject(t, database, "mine")
	other := scopeProject(t, database, "other")

	browsePage(t, database, WikiKindConcept, "scoped-token", mine, "scoped token here", WikiStatusApproved)
	browsePage(t, database, WikiKindConcept, "global-token", 0, "scoped token here", WikiStatusApproved)
	browsePage(t, database, WikiKindConcept, "foreign-token", other, "scoped token here", WikiStatusApproved)

	hits, err := SearchWikiPages(database, "scoped", mine, 10)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, p := range hits {
		seen[p.Slug] = true
	}
	if !seen["scoped-token"] {
		t.Error("the project's own page must be visible in its own scope")
	}
	if !seen["global-token"] {
		t.Error("a global page must be visible from every project (ADR-0031 事实三)")
	}
	if seen["foreign-token"] {
		t.Error("another project's page must not be visible")
	}
}

// The same scope holds for the browse list — it is the same visibility, not a
// second definition of it.
func TestListVisibleApprovedPages_AppliesTheSameScope(t *testing.T) {
	database := browseDB(t)
	mine := scopeProject(t, database, "mine")
	other := scopeProject(t, database, "other")

	browsePage(t, database, WikiKindConcept, "mine-page", mine, "body", WikiStatusApproved)
	browsePage(t, database, WikiKindConcept, "global-page", 0, "body", WikiStatusApproved)
	browsePage(t, database, WikiKindConcept, "other-page", other, "body", WikiStatusApproved)
	browsePage(t, database, WikiKindConcept, "pending-page", mine, "body", WikiStatusPending)

	pages, err := ListVisibleApprovedPages(database, mine, 100)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, p := range pages {
		seen[p.Slug] = true
	}
	if !seen["mine-page"] || !seen["global-page"] {
		t.Errorf("scope lost a visible page: %v", seen)
	}
	if seen["other-page"] {
		t.Error("another project's page leaked into the scope")
	}
	if seen["pending-page"] {
		t.Error("a pending page must not be readable — the gate decides what may be READ too")
	}
}

// The scope filter must run BEFORE the limit. A foreign page that outranks the
// visible one must not take the only slot.
func TestSearchWikiPages_ScopeIsAppliedBeforeTheLimit(t *testing.T) {
	database := browseDB(t)
	mine := scopeProject(t, database, "mine")
	other := scopeProject(t, database, "other")

	browsePage(t, database, WikiKindConcept, "foreign-page", other, "shared phrase", WikiStatusApproved)
	browsePage(t, database, WikiKindConcept, "mine-page", mine, "shared phrase", WikiStatusApproved)

	hits, err := SearchWikiPages(database, "shared", mine, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 {
		t.Fatalf("got %d hits, want 1", len(hits))
	}
	if hits[0].Slug != "mine-page" {
		t.Errorf("hit = %q — the foreign page took the LIMIT slot, so the scope is applied after the limit", hits[0].Slug)
	}
}

// A 2-character CJK query is below the trigram width, so the FTS index cannot
// match it — but the page carrying the term exists. Returning nothing here
// would tell the reader "this knowledge does not exist", which is the one
// interpretation a local knowledge base must never produce.
func TestSearchWikiPages_ShortCJKQueryFallsBackToLike(t *testing.T) {
	database := browseDB(t)
	mine := scopeProject(t, database, "mine")

	browsePage(t, database, WikiKindConcept, "temporal", mine, "时态图机制：快照表", WikiStatusApproved)

	hits, err := SearchWikiPages(database, "时态", mine, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 || hits[0].Slug != "temporal" {
		t.Fatalf("hits = %v — a 2-character CJK query must still find the page", hits)
	}
}

// The fallback finds matches; it must not widen visibility. A pending page and
// another project's page both stay invisible on the short-query path.
func TestSearchWikiPages_LikeFallbackKeepsApprovalAndScope(t *testing.T) {
	database := browseDB(t)
	mine := scopeProject(t, database, "mine")
	other := scopeProject(t, database, "other")

	browsePage(t, database, WikiKindConcept, "mine-page", mine, "时态", WikiStatusApproved)
	browsePage(t, database, WikiKindConcept, "pending-page", mine, "时态", WikiStatusPending)
	browsePage(t, database, WikiKindConcept, "foreign-page", other, "时态", WikiStatusApproved)

	hits, err := SearchWikiPages(database, "时态", mine, 10)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, p := range hits {
		seen[p.Slug] = true
	}
	if !seen["mine-page"] {
		t.Error("the project's own page must be visible")
	}
	if seen["pending-page"] {
		t.Error("a pending page must not be readable on the fallback path either")
	}
	if seen["foreign-page"] {
		t.Error("another project's page must not be visible on the fallback path either")
	}
}

// A punctuated Chinese question must still find the page.
//
// The question mark is not a CJK rune, so the term used to fail the CJK test
// and be emitted as one unmatchable phrase — the browse surface answered
// "nothing matched" for a question the library could plainly answer, and the
// evidence path found no sources for it either.
func TestSearchWikiPages_PunctuatedCJKQuestionFindsPage(t *testing.T) {
	database := browseDB(t)
	mine := scopeProject(t, database, "mine")

	browsePage(t, database, WikiKindConcept, "temporal", mine, "时态图机制：快照表", WikiStatusApproved)

	hits, err := SearchWikiPages(database, "时态图是什么？", mine, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 || hits[0].Slug != "temporal" {
		t.Fatalf("hits = %v — a punctuated Chinese question must still find the page", hits)
	}
}

// A multi-word query whose terms are all below the trigram width cannot match
// as one contiguous substring, so the fallback retries with the terms OR-ed —
// the same relaxation the notes path does.
func TestSearchWikiPages_LikeFallbackRetriesWithTermsOred(t *testing.T) {
	database := browseDB(t)

	browsePage(t, database, WikiKindConcept, "temporal", 0, "时态", WikiStatusApproved)

	hits, err := SearchWikiPages(database, "时态 快照", 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 || hits[0].Slug != "temporal" {
		t.Fatalf("hits = %v — the terms must be retried OR-ed", hits)
	}
}
