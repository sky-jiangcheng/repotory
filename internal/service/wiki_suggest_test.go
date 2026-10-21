package service

import (
	"testing"

	"repotory/internal/db"
)

func TestSuggestWikiLinks(t *testing.T) {
	svc, _ := setupService(t)
	pid := seedProject(t, svc.db, "testproj", "/tmp/testproj")

	// Seed approved pages
	p1, err := db.CreateWikiPage(svc.db, db.WikiKindEntity, "payment-gateway", "Payment Gateway", pid, "body")
	if err != nil {
		t.Fatal(err)
	}

	p2, err := db.CreateWikiPage(svc.db, db.WikiKindConcept, "retry-policy", "Retry Policy", pid, "body")
	if err != nil {
		t.Fatal(err)
	}

	// Case 1: mentions Payment Gateway without link
	text1 := "This service communicates with the Payment Gateway to charge customers."
	sug1 := svc.SuggestWikiLinks(0, text1)
	if len(sug1) != 1 || sug1[0].PageID != p1.ID {
		t.Fatalf("expected suggestion for p1, got %+v", sug1)
	}

	// Case 2: mentions both, but one is already [[wikilink]]
	text2 := "Using [[payment-gateway]] together with Retry Policy for resiliency."
	sug2 := svc.SuggestWikiLinks(0, text2)
	if len(sug2) != 1 || sug2[0].PageID != p2.ID {
		t.Fatalf("expected suggestion for p2 only (since p1 is linked), got %+v", sug2)
	}

	// Case 3: empty text
	if len(svc.SuggestWikiLinks(0, "")) != 0 {
		t.Fatal("expected empty suggestion for empty text")
	}
}
