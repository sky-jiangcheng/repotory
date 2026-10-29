package codebuddy

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"repotory/internal/importers/imptest"
)

// writeCodebuddyFixture builds one nested-profile session under a fake home and
// returns the home dir. The layout mirrors the real on-disk shape found in the
// 2026-10-18 rehearsal: Data/<uid>/<IDE>/<uid>/history/<session>/<sub>/ with
// index.json + messages/ — the depth the sessionRoots fix is about.
//
// The session files are SAMPLES from testdata/ rather than maps built inline
// (ADR-0011 decision 5): the importer's input is JSON on disk, so the test
// should exercise the bytes a real install would produce. When the on-disk
// format drifts, the diff shows the sample that drifted, next to the test
// that broke.
func writeCodebuddyFixture(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	base := filepath.Join(home, "Library", "Application Support", "CodeBuddyExtension",
		"Data", "uid-1", "JetBrains", "uid-1", "history", "sess-1")
	imptest.CopySample(t, "testdata/session", filepath.Join(base, "sub-1"))
	// The same session's second fork: an earlier fragment with fewer messages
	// (hex order first). The whole session must yield exactly one note, and it
	// must carry the content of the fork with the most messages.
	imptest.CopySample(t, "testdata/fork", filepath.Join(base, "sub-0"))
	return home
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func writeFile(t *testing.T, dir, name string, v any) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(mustJSON(t, v)), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestSessionRootsFindsNestedAndShallow(t *testing.T) {
	home := writeCodebuddyFixture(t)
	// 再放一个浅层根（default profile 的旧布局），两层都必须被发现。
	shallow := filepath.Join(home, "Library", "Application Support", "CodeBuddyExtension",
		"Data", "default", "CodeBuddyIDE", "history", "sess-empty")
	if err := os.MkdirAll(shallow, 0o755); err != nil {
		t.Fatal(err)
	}
	roots := sessionRoots(home)
	var hasDeep, hasShallow bool
	for _, r := range roots {
		if strings.Contains(r, filepath.Join("uid-1", "JetBrains", "uid-1", "history")) {
			hasDeep = true
		}
		if strings.Contains(r, filepath.Join("default", "CodeBuddyIDE", "history")) {
			hasShallow = true
		}
	}
	if !hasDeep || !hasShallow {
		t.Fatalf("sessionRoots incomplete: deep=%v shallow=%v roots=%v", hasDeep, hasShallow, roots)
	}
}

func TestImportProducesNoteFromNestedSession(t *testing.T) {
	home := writeCodebuddyFixture(t)
	imptest.SetHome(t, home)

	database, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	docs, err := New(database).Import()
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if len(docs) != 1 {
		t.Fatalf("expected 1 doc, got %d", len(docs))
	}
	d := docs[0]
	if d.Source != "codebuddy" || d.Kind != "log" {
		t.Errorf("source/kind = %q/%q", d.Source, d.Kind)
	}
	if !strings.Contains(d.Title, "如何实现缓存层") {
		t.Errorf("title missing first-user text: %q", d.Title)
	}
	if strings.Contains(d.Title, "user_info") || strings.Contains(d.Content, "<user_info>") {
		t.Errorf("envelope leaked into note: title=%q", d.Title)
	}
	if !strings.Contains(d.Content, "如何实现缓存层") {
		t.Errorf("content missing first-user text: %q", d.Content)
	}
	if !strings.Contains(d.Content, "用 LRU 缓存") {
		t.Errorf("content missing last-assistant text: %q", d.Content)
	}
	if strings.Contains(d.Content, "<answer>") {
		t.Errorf("answer tag leaked into note: %q", d.Content)
	}
	if d.RepoPath != "/tmp/ws/DemoRepo" {
		t.Errorf("RepoPath = %q, want first workspace folder", d.RepoPath)
	}
	if d.Tags != "codebuddy" {
		t.Errorf("tags = %q", d.Tags)
	}
}

func TestImportEmptyIndexYieldsNothing(t *testing.T) {
	home := t.TempDir()
	// default profile 的旧布局：index.json 直接在会话目录下，且只有空索引。
	sess := filepath.Join(home, "Library", "Application Support", "CodeBuddyExtension",
		"Data", "default", "CodeBuddyIDE", "history", "sess-1")
	if err := os.MkdirAll(sess, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sess, "index.json"),
		[]byte(`{"conversations": [], "current": ""}`), 0o644); err != nil {
		t.Fatal(err)
	}
	imptest.SetHome(t, home)

	database, _ := sql.Open("sqlite", ":memory:")
	defer database.Close()
	docs, err := New(database).Import()
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if len(docs) != 0 {
		t.Fatalf("empty index must yield no docs, got %d", len(docs))
	}
}

func TestMessageTextLegacyContentString(t *testing.T) {
	// 旧形态：顶层 content 就是纯文本，直接取用（RawMessage 必须是合法 JSON）。
	m := rawMap{"role": jsonRaw(`"user"`), "content": jsonRaw(`"旧的纯文本 content"`)}
	if got := messageText(m); got != "旧的纯文本 content" {
		t.Fatalf("legacy content = %q", got)
	}
	// 新形态：文本藏在转义的 message 字符串里（message 字段是 JSON 字符串值）。
	inner := mustJSON(t, map[string]any{
		"role": "assistant",
		"content": []map[string]any{
			{"type": "text", "text": "第一段"},
			{"type": "tool_use", "text": "不应出现"},
			{"type": "text", "text": "第二段"},
		},
	})
	m2 := rawMap{"role": jsonRaw(`"assistant"`), "message": jsonRaw(mustJSON(t, inner))}
	got := messageText(m2)
	if !strings.Contains(got, "第一段") || !strings.Contains(got, "第二段") {
		t.Fatalf("message text = %q, want both text blocks", got)
	}
	if strings.Contains(got, "不应出现") {
		t.Fatalf("non-text block leaked into text: %q", got)
	}
}

func TestStripEnvelopes(t *testing.T) {
	in := "<user_info>\nOS Version: darwin\nWorkspace Folders: /tmp/ws/DemoRepo\n</user_info>\n\n<rules>\nsome rules\n</rules>\n如何实现缓存层？"
	if got := stripEnvelopes(in); got != "如何实现缓存层？" {
		t.Fatalf("stripEnvelopes = %q", got)
	}
	// 信封链不止 user_info/rules：git_status、project_context 等也会前置。
	chain := "<git_status>\nM foo.go\n</git_status>\n<project_context>\nctx\n</project_context>\n真正的问题"
	if got := stripEnvelopes(chain); got != "真正的问题" {
		t.Fatalf("chained envelopes = %q", got)
	}
}

func jsonRaw(s string) json.RawMessage { return json.RawMessage(s) }
