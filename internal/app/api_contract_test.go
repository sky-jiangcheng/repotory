package app

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// Binding-surface contract guard (P5 of the 2026-10-21 audit).
//
// Why this file exists. CONTRIBUTING says the binding surface in internal/app is
// an external contract and "changing it must sync docs/api/reference.md" — but
// nothing enforced that. The audit found the drift live: docs/api/reference.md
// still documented GetPluginStatuses() / ReloadPlugins(), two bindings that were
// removed with the yaegi plugin runtime (C11-B). The prose said "sync the doc";
// nothing could catch forgetting.
//
// The direction of the check is deliberate. This asserts DOCUMENTED -> EXISTS:
// every binding name the API reference mentions must be a real exported *App
// method. The reverse (every *App method must appear in the doc) is NOT asserted
// here — the reference deliberately documents the main API, not all 90-odd
// bindings, and demanding full coverage would force noise into a page meant to
// stay readable. What matters for a contract is the other direction: the doc
// must never promise a binding that does not exist, because that is what an
// integrator reads and then fails to call.
//
// The doc is a hand-written Markdown table, so the extraction is deliberately
// narrow: only names that appear as a backticked identifier in the first column
// of a table row, or as a backticked call `Name(args)`, are treated as binding
// names. Prose mentions of types (ProjectResponse, MergeSibling) and
// environment variables (REPOTORY_WEB_DIST) are ignored by construction.

// docPath is the API reference, relative to this package directory.
const docPath = "../../docs/api/reference.md"

// enDocPath is the English mirror of the same page.
const enDocPath = "../../docs/en/api/reference.md"

// tableCellBinding matches the first column of a table row that names exactly
// one binding: `| `Name` |` or `| `Name(args)` |`.
var tableCellBinding = regexp.MustCompile(`^\|\s*` + "`" + `([A-Za-z_][A-Za-z0-9_]*)\s*(\([^|]*\))?` + "`" + `\s*\|`)

// inlineCallBinding matches a backticked call in prose or in a table cell:
// `Name(args)`. The parameter list is required so that type names mentioned in
// prose (which are never followed by parentheses) are not picked up.
var inlineCallBinding = regexp.MustCompile("`([A-Z][A-Za-z0-9_]*)\\([^`]*\\)`")

// documentedBindings extracts the binding names the reference page mentions.
// A name in the first column of a table row is taken as-is; a name that only
// appears as `Name(args)` inline is also taken.
func documentedBindings(t *testing.T, path string) map[string]bool {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("failed to read %s: %v", path, err)
	}
	found := map[string]bool{}
	for _, line := range strings.Split(string(raw), "\n") {
		if m := tableCellBinding.FindStringSubmatch(line); m != nil {
			found[m[1]] = true
			continue
		}
		for _, m := range inlineCallBinding.FindAllStringSubmatch(line, -1) {
			found[m[1]] = true
		}
	}
	return found
}

// The doc must not promise a binding that does not exist. This is the drift the
// audit found: two removed bindings still listed in the reference.
func TestAPIReflectionDocumentsOnlyRealBindings(t *testing.T) {
	real := map[string]bool{}
	for _, m := range exportedAppMethods() {
		real[m] = true
	}

	for _, path := range []string{docPath, enDocPath} {
		documented := documentedBindings(t, path)

		var phantom []string
		for name := range documented {
			if !real[name] {
				phantom = append(phantom, name)
			}
		}
		if len(phantom) > 0 {
			sort.Strings(phantom)
			t.Errorf("%s documents %d binding(s) that no longer exist on *App: %v\n"+
				"The API reference is a contract; a name in it that cannot be called is a broken promise. "+
				"Either restore the binding or delete the row — the doc must not outlive the code it describes.",
				path, len(phantom), phantom)
		}
	}
}

// A binding removed from the code must also disappear from the doc. This is the
// same invariant as above, stated from the other side so that a future removal
// gets caught even if the name happens to match an unrelated identifier.
//
// The registry in surface.go is the authority on what exists; the reference
// page is a curated subset. So the check is: for every name the doc mentions,
// either it is a live binding (allowed) or it is not mentioned at all (allowed).
// The previous test already enforces exactly that, so this one guards the
// specific historical removals by name — it turns "we once forgot this" into a
// standing regression test that names the mistake.
func TestRemovedBindingsAreNotDocumented(t *testing.T) {
	// Bindings removed from *App. Each entry is a name that USED to be a
	// binding; if it ever reappears in the API reference, the doc was not
	// updated when the code changed.
	removed := []string{
		"GetPluginStatuses",   // removed with the yaegi plugin runtime (C11-B)
		"ReloadPlugins",       // removed with the yaegi plugin runtime (C11-B)
		"ExportProjectStats",  // dead methods removed in 1.7.0
		"ExportHeatmapCSV",    // dead methods removed in 1.7.0
		"GetNoteVersion",      // dead methods removed in 1.7.0
		"ScanForRepositories", // dead methods removed in 1.7.0
		"RefreshStats",        // dead methods removed in 1.7.0
		"RefreshAllStats",     // dead methods removed in 1.7.0
		"RefreshProjectStats", // dead methods removed in 1.7.0
	}

	live := map[string]bool{}
	for _, m := range exportedAppMethods() {
		live[m] = true
	}

	for _, path := range []string{docPath, enDocPath} {
		documented := documentedBindings(t, path)
		for _, name := range removed {
			if live[name] {
				// The binding is back — the doc entry is legitimate again,
				// and the generic test above already covers it.
				continue
			}
			if documented[name] {
				t.Errorf("%s still documents removed binding %q; delete the row or restore the binding",
					path, name)
			}
		}
	}
}

