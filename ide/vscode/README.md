# Repotory for VS Code

**Your local knowledge base, inside your IDE.** Repotory keeps what your coding agents learn — why a decision was made, what gotcha you hit, what to do next — in a local, searchable store. This extension surfaces it where you work: load a project's full session context, write a structured handoff when you stop, and search everything you ever captured, without leaving VS Code.

One VSIX covers the whole fork family — **VS Code, Cursor and Windsurf**.

## What it does

| Surface | What it does |
|---|---|
| Command `Repotory: Load Session Context` | Pulls the working context for your project (tech stack, README excerpt, recent commits, open todos, the last session handoff) via `repotory_context`, sending the current workspace path so a subdirectory resolves to the repository it belongs to; shows it in the Repotory output channel |
| Command `Repotory: Write Session Handoff` | Prompts for summary / changes / next steps, then records a structured handoff (`repotory_handoff`) — the project is resolved from the workspace path — the next session, yours or any agent's, starts from it |
| Command `Repotory: Search Knowledge` | Full-text search (FTS5) across every note you captured; the workspace path is sent so notes recorded in the matched repository rank first (ranking only, nothing filtered). Hits render in the sidebar with the matched snippet (the service returns the excerpt, not the full body) and open as a read-only preview |
| Sidebar "Repotory: Knowledge Search" | Idle state shows the resolved `project · repository` (or "Repotory: not in the knowledge base yet"), then the search results. Title bar also carries **"Repotory: Open Desktop App"** to launch the Repotory desktop app from the IDE |
| Status bar `$(repo) Repotory` | Click = load context; the tooltip names the resolved workspace (project / repository and its path) once resolved |
| Command `Repotory: Register MCP Server` | Runs the bundled `repotory-init --with-hook` silently in the background (no terminal): registers the MCP server for Claude Code / Cursor / VS Code / Windsurf and installs the SessionEnd hook. The installer ships inside the extension, so this works in any project — it is not limited to the Repotory repository |
| Command `Repotory: Setup & Diagnostics` | One panel showing four checks — `repotory-mcp` binary, local service, workspace resolution, MCP client config — each with the fix action next to it. Use this instead of guessing why something is not working |
| Command `Repotory: Set repotory-mcp Path` | File picker for the `repotory-mcp` executable; writes `repotory.mcpPath` so no PATH editing is needed |

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+R` `C` (`Ctrl+Cmd+R` `C` on macOS) | Load Session Context |
| `Ctrl+Alt+R` `H` (`Ctrl+Cmd+R` `H` on macOS) | Write Session Handoff |
| `Ctrl+Alt+R` `S` (`Ctrl+Cmd+R` `S` on macOS) | Search Knowledge |

The sidebar's title bar also carries a search button. All five commands remain in the Command Palette; rebind them in *Preferences → Keyboard Shortcuts* if the defaults collide with yours.

## Requirements

- The `repotory-mcp` binary — install it via Homebrew, Scoop or the GitHub Releases page. It does **not** have to be on your PATH: the extension resolves it in this order and stops at the first hit — `repotory.mcpPath`, `REPOTORY_MCP_BIN`, the extension's own storage, `PATH`, then the usual Homebrew / Scoop / `~/.local/bin` directories. If none matches, **"Repotory: Set repotory-mcp Path"** opens a file picker. The desktop app is optional; the MCP server alone is enough.
- Optional: a running `repotory server` for the status-bar health check and the sidebar's `project · repository` display (set `repotory.serverUrl` if you changed the port).

## First launch

On first activation the extension opens **"Repotory: Setup & Diagnostics"** instead of a wall of instructions: it shows whether the binary was found (and from where), whether the local service answers, what the current folder resolves to, and whether the MCP client config exists. Each row carries its fix — locate the binary, open the download page, re-run registration, or open the folder.

To wire the MCP server into your AI clients, run **"Repotory: Register MCP Server"**. It executes the bundled `repotory-init --with-hook` in the extension host (Electron-as-node), so no terminal opens; if that fails, the output channel has the full log and a "run it manually" fallback.

## Settings

| Setting | Default | Description |
|---|---|---|
| `repotory.serverUrl` | `http://127.0.0.1:18765` | Repotory headless service URL |
| `repotory.mcpPath` | `""` (auto-detect) | Explicit path to the `repotory-mcp` executable; empty means auto-detect. Pointing at a missing/unexecutable file is reported by the diagnostics panel instead of silently falling back |

That is the whole surface. No project id to configure: the extension sends the workspace path and the service resolves it into a project and a repository, so there is no setting to keep in sync with your knowledge base.

## Workspace resolution

The extension no longer needs a hand-typed project id. Every command sends the current workspace folder's absolute path (`repotory_context`, `repotory_handoff`, `repotory_notes_search`), and the backend's four-tier path resolver (`project → repository`, most specific first) works out which project — and which repository inside it — the folder belongs to. The matching rules live server-side on purpose: the MCP tools resolve the same path, and a second implementation in the extension would let the sidebar and an agent's `repotory_context` disagree about which knowledge a session gets. On load and whenever the workspace folders change, the extension asks the read-only `ResolveWorkspacePath` binding what the folder is and shows the answer: the sidebar's idle row reads `<project> · <repository>` (or `not in the knowledge base yet` when nothing matches), and the status-bar tooltip names the resolved workspace.

When the headless service is not reachable, the scope display stays silent (it does not guess) and the status-bar tooltip reports the reachability failure; the commands themselves still work over `repotory-mcp`, and any path-based resolution there is done by the same server-side code.

## Install

**Marketplace**: search "Repotory" in the Extensions view, or:

```bash
code --install-extension repotory-vscode.vsix
```

One VSIX works in VS Code, Cursor and Windsurf (use the fork's own CLI: `cursor --install-extension …`, `windsurf --install-extension …`).

The extension is a thin client — every answer comes from the same `internal/service` layer as the Repotory desktop app, read from your local SQLite knowledge base. Nothing leaves your machine.

## Development

```bash
cd ide/vscode
npm install
npm run compile
# open this folder in VS Code and "Run Extension" (F5), or package:
npx @vscode/vsce package --no-dependencies   # → repotory-vscode-<version>.vsix
```

Architecture and scope: [ADR-0009](https://github.com/sky-jiangcheng/repotory/blob/master/docs/en/adr/0009-ide-presence.md). The extension calls `repotory-mcp` over stdio and the loopback-only headless service; zero business logic lives here.
