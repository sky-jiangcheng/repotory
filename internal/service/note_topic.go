package service

// The topic layer's business logic (schema v27): a project holds topics, a
// note is filed under one of them.
//
// The service layer owns the checks the db layer cannot make on its own —
// chiefly that a topic belongs to the same project as the note being filed
// under it, and that a topic referenced by a note actually exists. The db
// layer re-checks the project match on write (a race between the check here
// and the write is possible), because a note silently re-filed under another
// project's topic is worse than a rejected write.

import (
	"errors"
	"fmt"
	"log"
	"strings"

	"repotory/internal/db"
	"repotory/internal/domain"
)

// ErrTopicNotFound is returned when a topic id does not resolve. Callers
// check it with errors.Is, like ErrProjectNotFound and ErrNoteNotFound.
var ErrTopicNotFound = errors.New("topic not found")

// ListTopics returns a project's topics with their note counts.
func (s *Service) ListTopics(projectID int64) []domain.NoteTopic {
	topics, err := db.ListTopics(s.db, projectID)
	if err != nil {
		log.Printf("list topics error: %v", err)
		return []domain.NoteTopic{}
	}
	out := make([]domain.NoteTopic, 0, len(topics))
	for _, t := range topics {
		out = append(out, domain.NoteTopic{
			ID:          t.ID,
			ProjectID:   t.ProjectID,
			Name:        t.Name,
			Description: t.Description,
			SortOrder:   t.SortOrder,
			NoteCount:   t.NoteCount,
			CreatedAt:   t.CreatedAt,
			UpdatedAt:   t.UpdatedAt,
		})
	}
	return out
}

// CreateTopic creates a topic in a project.
//
// The project must exist: a topic without a project has no context and
// would be invisible in every view.
func (s *Service) CreateTopic(projectID int64, name, description string) (*domain.NoteTopic, error) {
	if _, err := db.GetProjectByID(s.db, projectID); err != nil {
		return nil, ErrProjectNotFound
	}
	if strings.TrimSpace(name) == "" {
		return nil, fmt.Errorf("主题名称不能为空")
	}
	t, err := db.CreateTopic(s.db, projectID, name, description)
	if err != nil {
		return nil, err
	}
	return &domain.NoteTopic{
		ID:          t.ID,
		ProjectID:   t.ProjectID,
		Name:        t.Name,
		Description: t.Description,
		SortOrder:   t.SortOrder,
		NoteCount:   t.NoteCount,
		CreatedAt:   t.CreatedAt,
		UpdatedAt:   t.UpdatedAt,
	}, nil
}

// UpdateTopic renames a topic and/or changes its description.
func (s *Service) UpdateTopic(topicID int64, name, description string) error {
	if _, err := db.GetTopic(s.db, topicID); err != nil {
		return ErrTopicNotFound
	}
	return db.UpdateTopic(s.db, topicID, name, description)
}

// DeleteTopic removes a topic. The notes filed under it are kept and fall
// back to "no topic" — deleting a filing label must never destroy
// knowledge.
func (s *Service) DeleteTopic(topicID int64) error {
	if _, err := db.GetTopic(s.db, topicID); err != nil {
		return ErrTopicNotFound
	}
	return db.DeleteTopic(s.db, topicID)
}

// SetNoteTopic files a note under a topic, or clears its topic when
// topicID is zero.
//
// Both sides are checked here so the caller gets a domain error rather than
// a driver's "no rows in result set"; the db layer re-checks the project
// match on write.
func (s *Service) SetNoteTopic(noteID, topicID int64) error {
	note, err := db.GetNoteByID(s.db, noteID)
	if err != nil {
		return ErrNoteNotFound
	}
	if topicID == 0 {
		return db.SetNoteTopic(s.db, noteID, 0)
	}
	topic, err := db.GetTopic(s.db, topicID)
	if err != nil {
		return ErrTopicNotFound
	}
	if note.ProjectID != topic.ProjectID {
		return fmt.Errorf("主题不属于该笔记所在的项目")
	}
	return db.SetNoteTopic(s.db, noteID, topicID)
}
