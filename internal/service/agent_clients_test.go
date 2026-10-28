package service

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"repotory/internal/agentinit"
	"repotory/internal/db"
	"repotory/internal/domain"
)

// The desktop "connect an AI client in one click" path.
//
// The wiring is internal/agentinit's job and is pinned there. What these
// tests cover is the layer above it: which project may receive client
// configuration at all, and how a refusal reaches the UI — as a code, never
// as a sentence the backend would have to speak the user's language.

// setupAgentService returns a service plus a fake repotory-mcp binary and an
// isolated HOME, so a test never registers anything into the real user's
// home directory or depends on a real install.
func setupAgentService(t *testing.T) (*Service, string) {
	t.Helper()
	s, _ := setupService(t)

	bin := filepath.Join(t.TempDir(), "repotory-mcp")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("REPOTORY_MCP_BIN", bin)
	t.Setenv("HOME", t.TempDir())
	return s, bin
}

// seedManualProject inserts a project that is NOT auto-grouped — the shape a
// real scanned repository has.
func seedManualProject(t *testing.T, s *Service, name, root string) int64 {
	t.Helper()
	tx, err := s.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	pid, err := db.SyncProjectTx(tx, name, root, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	return pid
}

func TestSetupAgentClientsWritesTheClientConfig(t *testing.T) {
	s, bin := setupAgentService(t)
	projectDir := t.TempDir()
	pid := seedManualProject(t, s, "demo", projectDir)

	report, err := s.SetupAgentClients(pid, []string{"claude"}, false)
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	if report.Code != AgentSetupOK {
		t.Fatalf("code = %q, want empty", report.Code)
	}
	if report.Blocking {
		t.Fatal("a successful setup must not be blocking")
	}
	if len(report.Files) != 1 {
		t.Fatalf("files = %d, want 1", len(report.Files))
	}
	if report.Files[0].Status != "created" {
		t.Fatalf("status = %q, want created", report.Files[0].Status)
	}

	raw, err := os.ReadFile(filepath.Join(projectDir, ".mcp.json"))
	if err != nil {
		t.Fatalf("read .mcp.json: %v", err)
	}
	var parsed struct {
		Servers map[string]struct {
			Command string   `json:"command"`
			Args    []string `json:"args"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("parse .mcp.json: %v", err)
	}
	entry, ok := parsed.Servers["repotory"]
	if !ok {
		t.Fatalf(".mcp.json has no repotory server: %s", raw)
	}
	if entry.Command != bin {
		t.Fatalf("command = %q, want %q", entry.Command, bin)
	}
}

// Registering twice must be a no-op the second time, not a rewrite: the
// button is idempotent so a user can press it twice without thinking.
func TestSetupAgentClientsIsIdempotent(t *testing.T) {
	s, _ := setupAgentService(t)
	projectDir := t.TempDir()
	pid := seedManualProject(t, s, "demo", projectDir)

	if _, err := s.SetupAgentClients(pid, []string{"claude"}, false); err != nil {
		t.Fatalf("first setup: %v", err)
	}
	report, err := s.SetupAgentClients(pid, []string{"claude"}, false)
	if err != nil {
		t.Fatalf("second setup: %v", err)
	}
	if report.Files[0].Status != "unchanged" {
		t.Fatalf("status = %q, want unchanged", report.Files[0].Status)
	}
}

func TestSetupAgentClientsInstallsTheHook(t *testing.T) {
	s, _ := setupAgentService(t)
	projectDir := t.TempDir()
	pid := seedManualProject(t, s, "demo", projectDir)

	report, err := s.SetupAgentClients(pid, []string{"claude"}, true)
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	if report.Hook == nil || report.HookSettings == nil {
		t.Fatalf("the hook was requested but not installed: %+v", report)
	}
	if _, err := os.Stat(filepath.Join(projectDir, ".claude", "hooks", "repotory-handoff.sh")); err != nil {
		t.Fatalf("hook script missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(projectDir, ".claude", "settings.json")); err != nil {
		t.Fatalf("settings.json missing: %v", err)
	}
}

// An auto-grouped project is a scan-time container (usually the home
// directory), not a project the user works in. Its .claude/settings.json
// would apply the SessionEnd hook to every project underneath it, so the
// registration must be refused.
func TestSetupAgentClientsRefusesAutoGroupedProject(t *testing.T) {
	s, _ := setupAgentService(t)
	containerDir := t.TempDir()
	pid := seedProject(t, s.db, "container", containerDir)

	report, err := s.SetupAgentClients(pid, []string{"claude"}, false)
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	if report.Code != AgentSetupAutoGroupedProject {
		t.Fatalf("code = %q, want %q", report.Code, AgentSetupAutoGroupedProject)
	}
	if !report.Blocking {
		t.Fatal("a refused setup must be blocking")
	}
	if len(report.Files) != 0 {
		t.Fatalf("a refused setup must not write anything: %+v", report.Files)
	}
	if _, err := os.Stat(filepath.Join(containerDir, ".mcp.json")); !os.IsNotExist(err) {
		t.Fatal("a refused setup must not have written .mcp.json")
	}
}

// The synthetic "未分类" row has no directory at all: its root_path is a
// sentinel, not a path.
func TestSetupAgentClientsRefusesTheVirtualProject(t *testing.T) {
	s, _ := setupAgentService(t)

	var pid int64
	if err := s.db.QueryRow("SELECT id FROM projects WHERE root_path = ?", domain.DefaultProjectRootPath).Scan(&pid); err != nil {
		t.Skipf("no default project in this database: %v", err)
	}

	report, err := s.SetupAgentClients(pid, []string{"claude"}, false)
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	if report.Code != AgentSetupVirtualProject {
		t.Fatalf("code = %q, want %q", report.Code, AgentSetupVirtualProject)
	}
}

func TestSetupAgentClientsRefusesAnUnknownClient(t *testing.T) {
	s, _ := setupAgentService(t)
	projectDir := t.TempDir()
	pid := seedManualProject(t, s, "demo", projectDir)

	report, err := s.SetupAgentClients(pid, []string{"emacs"}, false)
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	if report.Code != AgentSetupBadClient {
		t.Fatalf("code = %q, want %q", report.Code, AgentSetupBadClient)
	}
	if _, err := os.Stat(filepath.Join(projectDir, ".mcp.json")); !os.IsNotExist(err) {
		t.Fatal("a refused setup must not have written .mcp.json")
	}
}

// Unchecking every client must not be read as "do all of them": the empty
// selection is a refusal, because writing into ~/.codeium because the user
// unchecked the box is not a decision the button may take for them.
func TestSetupAgentClientsRefusesAnEmptySelection(t *testing.T) {
	s, _ := setupAgentService(t)
	projectDir := t.TempDir()
	pid := seedManualProject(t, s, "demo", projectDir)

	report, err := s.SetupAgentClients(pid, nil, false)
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	if report.Code != AgentSetupNoClient {
		t.Fatalf("code = %q, want %q", report.Code, AgentSetupNoClient)
	}
	if len(report.Files) != 0 {
		t.Fatalf("an empty selection must write nothing: %+v", report.Files)
	}
}

func TestSetupAgentClientsReportsAMissingDirectory(t *testing.T) {
	s, _ := setupAgentService(t)
	pid := seedManualProject(t, s, "gone", filepath.Join(t.TempDir(), "deleted"))

	report, err := s.SetupAgentClients(pid, []string{"claude"}, false)
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	if report.Code != AgentSetupMissingDirectory {
		t.Fatalf("code = %q, want %q", report.Code, AgentSetupMissingDirectory)
	}
	if !report.Blocking {
		t.Fatal("a missing directory must be blocking")
	}
}

func TestSetupAgentClientsReportsAnUnknownProject(t *testing.T) {
	s, _ := setupAgentService(t)

	report, err := s.SetupAgentClients(99999, []string{"claude"}, false)
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	if report.Code != AgentSetupProjectNotFound {
		t.Fatalf("code = %q, want %q", report.Code, AgentSetupProjectNotFound)
	}
}

// The client list the UI renders must be the backend's list, so a client the
// backend cannot register is never offered as a checkbox.
func TestAgentClientNamesMatchesTheRegistry(t *testing.T) {
	names := AgentClientNames()
	want := make([]string, 0, len(agentinit.AllClients))
	for _, c := range agentinit.AllClients {
		want = append(want, string(c))
	}
	if len(names) != len(want) {
		t.Fatalf("names = %v, want %v", names, want)
	}
	for i, n := range names {
		if n != want[i] {
			t.Fatalf("names = %v, want %v", names, want)
		}
	}
}
