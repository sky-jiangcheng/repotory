package service

import (
	"errors"
	"testing"

	"repotory/internal/db"
)

// The service layer's job on top of the db layer is turning "no such row"
// into a domain error the UI can act on, and refusing a filing that crosses
// a project boundary.

func TestServiceCreateTopicRequiresAProject(t *testing.T) {
	svc, _ := setupService(t)

	if _, err := svc.CreateTopic(999999, "网关", ""); !errors.Is(err, ErrProjectNotFound) {
		t.Fatalf("got %v, want ErrProjectNotFound", err)
	}
}

func TestServiceCreateTopicRejectsAnEmptyName(t *testing.T) {
	svc, _ := setupService(t)
	pid := seedProject(t, svc.db, "p", "/tmp/p")

	if _, err := svc.CreateTopic(pid, "   ", ""); err == nil {
		t.Fatal("expected an empty topic name to be rejected")
	}
}

func TestServiceTopicLifecycle(t *testing.T) {
	svc, _ := setupService(t)
	pid := seedProject(t, svc.db, "p", "/tmp/p")

	topic, err := svc.CreateTopic(pid, "  支付   网关  ", "网关相关")
	if err != nil {
		t.Fatalf("CreateTopic: %v", err)
	}
	// The name is normalized on the way in, so the UI shows what the user
	// meant rather than the raw keystrokes.
	if topic.Name != "支付 网关" {
		t.Errorf("name = %q, want %q", topic.Name, "支付 网关")
	}
	if topic.ProjectID != pid {
		t.Errorf("project_id = %d, want %d", topic.ProjectID, pid)
	}

	topics := svc.ListTopics(pid)
	if len(topics) != 1 || topics[0].ID != topic.ID {
		t.Fatalf("ListTopics = %+v, want the one topic", topics)
	}

	if err := svc.UpdateTopic(topic.ID, "新名字", "新的说明"); err != nil {
		t.Fatalf("UpdateTopic: %v", err)
	}
	topics = svc.ListTopics(pid)
	if topics[0].Name != "新名字" || topics[0].Description != "新的说明" {
		t.Errorf("topic = %q/%q, want 新名字/新的说明", topics[0].Name, topics[0].Description)
	}

	if err := svc.DeleteTopic(topic.ID); err != nil {
		t.Fatalf("DeleteTopic: %v", err)
	}
	if topics := svc.ListTopics(pid); len(topics) != 0 {
		t.Errorf("got %d topics after delete, want 0", len(topics))
	}
}

func TestServiceTopicOperationsOnAMissingTopic(t *testing.T) {
	svc, _ := setupService(t)

	if err := svc.UpdateTopic(999999, "x", ""); !errors.Is(err, ErrTopicNotFound) {
		t.Errorf("UpdateTopic: got %v, want ErrTopicNotFound", err)
	}
	if err := svc.DeleteTopic(999999); !errors.Is(err, ErrTopicNotFound) {
		t.Errorf("DeleteTopic: got %v, want ErrTopicNotFound", err)
	}
}

