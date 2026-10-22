package runtime

import (
	"errors"
	"testing"
)

// TestSourceStatusCarriesPerSourceSyncTrail: ADR-0022 决策 3 asks for
// lastRun/lastError ON THE SOURCE, not only on the aggregate round. The
// round-level status can answer "did the last sync have a problem"; only the
// per-source fields can answer "which source, and when".
//
// The state lives in the runtime (not the service layer) on purpose: a manual
// import from the settings page and a scheduled round both go through
// TriggerImport, so recording it here is the one place that sees both. A
// second copy in the service layer would be a second truth.
func TestSourceStatusCarriesPerSourceSyncTrail(t *testing.T) {
	rt := New(setupDB(t))
	rt.RegisterSource("claude", staticImporter{source: "claude"})
	rt.RegisterSourceManual("broken", failingImporter{source: "broken", err: errors.New("boom")})

	byName := map[string]SourceStatus{}
	for _, st := range rt.SourceStatuses() {
		byName[st.Name] = st
	}

	// Before any run: no timestamp, no error.
	if got := byName["claude"].LastRun; got != "" {
		t.Errorf("claude last_run before import = %q, want empty", got)
	}
	if got := byName["claude"].LastError; got != "" {
		t.Errorf("claude last_error before import = %q, want empty", got)
	}

	if _, err := rt.TriggerImport("claude"); err != nil {
		t.Fatalf("claude import: %v", err)
	}
	if _, err := rt.TriggerImport("broken"); err == nil {
		t.Fatal("broken import should have failed")
	}

	for _, st := range rt.SourceStatuses() {
		switch st.Name {
		case "claude":
			if st.LastRun == "" {
				t.Error("claude last_run is empty after a successful import")
			}
			if st.LastError != "" {
				t.Errorf("claude last_error = %q, want empty after a clean import", st.LastError)
			}
		case "broken":
			if st.LastRun == "" {
				t.Error("broken last_run is empty after a failed import")
			}
			if st.LastError == "" {
				t.Error("broken last_error is empty after a failed import")
			}
		}
	}
}
