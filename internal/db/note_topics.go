package db

// The topic layer: a project holds topics, a note is filed under one of them
// (schema v27). A topic is a real entity — its own row, its own id, its own
// lifecycle — which is what makes renaming it a single UPDATE instead of a
// rewrite across every note, and what makes "how many notes are in this
// topic" answerable at all.
//
// A topic belongs to exactly one project (project_id NOT NULL, ON DELETE
// CASCADE): the same subject name in two projects is two topics, because a
// topic's meaning comes from its project's context.

import (
	"database/sql"
	"fmt"
	"strings"
)

// Topic write bounds. A topic name is a short label, not a document.
const (
	// MaxTopicNameLen bounds a topic's name.
	MaxTopicNameLen = 100
	// MaxTopicDescriptionLen bounds a topic's description.
	MaxTopicDescriptionLen = 500
)

// NoteTopic is one topic of one project.
type NoteTopic struct {
	ID          int64  `json:"id"`
	ProjectID   int64  `json:"project_id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	SortOrder   int    `json:"sort_order"`
	// NoteCount is how many notes are filed under this topic. Filled by the
	// list queries; a single-topic read leaves it at zero unless it asks.
	NoteCount int    `json:"note_count"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

// ValidateTopicBounds rejects oversized topic fields.
func ValidateTopicBounds(name, description string) error {
	if len(name) > MaxTopicNameLen {
		return fmt.Errorf("topic name too long: %d bytes (max %d)", len(name), MaxTopicNameLen)
	}
	if len(description) > MaxTopicDescriptionLen {
		return fmt.Errorf("topic description too long: %d bytes (max %d)", len(description), MaxTopicDescriptionLen)
	}
	return nil
}

// NormalizeTopicName trims a topic name and collapses internal whitespace.
//
// The collapse matters because the (project_id, name) pair is UNIQUE: "支付
// 网关" and "支付  网关" are the same topic to a reader, and if they were
// two rows the user would see both and file notes in the wrong one.
func NormalizeTopicName(name string) string {
	return strings.Join(strings.Fields(name), " ")
}

// CreateTopic inserts a topic into a project.
//
// The name is normalized first, and a duplicate within the same project is
// rejected with a clear error rather than a bare UNIQUE constraint failure:
// "this project already has a topic called X" is actionable, "UNIQUE
// constraint failed: note_topics.project_id, note_topics.name" is not.
func CreateTopic(db *sql.DB, projectID int64, name, description string) (*NoteTopic, error) {
	if err := ValidateTopicBounds(name, description); err != nil {
		return nil, err
	}
	name = NormalizeTopicName(name)
	if name == "" {
		return nil, fmt.Errorf("topic name cannot be empty")
	}
	var exists int
	err := db.QueryRow("SELECT COUNT(*) FROM note_topics WHERE project_id = ? AND name = ?", projectID, name).Scan(&exists)
	if err != nil {
		return nil, err
	}
	if exists > 0 {
		return nil, fmt.Errorf("该主题已存在")
	}
	res, err := db.Exec(
		"INSERT INTO note_topics (project_id, name, description) VALUES (?, ?, ?)",
		projectID, name, strings.TrimSpace(description))
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	return GetTopic(db, id)
}

// GetTopic returns one topic by its id.
func GetTopic(db *sql.DB, id int64) (*NoteTopic, error) {
	t := &NoteTopic{}
	err := db.QueryRow(
		"SELECT id, project_id, name, description, sort_order, created_at, updated_at FROM note_topics WHERE id = ?", id).
		Scan(&t.ID, &t.ProjectID, &t.Name, &t.Description, &t.SortOrder, &t.CreatedAt, &t.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return t, nil
}

// ListTopics returns a project's topics with their note counts, ordered by
// the manual sort order then by name.
//
// The note count comes from a LEFT JOIN over project_notes, so a topic with
// no notes shows 0 rather than disappearing.
func ListTopics(db *sql.DB, projectID int64) ([]NoteTopic, error) {
	rows, err := db.Query(
		`SELECT t.id, t.project_id, t.name, t.description, t.sort_order, t.created_at, t.updated_at,
		        (SELECT COUNT(*) FROM project_notes n WHERE n.topic_id = t.id)
		 FROM note_topics t
		 WHERE t.project_id = ?
		 ORDER BY t.sort_order ASC, t.name ASC`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	topics := []NoteTopic{}
	for rows.Next() {
		var t NoteTopic
		if err := rows.Scan(&t.ID, &t.ProjectID, &t.Name, &t.Description, &t.SortOrder,
			&t.CreatedAt, &t.UpdatedAt, &t.NoteCount); err != nil {
			return nil, err
		}
		topics = append(topics, t)
	}
	return topics, rows.Err()
}

// UpdateTopic renames a topic and/or changes its description.
//
// A rename that would collide with another topic in the same project is
// rejected: the UNIQUE index would fail it anyway, but with a message the
// user cannot act on.
func UpdateTopic(db *sql.DB, id int64, name, description string) error {
	if err := ValidateTopicBounds(name, description); err != nil {
		return err
	}
	name = NormalizeTopicName(name)
	if name == "" {
		return fmt.Errorf("topic name cannot be empty")
	}
	current, err := GetTopic(db, id)
	if err != nil {
		return err
	}
	var clash int
	err = db.QueryRow(
		"SELECT COUNT(*) FROM note_topics WHERE project_id = ? AND name = ? AND id != ?",
		current.ProjectID, name, id).Scan(&clash)
	if err != nil {
		return err
	}
	if clash > 0 {
		return fmt.Errorf("该主题已存在")
	}
	_, err = db.Exec(
		"UPDATE note_topics SET name = ?, description = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?",
		name, strings.TrimSpace(description), id)
	return err
}

// DeleteTopic removes a topic.
//
// The notes filed under it are NOT deleted: project_notes.topic_id is ON
// DELETE SET NULL, so they fall back to "no topic" and stay in the project.
// Deleting a filing label must never destroy knowledge.
func DeleteTopic(db *sql.DB, id int64) error {
	_, err := db.Exec("DELETE FROM note_topics WHERE id = ?", id)
	return err
}

// SetNoteTopic files a note under a topic, or clears its topic when
// topicID is zero.
//
// Both sides are validated: a topic from another project is rejected rather
// than silently re-filing the note under a topic of a project it does not
// belong to.
func SetNoteTopic(db *sql.DB, noteID, topicID int64) error {
	if topicID == 0 {
		_, err := db.Exec(
			"UPDATE project_notes SET topic_id = NULL, updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?",
			noteID)
		return err
	}
	topic, err := GetTopic(db, topicID)
	if err != nil {
		return err
	}
	var projectID int64
	if err := db.QueryRow("SELECT project_id FROM project_notes WHERE id = ?", noteID).Scan(&projectID); err != nil {
		return err
	}
	if projectID != topic.ProjectID {
		return fmt.Errorf("主题不属于该笔记所在的项目")
	}
	_, err = db.Exec(
		"UPDATE project_notes SET topic_id = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?",
		topicID, noteID)
	return err
}

// CountNotesByTopic returns how many notes are filed under each topic of a
// project, keyed by topic id. Topics with no notes are absent from the map.
func CountNotesByTopic(db *sql.DB, projectID int64) (map[int64]int, error) {
	rows, err := db.Query(
		`SELECT topic_id, COUNT(*) FROM project_notes
		 WHERE project_id = ? AND topic_id IS NOT NULL GROUP BY topic_id`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]int{}
	for rows.Next() {
		var topicID int64
		var count int
		if err := rows.Scan(&topicID, &count); err != nil {
			return nil, err
		}
		out[topicID] = count
	}
	return out, rows.Err()
}

// TopicNames returns every topic's name keyed by topic id.
//
// It exists so a note can carry its topic's display name even when the topic
// belongs to a different project than the one being listed — the global
// knowledge list spans projects, and a note labeled only with a numeric id
// would be unreadable there. One query for the whole table beats a lookup per
// note.
func TopicNames(db *sql.DB) (map[int64]string, error) {
	rows, err := db.Query("SELECT id, name FROM note_topics")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	names := map[int64]string{}
	for rows.Next() {
		var id int64
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		names[id] = name
	}
	return names, rows.Err()
}

// MigrateTopicsInto moves every topic of fromProject into toProject and
// re-files the notes that were filed under them.
//
// It exists because two bulk operations move a whole project's notes
// elsewhere — the "merge up" that swallows sibling projects and the
// "organize" pass that files landing notes into a real project. Without it
// the topic rows die with their source project (ON DELETE CASCADE) and the
// notes silently fall back to "no topic": the user's filing survives the
// move as nothing at all.
//
// A topic whose name already exists in the target is merged into it: the
// duplicate row is dropped and its notes are re-pointed at the survivor. The
// name is the only identity a topic has for the user — two topics called
// "网关" inside one project would be indistinguishable — and the
// (project_id, name) UNIQUE index would refuse the second one anyway.
//
// The notes must already have been moved to toProject when this runs, so a
// re-pointed note stays inside the project that owns its topic.
func MigrateTopicsInto(tx *sql.Tx, fromProjectID, toProjectID int64) error {
	rows, err := tx.Query(
		"SELECT id, name, description, sort_order FROM note_topics WHERE project_id = ?", fromProjectID)
	if err != nil {
		return err
	}
	type topicRow struct {
		id          int64
		name        string
		description string
		sortOrder   int
	}
	var topics []topicRow
	for rows.Next() {
		var t topicRow
		if err := rows.Scan(&t.id, &t.name, &t.description, &t.sortOrder); err != nil {
			rows.Close()
			return err
		}
		topics = append(topics, t)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	for _, t := range topics {
		var existingID int64
		err := tx.QueryRow(
			"SELECT id FROM note_topics WHERE project_id = ? AND name = ?", toProjectID, t.name).Scan(&existingID)
		switch {
		case err == sql.ErrNoRows:
			// No clash: the topic itself moves to the target project.
			if _, err := tx.Exec(
				"UPDATE note_topics SET project_id = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?",
				toProjectID, t.id); err != nil {
				return err
			}
		case err != nil:
			return err
		default:
			// Same name in the target: merge into the survivor.
			if _, err := tx.Exec(
				"UPDATE project_notes SET topic_id = ? WHERE topic_id = ?", existingID, t.id); err != nil {
				return err
			}
			if _, err := tx.Exec("DELETE FROM note_topics WHERE id = ?", t.id); err != nil {
				return err
			}
		}
	}
	return nil
}
