package main

import (
	"os"
	"path/filepath"
	"testing"
)

func writeCases(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "queries.jsonl")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// The benchmark's whole value is that its percentiles describe the query set
// it was given. A silently shortened set reports the wrong population, so a
// malformed line must abort the load rather than be skipped.
func TestLoadCasesParsesJSONL(t *testing.T) {
	path := writeCases(t, `{"query": "retry policy", "relevant": [1, 2]}
{"query": "幂等键", "relevant": [3]}

`)
	cases, err := loadCases(path)
	if err != nil {
		t.Fatalf("loadCases: %v", err)
	}
	if len(cases) != 2 {
		t.Fatalf("got %d cases, want 2", len(cases))
	}
	if cases[0].Query != "retry policy" || len(cases[0].Relevant) != 2 {
		t.Errorf("case 0 = %+v", cases[0])
	}
}

func TestLoadCasesRejectsBadLine(t *testing.T) {
	path := writeCases(t, `{"query": "good", "relevant": [1]}
{"query": broken json, "relevant": [2]}
`)
	if _, err := loadCases(path); err == nil {
		t.Fatal("expected an error for the malformed line, got nil")
	}
}

func TestLoadCasesEmptyFileYieldsZeroCases(t *testing.T) {
	path := writeCases(t, "\n\n")
	cases, err := loadCases(path)
	if err != nil {
		t.Fatalf("loadCases: %v", err)
	}
	if len(cases) != 0 {
		t.Fatalf("got %d cases, want 0", len(cases))
	}
}

// Nearest-rank percentiles must return a value that was actually observed:
// an interpolated p95 of two samples would report a latency nobody ever saw.
func TestPercentileIsNearestRank(t *testing.T) {
	sorted := []float64{1, 2, 3, 4}
	if got := percentile(sorted, 0.5); got != 2 {
		t.Errorf("p50 = %v, want 2", got)
	}
	if got := percentile(sorted, 0.95); got != 4 {
		t.Errorf("p95 = %v, want 4", got)
	}
	if got := percentile(sorted, 0); got != 1 {
		t.Errorf("p0 = %v, want 1", got)
	}
}

func TestSummarizeEmptyIsZeroed(t *testing.T) {
	st := summarize("x", nil)
	if st.n != 0 || st.p50 != 0 || st.p95 != 0 {
		t.Errorf("empty summary = %+v", st)
	}
}

func TestSummarizeComputesMeanAndMax(t *testing.T) {
	st := summarize("x", []sample{{ms: 10}, {ms: 20}, {ms: 60}})
	if st.n != 3 {
		t.Errorf("n = %d, want 3", st.n)
	}
	if st.max != 60 {
		t.Errorf("max = %v, want 60", st.max)
	}
	if st.mean != 30 {
		t.Errorf("mean = %v, want 30", st.mean)
	}
}
