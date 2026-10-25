package db

import (
	"testing"
)

func TestCreateTopicAndFileANote(t *testing.T) {
	database := setupTestDB(t)
	pid := createTestProject(t, database, "p")

	topic, err := CreateTopic(database, pid, "支付网关", "所有关于网关的笔记")
	if err != nil {
		t.Fatalf("CreateTopic: %v", err)
	}
	if topic.Name != "支付网关" {
		t.Errorf("name = %q, want %q", topic.Name, "支付网关")
	}

	note, err := CreateNoteEx(database, pid, "重试策略", "body", "", "knowledge", "manual")
	if err != nil {
		t.Fatalf("CreateNoteEx: %v", err)
	}
	if err := SetNoteTopic(database, note.ID, topic.ID); err != nil {
		t.Fatalf("SetNoteTopic: %v", err)
	}

	topics, err := ListTopics(database, pid)
	if err != nil {
		t.Fatalf("ListTopics: %v", err)
	}
	if len(topics) != 1 {
		t.Fatalf("got %d topics, want 1", len(topics))
	}
	if topics[0].NoteCount != 1 {
		t.Errorf("note count = %d, want 1", topics[0].NoteCount)
	}

	// The note now carries the topic id.
	fetched, err := GetNoteByID(database, note.ID)
	if err != nil {
		t.Fatalf("GetNoteByID: %v", err)
	}
	if fetched.TopicID != topic.ID {
		t.Errorf("note topic_id = %d, want %d", fetched.TopicID, topic.ID)
	}
}

func TestDeleteTopicKeepsItsNotes(t *testing.T) {
	database := setupTestDB(t)
	pid := createTestProject(t, database, "p")

	topic, err := CreateTopic(database, pid, "网关", "")
	if err != nil {
		t.Fatal(err)
	}
	note, err := CreateNoteEx(database, pid, "n", "body", "", "other", "manual")
	if err != nil {
		t.Fatal(err)
	}
	if err := SetNoteTopic(database, note.ID, topic.ID); err != nil {
		t.Fatal(err)
	}

	if err := DeleteTopic(database, topic.ID); err != nil {
		t.Fatalf("DeleteTopic: %v", err)
	}

	// The note survives — deleting a filing label must never destroy
	// knowledge — and falls back to "no topic".
	fetched, err := GetNoteByID(database, note.ID)
	if err != nil {
		t.Fatalf("the note was deleted along with its topic: %v", err)
	}
	if fetched.TopicID != 0 {
		t.Errorf("note topic_id = %d, want 0 after the topic was deleted", fetched.TopicID)
	}
}