func TestServiceSetNoteTopicFilesAndClears(t *testing.T) {
	svc, _ := setupService(t)
	pid := seedProject(t, svc.db, "p", "/tmp/p")

	topic, err := svc.CreateTopic(pid, "网关", "")
	if err != nil {
		t.Fatal(err)
	}
	note, err := svc.CreateNote(pid, "重试策略")
	if err != nil {
		t.Fatal(err)
	}

	if err := svc.SetNoteTopic(note.ID, topic.ID); err != nil {
		t.Fatalf("SetNoteTopic: %v", err)
	}
	fetched, err := svc.GetNote(note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if fetched.TopicID != topic.ID {
		t.Errorf("topic_id = %d, want %d", fetched.TopicID, topic.ID)
	}

	// The topic's note count reflects the filing.
	topics := svc.ListTopics(pid)
	if len(topics) != 1 || topics[0].NoteCount != 1 {
		t.Errorf("topics = %+v, want one topic with note_count 1", topics)
	}

	if err := svc.SetNoteTopic(note.ID, 0); err != nil {
		t.Fatalf("clearing the topic: %v", err)
	}
	fetched, err = svc.GetNote(note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if fetched.TopicID != 0 {
		t.Errorf("topic_id = %d, want 0", fetched.TopicID)
	}
}

func TestServiceSetNoteTopicRejectsACrossProjectFiling(t *testing.T) {
	svc, _ := setupService(t)
	p1 := seedProject(t, svc.db, "one", "/tmp/one")
	p2 := seedProject(t, svc.db, "two", "/tmp/two")

	topic, err := svc.CreateTopic(p2, "另一个项目的主题", "")
	if err != nil {
		t.Fatal(err)
	}
	note, err := svc.CreateNote(p1, "n")
	if err != nil {
		t.Fatal(err)
	}

	if err := svc.SetNoteTopic(note.ID, topic.ID); err == nil {
		t.Fatal("expected a cross-project filing to be rejected")
	}
	fetched, err := svc.GetNote(note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if fetched.TopicID != 0 {
		t.Errorf("topic_id = %d, want 0 after a rejected filing", fetched.TopicID)
	}
}

func TestServiceSetNoteTopicOnAMissingNote(t *testing.T) {
	svc, _ := setupService(t)
	pid := seedProject(t, svc.db, "p", "/tmp/p")

	topic, err := svc.CreateTopic(pid, "网关", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.SetNoteTopic(999999, topic.ID); !errors.Is(err, ErrNoteNotFound) {
		t.Errorf("got %v, want ErrNoteNotFound", err)
	}
	if err := svc.SetNoteTopic(999999, 0); !errors.Is(err, ErrNoteNotFound) {
		t.Errorf("got %v, want ErrNoteNotFound", err)
	}
}

func TestServiceSetNoteTopicOnAMissingTopic(t *testing.T) {
	svc, _ := setupService(t)
	pid := seedProject(t, svc.db, "p", "/tmp/p")

	note, err := svc.CreateNote(pid, "n")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.SetNoteTopic(note.ID, 999999); !errors.Is(err, ErrTopicNotFound) {
		t.Errorf("got %v, want ErrTopicNotFound", err)
	}
}

func TestServiceDeletingATopicKeepsTheNote(t *testing.T) {
	svc, _ := setupService(t)
	pid := seedProject(t, svc.db, "p", "/tmp/p")

	topic, err := svc.CreateTopic(pid, "网关", "")
	if err != nil {
		t.Fatal(err)
	}
	note, err := svc.CreateNote(pid, "重要结论")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.SetNoteTopic(note.ID, topic.ID); err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteTopic(topic.ID); err != nil {
		t.Fatal(err)
	}

	// The note is still there — deleting a filing label must never destroy
	// knowledge — it just falls back to "no topic".
	fetched, err := svc.GetNote(note.ID)
	if err != nil {
		t.Fatalf("the note was deleted along with its topic: %v", err)
	}
	if fetched.TopicID != 0 {
		t.Errorf("topic_id = %d, want 0", fetched.TopicID)
	}
	if fetched.Content != "重要结论" {
		t.Errorf("content = %q, want it unchanged", fetched.Content)
	}
}

func TestServiceListTopicsIsEmptyNotNil(t *testing.T) {
	svc, _ := setupService(t)
	pid := seedProject(t, svc.db, "p", "/tmp/p")

	topics := svc.ListTopics(pid)
	if topics == nil {
		t.Fatal("ListTopics returned nil; the frontend iterates it directly")
	}
	if len(topics) != 0 {
		t.Errorf("got %d topics, want 0", len(topics))
	}
}

func TestServiceTopicCountSurvivesAMoveBetweenProjects(t *testing.T) {
	svc, _ := setupService(t)
	p1 := seedProject(t, svc.db, "one", "/tmp/one")
	p2 := seedProject(t, svc.db, "two", "/tmp/two")

	topic, err := svc.CreateTopic(p1, "网关", "")
	if err != nil {
		t.Fatal(err)
	}
	note, err := svc.CreateNote(p1, "n")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.SetNoteTopic(note.ID, topic.ID); err != nil {
		t.Fatal(err)
	}

	// Moving the note to another project leaves the topic behind (the topic
	// belongs to the old project) — the note must not keep pointing at it.
	if err := svc.MoveNote(note.ID, p2); err != nil {
		t.Fatalf("MoveNote: %v", err)
	}
	fetched, err := svc.GetNote(note.ID)
	if err != nil {
		t.Fatal(err)
	}
	if fetched.TopicID == topic.ID {
		t.Errorf("the note still points at the old project's topic %d", topic.ID)
	}
}

func TestServiceTopicDuplicateNameIsRejected(t *testing.T) {
	svc, _ := setupService(t)
	pid := seedProject(t, svc.db, "p", "/tmp/p")

	if _, err := svc.CreateTopic(pid, "网关", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.CreateTopic(pid, "网关", ""); err == nil {
		t.Fatal("expected a duplicate topic name in the same project to be rejected")
	}
	// A different project may reuse the name — a topic's meaning comes from
	// its project's context.
	other := seedProject(t, svc.db, "other", "/tmp/other")
	if _, err := svc.CreateTopic(other, "网关", ""); err != nil {
		t.Fatalf("the same name in another project must be allowed: %v", err)
	}
}

func TestServiceTopicWriteBounds(t *testing.T) {
	svc, _ := setupService(t)
	pid := seedProject(t, svc.db, "p", "/tmp/p")

	long := make([]byte, db.MaxTopicNameLen+1)
	for i := range long {
		long[i] = 'x'
	}
	if _, err := svc.CreateTopic(pid, string(long), ""); err == nil {
		t.Fatal("expected an oversized topic name to be rejected")
	}
}
