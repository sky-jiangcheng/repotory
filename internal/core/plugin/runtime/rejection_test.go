package runtime

import (
	"testing"

	"repotory/internal/core/plugin"
)

// rejectingImporter is a source whose upstream format changed: it produces a
// couple of good documents and refuses several files, exactly like the
// opencode importer did on 2026-10-18 when OpenCode changed a field's type.
//
// Before plugin.RejectionReporter existed, this source reported a clean
// zero-import run: "created 0, updated 0, skipped 0" with no error anywhere,
// which is indistinguishable from "there was nothing new to import".
type rejectingImporter struct {
	rejections []plugin.Rejection
}

func (i *rejectingImporter) Source() string { return "rejecting" }

func (i *rejectingImporter) Import() ([]plugin.ImportDoc, error) {
	return nil, nil
}

func (i *rejectingImporter) Rejections() []plugin.Rejection {
	return i.rejections
}

// plainImporter does not implement the optional reporter. Its behaviour must
// stay exactly as before: no failure count, no error sample.
type plainImporter struct{}

func (i *plainImporter) Source() string { return "plain" }

func (i *plainImporter) Import() ([]plugin.ImportDoc, error) {
	return nil, nil
}

// TestImportReportsRejectedDocuments pins the difference between "nothing to
// import" and "the importer could not read its input".
func TestImportReportsRejectedDocuments(t *testing.T) {
	database := setupDB(t)
	r := New(database)

	src := &rejectingImporter{
		rejections: []plugin.Rejection{
			{Path: "/sessions/a.json", Reason: "无法解析为 OpenCode 会话文件: cannot unmarshal"},
			{Path: "/sessions/b.json", Reason: "无法解析为 OpenCode 会话文件: cannot unmarshal"},
			{Path: "/sessions/c.json", Reason: "读取失败: permission denied"},
		},
	}
	r.RegisterSource("rejecting", src)

	run, err := r.TriggerImport("rejecting")
	if err != nil {
		t.Fatalf("trigger: %v", err)
	}
	if run.Failed != 3 {
		t.Fatalf("Failed = %d, want 3 — a source that could not read three files must say so", run.Failed)
	}
	if len(run.Errors) != 3 {
		t.Fatalf("Errors has %d entries, want 3", len(run.Errors))
	}
	// The reason must name the file, or the user cannot act on it.
	if run.Errors[0] == "" || run.Errors[0] == run.Errors[1] {
		t.Errorf("rejection reasons must differ per file, got %v", run.Errors)
	}

	// The settings page reads SourceStatuses, so the failure must be visible
	// there too — that is where the user looks when an import "did nothing".
	var found bool
	for _, st := range r.SourceStatuses() {
		if st.Name != "rejecting" {
			continue
		}
		found = true
		if st.Failed != 3 {
			t.Errorf("SourceStatus.Failed = %d, want 3", st.Failed)
		}
		if len(st.Errors) == 0 {
			t.Error("SourceStatus.Errors is empty; the settings page would show nothing")
		}
	}
	if !found {
		t.Fatal("source status for 'rejecting' not found")
	}
}

// TestImportWithoutReporterStaysClean pins that the optional capability
// changes nothing for a source that does not implement it.
func TestImportWithoutReporterStaysClean(t *testing.T) {
	database := setupDB(t)
	r := New(database)
	r.RegisterSource("plain", &plainImporter{})

	run, err := r.TriggerImport("plain")
	if err != nil {
		t.Fatalf("trigger: %v", err)
	}
	if run.Failed != 0 || len(run.Errors) != 0 {
		t.Fatalf("a source without the reporter must report no failures, got %d / %v", run.Failed, run.Errors)
	}
	for _, st := range r.SourceStatuses() {
		if st.Name == "plain" && (st.Failed != 0 || len(st.Errors) != 0) {
			t.Errorf("SourceStatus for 'plain' must be clean, got %d / %v", st.Failed, st.Errors)
		}
	}
}

// TestImportResetsPreviousFailures pins that a FIXED importer stops showing
// the old breakage: the rejection list belongs to the run, not to the source.
func TestImportResetsPreviousFailures(t *testing.T) {
	database := setupDB(t)
	r := New(database)

	src := &rejectingImporter{
		rejections: []plugin.Rejection{{Path: "/sessions/a.json", Reason: "boom"}},
	}
	r.RegisterSource("rejecting", src)

	if _, err := r.TriggerImport("rejecting"); err != nil {
		t.Fatalf("first trigger: %v", err)
	}

	// The importer recovered: same source, no rejections this time.
	src.rejections = nil
	run, err := r.TriggerImport("rejecting")
	if err != nil {
		t.Fatalf("second trigger: %v", err)
	}
	if run.Failed != 0 {
		t.Fatalf("Failed = %d after the importer recovered, want 0", run.Failed)
	}
	for _, st := range r.SourceStatuses() {
		if st.Name == "rejecting" && st.Failed != 0 {
			t.Errorf("SourceStatus.Failed = %d after recovery, want 0", st.Failed)
		}
	}
}