func TestDeleteTopicCascadesWithItsProject(t *testing.T) {
	database := setupTestDB(t)
	pid := createTestProject(t, database, "p")

	topic, err := CreateTopic(database, pid, "网关", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec("DELETE FROM projects WHERE id = ?", pid); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := database.QueryRow("SELECT COUNT(*) FROM note_topics WHERE id = ?", topic.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Errorf("the topic survived its project: %d rows left", count)
	}
}

func TestSetNoteTopicRejectsATopicFromAnotherProject(t *testing.T) {
	database := setupTestDB(t)
	p1 := createTestProject(t, database, "one")
	p2 := createTestProject(t, database, "two")

	topic, err := CreateTopic(database, p2, "other project's topic", "")
	if err != nil {
		t.Fatal(err)
	}
	note, err := CreateNoteEx(database, p1, "n", "body", "", "other", "manual")
	if err != nil {
		t.Fatal(err)
	}

	if err := SetNoteTopic(database, note.ID, topic.ID); err == nil {
		t.Fatal("expected a topic from another project to be rejected")
	}
}

func TestCreateTopicRejectsADuplicateNameInTheSameProject(t *testing.T) {
	database := setupTestDB(t)
	pid := createTestProject(t, database, "p")

	if _, err := CreateTopic(database, pid, "网关", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateTopic(database, pid, "网关", ""); err == nil {
		t.Fatal("expected a duplicate topic name to be rejected")
	}
	// The same name in a DIFFERENT project is fine: a topic's meaning comes
	// from its project's context.
	p2 := createTestProject(t, database, "other")
	if _, err := CreateTopic(database, p2, "网关", ""); err != nil {
		t.Fatalf("the same name in another project must be allowed: %v", err)
	}
}

func TestNormalizeTopicNameCollapsesWhitespace(t *testing.T) {
	database := setupTestDB(t)
	pid := createTestProject(t, database, "p")

	topic, err := CreateTopic(database, pid, "  支付   网关  ", "")
	if err != nil {
		t.Fatal(err)
	}
	if topic.Name != "支付 网关" {
		t.Errorf("name = %q, want %q", topic.Name, "支付 网关")
	}
	// A differently-spaced spelling is the same topic, so it is a duplicate.
	if _, err := CreateTopic(database, pid, "支付  网关", ""); err == nil {
		t.Fatal("expected the differently-spaced duplicate to be rejected")
	}
}

func TestUpdateTopicRenamesInPlace(t *testing.T) {
	database := setupTestDB(t)
	pid := createTestProject(t, database, "p")

	topic, err := CreateTopic(database, pid, "旧名字", "")
	if err != nil {
		t.Fatal(err)
	}
	note, err := CreateNoteEx(database, pid, "n", "body", "", "other", "manual")
	if err != nil {
		t.Fatal(err)
	}
	if err := SetNoteTopic(database, note.ID, topic.ID); err != nil {
		t.Fatal(err)
	}

	if err := UpdateTopic(database, topic.ID, "新名字", "新的说明"); err != nil {
		t.Fatalf("UpdateTopic: %v", err)
	}

	renamed, err := GetTopic(database, topic.ID)
	if err != nil {
		t.Fatal(err)
	}
	if renamed.Name != "新名字" || renamed.Description != "新的说明" {
		t.Errorf("topic = %q/%q, want 新名字/新的说明", renamed.Name, renamed.Description)
	}
	// The notes under it are untouched — a rename is one UPDATE, not a
	// rewrite across every note.
	fetched, err := GetNoteByID(database, note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if fetched.TopicID != topic.ID {
		t.Errorf("note topic_id = %d, want %d", fetched.TopicID, topic.ID)
	}
}

func TestUpdateTopicRejectsADuplicateName(t *testing.T) {
	database := setupTestDB(t)
	pid := createTestProject(t, database, "p")

	if _, err := CreateTopic(database, pid, "A", ""); err != nil {
		t.Fatal(err)
	}
	b, err := CreateTopic(database, pid, "B", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := UpdateTopic(database, b.ID, "A", ""); err == nil {
		t.Fatal("expected a rename onto an existing name to be rejected")
	}
}

func TestSetNoteTopicZeroClearsTheTopic(t *testing.T) {
	database := setupTestDB(t)
	pid := createTestProject(t, database, "p")

	topic, err := CreateTopic(database, pid, "网关", "")
	if err != nil {
		t.Fatal(err)
	}
	note, err := CreateNoteEx(database, pid, "n", "body", "", "other", "manual")
	if err != nil {
		t.Fatal(err)
	}
	if err := SetNoteTopic(database, note.ID, topic.ID); err != nil {
		t.Fatal(err)
	}
	if err := SetNoteTopic(database, note.ID, 0); err != nil {
		t.Fatalf("clearing the topic: %v", err)
	}
	fetched, err := GetNoteByID(database, note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if fetched.TopicID != 0 {
		t.Errorf("topic_id = %d, want 0", fetched.TopicID)
	}
}

func TestListTopicsReturnsAnEmptySliceNotNil(t *testing.T) {
	database := setupTestDB(t)
	pid := createTestProject(t, database, "p")

	topics, err := ListTopics(database, pid)
	if err != nil {
		t.Fatal(err)
	}
	if topics == nil {
		t.Fatal("ListTopics returned nil; the frontend iterates it directly")
	}
	if len(topics) != 0 {
		t.Errorf("got %d topics, want 0", len(topics))
	}
}
