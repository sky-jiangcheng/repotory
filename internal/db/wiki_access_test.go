package db

import (
	"testing"
	"time"
)

// The access reinforcement columns (schema v26) and their throttle: one bump
// per page per minute window, counting from the FIRST touch. An untouched page
// reads as never-used, which is the honest default the migration ships.
func TestTouchWikiPagesThrottles(t *testing.T) {
	database, err := InitDB(":memory:")
	if err != nil {
		t.Fatalf("init db: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })

	p, err := CreateWikiPage(database, WikiKindEntity, "touch-throttle", "触摸限流", 0, "内容正文")
	if err != nil {
		t.Fatalf("create page: %v", err)
	}

	// Pre-touch truth: never used.
	if p.AccessCount != 0 || p.LastAccessedAt != "" {
		t.Fatalf("fresh page reports access_count=%d last=%q; want 0/empty", p.AccessCount, p.LastAccessedAt)
	}

	now := time.Now()
	if n, err := TouchWikiPages(database, []int64{p.ID}, now); err != nil || n != 1 {
		t.Fatalf("first touch = %d bumps (err %v); want 1", n, err)
	}

	// Inside the minute window: throttled to a no-op.
	if n, err := TouchWikiPages(database, []int64{p.ID}, now.Add(30*time.Second)); err != nil || n != 0 {
		t.Fatalf("second touch within the window = %d bumps (err %v); want 0", n, err)
	}

	// Past the window: the reinforcement lands again.
	if n, err := TouchWikiPages(database, []int64{p.ID}, now.Add(61*time.Second)); err != nil || n != 1 {
		t.Fatalf("touch past the window = %d bumps (err %v); want 1", n, err)
	}

	var count int64
	var last string
	if err := database.QueryRow(`SELECT access_count, COALESCE(last_accessed_at, '') FROM wiki_pages WHERE id = ?`, p.ID).
		Scan(&count, &last); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if count != 2 {
		t.Fatalf("access_count = %d; want 2 (two windows, one throttled no-op)", count)
	}
	if last == "" {
		t.Fatal("last_accessed_at never stamped")
	}
	if _, err := time.Parse(time.RFC3339, last); err != nil {
		t.Fatalf("last_accessed_at = %q is not RFC3339: %v", last, err)
	}
}
