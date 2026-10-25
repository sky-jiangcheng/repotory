package db

import (
	"testing"
)

// A merge that swallows a sibling must not silently unfile the sibling's
// notes: the topic rows die with the sibling project (ON DELETE CASCADE), so
// without an explicit migration every note it carried falls back to "no
// topic" and the user's filing is destroyed by an operation that never
// mentions topics.
func TestMergeProjectUpCarriesTheTopicsAlong(t *testing.T) {
	database := setupTestDB(t)

	parent := "/tmp/mergetopics"
	group := createTestProject(t, database, "grp")
	sibling := createTestProject(t, database, "sib")
	if _, err := database.Exec("UPDATE projects SET root_path = ? WHERE id = ?", parent+"/grp", group); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec("UPDATE projects SET root_path = ? WHERE id = ?", parent+"/sib", sibling); err != nil {
		t.Fatal(err)
	}

	topic, err := CreateTopic(database, sibling, "网关", "网关相关")
	if err != nil {
		t.Fatal(err)
	}
	note, err := CreateNoteEx(database, sibling, "重试策略", "body", "", "knowledge", "manual")
	if err != nil {
		t.Fatal(err)
	}
	if err := SetNoteTopic(database, note.ID, topic.ID); err != nil {
		t.Fatal(err)
	}

	if _, err := MergeProjectUp(database, group); err != nil {
		t.Fatalf("MergeProjectUp: %v", err)
	}

	// The note moved to the survivor and kept its filing.
	fetched, err := GetNoteByID(database, note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if fetched.ProjectID != group {
		t.Errorf("note project_id = %d, want %d", fetched.ProjectID, group)
	}
	if fetched.TopicID != topic.ID {
		t.Fatalf("note topic_id = %d, want %d (the filing must survive the merge)", fetched.TopicID, topic.ID)
	}
	moved, err := GetTopic(database, topic.ID)
	if err != nil {
		t.Fatalf("the topic died with the sibling: %v", err)
	}
	if moved.ProjectID != group {
		t.Errorf("topic project_id = %d, want %d", moved.ProjectID, group)
	}
	topics, err := ListTopics(database, group)
	if err != nil {
		t.Fatal(err)
	}
	if len(topics) != 1 || topics[0].NoteCount != 1 {
		t.Errorf("topics = %+v, want one topic holding the note", topics)
	}
}

// Two projects may carry a topic with the same name — a topic's meaning comes
// from its project's context. When they merge, the two become one: the
// duplicate row is dropped and its notes are re-pointed at the survivor,
// because two topics called "网关" inside one project would be
// indistinguishable (and the UNIQUE index forbids it anyway).
func TestMergeProjectUpMergesTopicsWithTheSameName(t *testing.T) {
	database := setupTestDB(t)

	parent := "/tmp/mergesamename"
	group := createTestProject(t, database, "grp")
	sibling := createTestProject(t, database, "sib")
	if _, err := database.Exec("UPDATE projects SET root_path = ? WHERE id = ?", parent+"/grp", group); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec("UPDATE projects SET root_path = ? WHERE id = ?", parent+"/sib", sibling); err != nil {
		t.Fatal(err)
	}

	kept, err := CreateTopic(database, group, "网关", "保留的那一个")
	if err != nil {
		t.Fatal(err)
	}
	dup, err := CreateTopic(database, sibling, "网关", "同名的另一个")
	if err != nil {
		t.Fatal(err)
	}
	note, err := CreateNoteEx(database, sibling, "n", "body", "", "knowledge", "manual")
	if err != nil {
		t.Fatal(err)
	}
	if err := SetNoteTopic(database, note.ID, dup.ID); err != nil {
		t.Fatal(err)
	}

	if _, err := MergeProjectUp(database, group); err != nil {
		t.Fatalf("MergeProjectUp: %v", err)
	}

	topics, err := ListTopics(database, group)
	if err != nil {
		t.Fatal(err)
	}
	if len(topics) != 1 {
		t.Fatalf("got %d topics, want 1 (the two same-named topics must merge)", len(topics))
	}
	if topics[0].ID != kept.ID {
		t.Errorf("surviving topic id = %d, want %d", topics[0].ID, kept.ID)
	}
	if topics[0].NoteCount != 1 {
		t.Errorf("note count = %d, want 1 (the note must be re-pointed, not dropped)", topics[0].NoteCount)
	}
	fetched, err := GetNoteByID(database, note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if fetched.TopicID != kept.ID {
		t.Errorf("note topic_id = %d, want %d", fetched.TopicID, kept.ID)
	}
}

// The organize pass moves a landing project's notes into a real project. The
// topics travel with them: a note that kept pointing at a topic left behind
// in the landing bucket would be filed under a subject its new project does
// not own — invisible in every view of where it now lives.
func TestReassignLandingNotesCarriesTheTopicsAlong(t *testing.T) {
	database := setupTestDB(t)

	source := createTestProject(t, database, "landing")
	target := createTestProject(t, database, "real")

	topic, err := CreateTopic(database, source, "网关", "")
	if err != nil {
		t.Fatal(err)
	}
	note, err := CreateNoteEx(database, source, "n", "body", "", "knowledge", "manual")
	if err != nil {
		t.Fatal(err)
	}
	if err := SetNoteTopic(database, note.ID, topic.ID); err != nil {
		t.Fatal(err)
	}

	moved, err := ReassignLandingNotes(database, source, target)
	if err != nil {
		t.Fatalf("ReassignLandingNotes: %v", err)
	}
	if moved != 1 {
		t.Fatalf("moved = %d, want 1", moved)
	}

	fetched, err := GetNoteByID(database, note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if fetched.ProjectID != target {
		t.Errorf("note project_id = %d, want %d", fetched.ProjectID, target)
	}
	if fetched.TopicID != topic.ID {
		t.Errorf("note topic_id = %d, want %d (the filing must survive the move)", fetched.TopicID, topic.ID)
	}
	movedTopic, err := GetTopic(database, topic.ID)
	if err != nil {
		t.Fatalf("the topic stayed behind in the landing bucket: %v", err)
	}
	if movedTopic.ProjectID != target {
		t.Errorf("topic project_id = %d, want %d", movedTopic.ProjectID, target)
	}
}

// Moving a single note to another project clears its topic instead of
// dragging a subject across a project boundary — the topic belongs to the
// project it was created in, and the destination project may have no such
// subject (or a different one under the same name).
func TestMoveNoteClearsTheTopic(t *testing.T) {
	database := setupTestDB(t)
	p1 := createTestProject(t, database, "one")
	p2 := createTestProject(t, database, "two")

	topic, err := CreateTopic(database, p1, "网关", "")
	if err != nil {
		t.Fatal(err)
	}
	note, err := CreateNoteEx(database, p1, "n", "body", "", "knowledge", "manual")
	if err != nil {
		t.Fatal(err)
	}
	if err := SetNoteTopic(database, note.ID, topic.ID); err != nil {
		t.Fatal(err)
	}

	if err := MoveNote(database, note.ID, p2); err != nil {
		t.Fatalf("MoveNote: %v", err)
	}
	fetched, err := GetNoteByID(database, note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if fetched.ProjectID != p2 {
		t.Errorf("note project_id = %d, want %d", fetched.ProjectID, p2)
	}
	if fetched.TopicID != 0 {
		t.Errorf("note topic_id = %d, want 0 (the topic stayed in the old project)", fetched.TopicID)
	}
}