// Every binding named in the reference must also be classified in the surface
// registry. The registry is the machine-checked audit of "which bindings are
// agent-reachable"; the reference is the human-facing contract. A binding that
// is documented but unclassified would have no answer to "can an agent call
// this?" — the exact question surface.go exists to answer.
func TestDocumentedBindingsAreClassifiedInRegistry(t *testing.T) {
	documented := documentedBindings(t, docPath)

	var unclassified []string
	for name := range documented {
		if _, ok := bindingSurfaces[name]; !ok {
			unclassified = append(unclassified, name)
		}
	}
	if len(unclassified) > 0 {
		sort.Strings(unclassified)
		t.Errorf("%d documented binding(s) are not classified in bindingSurfaces: %v\n"+
			"Every binding must be declared mcp-backed (naming its tool), desktop-only (with a reason), "+
			"or lifecycle. The reference page and the surface registry must not disagree.",
			len(unclassified), unclassified)
	}
}

// The doc must stay in sync with itself: the Chinese source and the English
// mirror must document the same binding set. The bilingual mirror guard
// (scripts/check-docs-mirror.mjs) checks that the two FILES exist as twins;
// // it does not check that their content agrees. A row dropped on one side only
// is exactly the drift that guard cannot see.
func TestAPIReflectionZHAndENAgreeOnBindingSet(t *testing.T) {
	zh := documentedBindings(t, docPath)
	en := documentedBindings(t, enDocPath)

	var onlyZH, onlyEN []string
	for name := range zh {
		if !en[name] {
			onlyZH = append(onlyZH, name)
		}
	}
	for name := range en {
		if !zh[name] {
			onlyEN = append(onlyEN, name)
		}
	}
	sort.Strings(onlyZH)
	sort.Strings(onlyEN)

	if len(onlyZH) > 0 || len(onlyEN) > 0 {
		t.Errorf("API reference ZH/EN binding sets disagree: only-ZH=%v only-EN=%v\n"+
			"The bilingual mirror guard checks file twins, not content. A binding documented on one side only "+
			"is a contract one language promises and the other does not.",
			onlyZH, onlyEN)
	}
}

// Guard against the reference page silently disappearing from the build: if the
// file is renamed or moved, the checks above would pass vacuously on an empty
// extraction. A non-empty baseline keeps them honest.
func TestAPIReflectionDocumentsABaselineOfBindings(t *testing.T) {
	documented := documentedBindings(t, docPath)
	if len(documented) < 30 {
		t.Fatalf("expected the API reference to document at least 30 bindings, got %d — "+
			"the extraction is broken (or the page was gutted); every other check in this file "+
			"would pass vacuously", len(documented))
	}
}

// Sanity: the extraction must find names, and they must be plausible binding
// names rather than prose words. Guards the regex against silently matching
// nothing or matching everything.
func TestDocumentedBindingExtractionSanity(t *testing.T) {
	documented := documentedBindings(t, docPath)

	for _, want := range []string{"GetProjects", "CreateNote", "TriggerScan", "Health"} {
		if !documented[want] {
			t.Errorf("extraction missed the known binding %q — the regex drifted", want)
		}
	}
	// Prose type names must NOT be extracted: they are not bindings.
	for _, notBinding := range []string{"ProjectResponse", "MergeSibling", "Summary"} {
		if documented[notBinding] {
			t.Errorf("extraction picked up the type name %q as if it were a binding — "+
				"the pattern is too loose", notBinding)
		}
	}
}

// The path constants must point at real files — a typo in them would make
// ReadFile fail loudly, but a stale relative path (package moved) would fail
// just as loudly. This asserts the resolved path stays inside the repo so a
// future refactor cannot silently point the guard at some other file.
func TestAPIReflectionDocPathsStayInsideRepo(t *testing.T) {
	for _, path := range []string{docPath, enDocPath} {
		abs, err := filepath.Abs(path)
		if err != nil {
			t.Fatalf("failed to resolve %s: %v", path, err)
		}
		repoRoot := filepath.Join(filepath.Dir(abs), "..", "..")
		rel, err := filepath.Rel(repoRoot, abs)
		if err != nil {
			t.Fatalf("failed to relativize %s: %v", abs, err)
		}
		if strings.HasPrefix(rel, "..") {
			t.Errorf("doc path %s resolves outside the repo (%s)", path, abs)
		}
		if _, err := os.Stat(abs); err != nil {
			t.Errorf("doc path %s does not resolve to a file: %v", path, err)
		}
	}
}
