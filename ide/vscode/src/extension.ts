// Repotory for VS Code — thin client over Repotory (ADR-0009 step two / TODO M5).
//
// Commands: load session context, write the session handoff and search the
// knowledge base; a status-bar item and a knowledge-search sidebar make the
// product visible inside the IDE. Everything is delegated: read endpoints go
// to the loopback-only headless service when it is up, all tools go through
// repotory-mcp over stdio — zero logic duplication (thin-client discipline).
import * as vscode from "vscode";
import * as path from "node:path";
import * as os from "node:os";
import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { exec, execFile } from "node:child_process";
import { McpStdioClient } from "./mcpClient.js";
import { getJson, parseOrganizeProposal, parseProjects, parseSearchHits, postJson, type OrganizeProposal, type ProjectOption } from "./headless.js";
import { parseNoteRead, RepotorySearchViewProvider, type EditorDraft, type Thumb } from "./searchView.js";

const CONFIG_SECTION = "repotory";
const SERVER_URL_KEY = "serverUrl";
const MCP_PATH_KEY = "mcpPath";
const MCP_ENV = "REPOTORY_MCP_BIN";
const BINARY_NAMES = ["repotory-mcp", "repotory-mcp.exe"];
const RELEASES_URL = "https://github.com/sky-jiangcheng/repotory/releases";
const AI_INTEGRATION_DOC =
  "https://github.com/sky-jiangcheng/repotory/blob/master/docs/features/ai-integration.md";

export let output: vscode.OutputChannel;
let statusItem: vscode.StatusBarItem;
let mcp: McpStdioClient | null = null;
let extensionContext: vscode.ExtensionContext | undefined;

interface HandoffStatus {
  note_id?: number;
  project_id?: number;
  title?: string;
  updated_at?: string;
}

function serverUrl(): string {
  return (
    vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>(SERVER_URL_KEY) ??
    "http://127.0.0.1:18765"
  );
}

// workspacePath is the folder the session is actually standing in. It is the
// input the backend resolves into a project AND a repository, which is what makes
// opening `…/CBiPay/pay-common` behave differently from opening `…/CBiPay`.
function workspacePath(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? folder.uri.fsPath : undefined;
}

interface WorkspaceResolution {
  Project?: { id: number; name: string; root_path: string } | null;
  Repository?: { id: number; path: string } | null;
  MatchedOn?: string;
  Candidates?: unknown[];
}

let lastResolution: WorkspaceResolution | null = null;

type BinarySource = "setting" | "env" | "storage" | "path" | "common";

interface BinaryResolution {
  path?: string;
  source?: BinarySource;
  problem?: string;
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function isExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    // Windows does not honour X_OK for most files; existence is the best
    // signal there, and spawn will fail with a clear error if it is not.
    return process.platform === "win32" && existsSync(candidate);
  }
}

function commonBinaryDirs(): string[] {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/local/opt/repotory-mcp/bin",
      path.join(home, ".local", "bin"),
    ];
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return [
      path.join(home, "scoop", "shims"),
      path.join(home, "scoop", "apps", "repotory-mcp", "current"),
      path.join(local, "Programs", "repotory-mcp"),
      path.join(local, "repotory-mcp"),
    ];
  }
  return [
    "/usr/local/bin",
    "/usr/bin",
    path.join(home, ".local", "bin"),
    "/home/linuxbrew/.linuxbrew/bin",
  ];
}

function storageBinary(): string | undefined {
  const dir = extensionContext?.globalStorageUri.fsPath;
  if (!dir) return undefined;
  for (const name of BINARY_NAMES) {
    const candidate = path.join(dir, "bin", name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve repotory-mcp without requiring it to be on PATH.
 *
 * Order: explicit setting -> env var -> extension storage -> PATH -> common
 * package-manager directories. A configured-but-missing path is reported as a
 * problem instead of silently falling through to PATH: the user pointed at a
 * file, and pretending otherwise would hide the mistake.
 */
export function resolveMcpBinary(): BinaryResolution {
  const configuredRaw =
    vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>(MCP_PATH_KEY)?.trim() ?? "";
  if (configuredRaw) {
    const configured = expandHome(configuredRaw);
    return isExecutable(configured)
      ? { path: configured, source: "setting" }
      : { problem: `repotory.mcpPath 指向的文件不可执行：${configured}` };
  }

  const fromEnv = process.env[MCP_ENV]?.trim();
  if (fromEnv) {
    const expanded = expandHome(fromEnv);
    return isExecutable(expanded)
      ? { path: expanded, source: "env" }
      : { problem: `环境变量 ${MCP_ENV} 指向的文件不可执行：${expanded}` };
  }

  const stored = storageBinary();
  if (stored) return { path: stored, source: "storage" };

  const common = commonBinaryDirs();
  const seen = new Set<string>();
  for (const dir of [...(process.env.PATH ?? "").split(path.delimiter), ...common]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    for (const name of BINARY_NAMES) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) {
        return { path: candidate, source: common.includes(dir) ? "common" : "path" };
      }
    }
  }
  return {
    problem: "在 PATH、Homebrew / Scoop 常见目录和扩展存储中都没有找到 repotory-mcp",
  };
}

export function findBinary(): string | undefined {
  return resolveMcpBinary().path;
}

async function pickMcpBinary(): Promise<string | undefined> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: "使用此文件",
    title: "选择 repotory-mcp 可执行文件",
  });
  const file = picked?.[0];
  if (!file) return undefined;
  if (!isExecutable(file.fsPath)) {
    void vscode.window.showWarningMessage(`Repotory: 该文件不可执行：${file.fsPath}`);
    return undefined;
  }
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update(MCP_PATH_KEY, file.fsPath, vscode.ConfigurationTarget.Global);
  resetMcp();
  return file.fsPath;
}

function resetMcp(): void {
  mcp?.stop();
  mcp = null;
}

async function getMcp(): Promise<McpStdioClient> {
  if (mcp) return mcp;
  const resolved = resolveMcpBinary();
  if (!resolved.path) {
    const choice = await vscode.window.showErrorMessage(
      `Repotory: 未找到 repotory-mcp。${resolved.problem ?? ""}`,
      "定位可执行文件…",
      "打开下载页",
      "环境诊断",
    );
    if (choice === "定位可执行文件…") {
      const picked = await pickMcpBinary();
      if (picked) return getMcp();
    } else if (choice === "打开下载页") {
      void vscode.env.openExternal(vscode.Uri.parse(RELEASES_URL));
    } else if (choice === "环境诊断" && extensionContext) {
      await diagnose(extensionContext);
    }
    throw new Error(resolved.problem ?? "repotory-mcp not found");
  }
  const client = new McpStdioClient({ command: resolved.path }, (line: string) =>
    output?.appendLine(line),
  );
  await client.start();
  mcp = client;
  return client;
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const client = await getMcp();
  try {
    return await client.callTool(name, args);
  } catch (err) {
    // A dead server must not wedge the extension: drop it so the next call restarts.
    mcp = null;
    client.stop();
    throw err;
  }
}

// refreshScope asks the backend which project/repository this workspace is, and
// shows the answer. The matching rules live server-side on purpose: the MCP tools
// resolve the same path, and a TypeScript reimplementation would let the sidebar
// and an agent's repotory_context disagree about which knowledge a session gets.
async function refreshScope(view: RepotorySearchViewProvider): Promise<void> {
  const dir = workspacePath();
  if (!dir) {
    lastResolution = null;
    view.setScope("");
    return;
  }
  try {
    const response = (await postJson(serverUrl(), "/api/rpc", {
      method: "ResolveWorkspacePath",
      args: [dir],
    })) as { result?: WorkspaceResolution | null };
    const res = response.result ?? null;
    lastResolution = res;
    if (res?.Project) {
      const repo = res.Repository?.path ? res.Repository.path.split(/[\\/]/).pop() : undefined;
      view.setScope(repo ? `${res.Project.name} · ${repo}` : res.Project.name);
      if (statusItem) {
        statusItem.tooltip =
          `Workspace: ${res.Project.name}${repo ? " / " + repo : ""}\n${dir}\n\nClick to load the session context`;
      }
    } else {
      view.setScope("Repotory: not in the knowledge base yet");
    }
  } catch {
    // No headless service: the commands still work through repotory-mcp, so the
    // view stays silent about scope rather than asserting something unverified.
    view.setScope("");
  }
}

async function pingHeadless(): Promise<boolean> {
  try {
    await getJson(serverUrl(), "/health");
    return true;
  } catch {
    return false;
  }
}

async function refreshLastHandoff(): Promise<void> {
  if (!statusItem) return;
  try {
    const response = (await postJson(serverUrl(), "/api/rpc", {
      method: "LatestHandoff",
      // 0 = unscoped: the newest handoff across all projects. The status bar is
      // chrome about "when did I last hand anything off", so an unscoped answer
      // is what it wants; the workspace's own project would need the resolution
      // result, which is not this call's business.
      args: [0],
    })) as { result?: HandoffStatus | null };
    const handoff = response.result;
    const at = handoff?.updated_at ? new Date(handoff.updated_at) : undefined;
    if (handoff && at && !Number.isNaN(at.getTime())) {
      statusItem.text = `$(repo) Repotory · ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      statusItem.tooltip = `Last handoff: ${handoff.title ?? "session"}\n${at.toLocaleString()}\n\nClick to load the session context`;
    } else {
      statusItem.text = "$(repo) Repotory";
      statusItem.tooltip = "Repotory: no session handoff yet. Click to load the session context";
    }
  } catch {
    statusItem.text = "$(repo) Repotory";
    statusItem.tooltip = "Repotory: click to load the session context";
  }
}

function withProgress<T>(title: string, task: () => Promise<T>): Thenable<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Repotory: ${title}` },
    task,
  );
}

function showOutput(title: string, body: string): void {
  output.appendLine(`\n=== ${title} ===\n${body}`);
  output.show(true);
}

// ---------------------------------------------------------------- commands

async function loadContext(): Promise<void> {
  const args: Record<string, unknown> = {};
  // The workspace path is the only input: the backend resolves it into a project
  // AND a repository. There is no id to keep in sync and none to go stale.
  const dir = workspacePath();
  if (dir) args.path = dir;
  const text = await withProgress("loading session context", () =>
    callTool("repotory_context", args),
  );
  showOutput("Session context", text);
}

async function writeHandoff(): Promise<void> {
  // The project comes from the workspace path, resolved server-side. It used to
  // be that this command simply refused without a hand-typed number, which made
  // the primary write path of the product unusable out of the box.
  const dir = workspacePath();
  if (!dir) {
    void vscode.window.showErrorMessage(
      "Repotory: open a folder — the handoff is attached to the project your workspace resolves to.",
    );
    return;
  }
  const summary = await vscode.window.showInputBox({
    prompt: "Repotory handoff — one paragraph: what was this session about?",
    placeHolder: "e.g. Wired the FTS5 rebuild path; tests green",
    ignoreFocusOut: true,
  });
  if (!summary) return;

  const askList = async (label: string): Promise<string[]> => {
    const raw = await vscode.window.showInputBox({
      prompt: `Repotory handoff — ${label} (comma-separated, empty to skip)`,
      ignoreFocusOut: true,
    });
    return raw
      ? raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  };
  const changes = await askList("changes");
  const nextSteps = await askList("next steps");

  const handoffArgs: Record<string, unknown> = {
    agent: "vscode-extension",
    summary,
    changes,
    next_steps: nextSteps,
    // The path is how the backend picks the project. There is no id to pin, so
    // none is sent — an explicit 0 would be a magic number meaning "unknown".
    path: dir,
  };

  const noteText = await withProgress("writing session handoff", () =>
    callTool("repotory_handoff", handoffArgs),
  );
  showOutput("Handoff recorded", noteText);
  void refreshLastHandoff();
}

/**
 * Run one query and push the hits into the webview.
 *
 * The single search path for both entry points — the webview's own search
 * box and the "Repotory: Search Knowledge" command both end here, so the
 * two can never drift apart (same call, same ranking, same parser).
 */
async function runSearch(view: RepotorySearchViewProvider, query: string): Promise<void> {
  if (!query) {
    view.postHits("", [], scopeLabel());
    return;
  }
  try {
    const searchArgs: Record<string, unknown> = { query };
    // Ranking only: notes recorded in THIS repository lead the result list.
    const dir = workspacePath();
    if (dir) searchArgs.path = dir;
    const text = await withProgress("searching knowledge", () =>
      callTool("repotory_notes_search", searchArgs),
    );
    view.postHits(query, parseSearchHits(text), scopeLabel());
  } catch (err) {
    // A failed search must not look like an empty one (the desktop app's
    // own rule): the view shows the reason instead of a blank list.
    view.postError(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

function scopeLabel(): string {
  const res = lastResolution;
  if (!res?.Project) return "";
  const repo = res.Repository?.path ? res.Repository.path.split(/[\\/]/).pop() : undefined;
  return repo ? `${res.Project.name} · ${repo}` : res.Project.name;
}

/**
 * Fetch the full body of the selected hit.
 *
 * Notes have a row to read (repotory_notes_read → the whole note); todos
 * do not — the matched excerpt is the most the search contract returns, so
 * the pane says "excerpt" rather than pretending it is the full item.
 * Either way the user sees content immediately, never a spinner that dies
 * into an empty pane.
 */
async function selectHit(view: RepotorySearchViewProvider, id: number): Promise<void> {
  try {
    const text = await callTool("repotory_notes_read", { id });
    const detail = parseNoteRead(text);
    if (detail) {
      view.postDetail(detail);
      return;
    }
  } catch {
    /* fall through to the snippet below */
  }
  const hit = view.lastHits.find((h) => h.id === id);
  view.postDetail({
    type: hit?.type ?? "note",
    id,
    project_id: hit?.project_id ?? 0,
    title: hit?.title ?? `note ${id}`,
    body: hit?.snippet ?? "",
    source: "snippet",
  });
}

/** Deep-link a hit into the Repotory web UI, the same routes the JetBrains plugin opens. */
async function openHit(hit: Thumb | undefined): Promise<void> {
  if (!hit) return;
  const route =
    hit.type === "todo"
      ? `/project/${hit.project_id}?tab=todos`
      : `/project/${hit.project_id}?noteId=${hit.id}`;
  const url = `${serverUrl().replace(/\/+$/, "")}${route}`;
  await vscode.env.openExternal(vscode.Uri.parse(url));
}

// ---------------------------------------------------------------- note maintenance
//
// The detail pane is also the note editor: edit a note, create one under the
// same 主题 (project), or let the AI tidy a note. Field writes go through the
// MCP tools (the extension's knowledge transport); the one operation the MCP
// surface deliberately does not carry — moving a note between projects
// (MoveNote is desktop-only by design: re-filing knowledge is a human act) —
// goes over the HTTP RPC bridge the extension already speaks for scope
// resolution. Both paths end in the same service layer, so there is still
// exactly one implementation (ADR-0009).

/** The project list for the editor's 主题 dropdown. */
async function fetchProjectOptions(): Promise<ProjectOption[]> {
  try {
    return parseProjects(await callTool("repotory_projects_list", {}));
  } catch {
    // A missing dropdown degrades to the read-only project chip in the
    // webview; the rest of the editor works without it.
    return [];
  }
}

/** Open the editor on an existing note (its stored fields). */
async function openEditorForNote(view: RepotorySearchViewProvider, id: number): Promise<void> {
  const detail = parseNoteRead(await callTool("repotory_notes_read", { id }));
  if (!detail) {
    view.postError(`Note ${id} could not be read — nothing to edit.`);
    return;
  }
  const projects = await fetchProjectOptions();
  view.postEditor(
    {
      id: detail.id,
      project_id: detail.project_id,
      title: detail.title,
      tags: detail.tags ?? "",
      kind: detail.kind ?? "knowledge",
      content: detail.body,
    },
    projects,
    false,
  );
}

/** Open the editor on a new note under the given 主题 (project). */
async function openEditorForNew(view: RepotorySearchViewProvider, projectId: number): Promise<void> {
  const projects = await fetchProjectOptions();
  view.postEditor(
    { id: 0, project_id: projectId, title: "", tags: "", kind: "knowledge", content: "" },
    projects,
    false,
  );
}

/**
 * Run the AI tidy and open its PROPOSAL in the editor.
 *
 * The service writes nothing: the proposal lands in the same editor a manual
 * edit uses, so reviewing machine-generated wording IS the edit flow, and
 * only the user's save persists it. The stored note is read once more to
 * carry kind/pinned into the draft (the proposal only covers title/tags/
 * content).
 */
async function organizeNoteInView(view: RepotorySearchViewProvider, id: number): Promise<void> {
  const text = await withProgress("tidying note with AI", () =>
    callTool("repotory_notes_organize", { id }),
  );
  const proposal: OrganizeProposal | undefined = parseOrganizeProposal(text);
  if (!proposal) {
    view.postError("AI tidy failed: the service returned no usable proposal.");
    return;
  }
  const stored = parseNoteRead(await callTool("repotory_notes_read", { id }));
  const projects = await fetchProjectOptions();
  view.postEditor(
    {
      id: proposal.note_id || id,
      project_id: stored?.project_id ?? 0,
      title: proposal.title,
      tags: proposal.tags,
      kind: stored?.kind ?? "knowledge",
      content: proposal.content,
    },
    projects,
    true,
    proposal.warning,
  );
}

/**
 * Persist an editor draft: update in place, or create under the chosen 主题.
 *
 * Fields are written first, the 主题 move second: a failed move (the HTTP
 * service is down — MCP works without it) must not lose the edit the user
 * just made. After a successful save the freshly written note replaces the
 * editor, so what is on screen is what is in the store.
 */
async function saveEditorDraft(view: RepotorySearchViewProvider, draft: EditorDraft): Promise<void> {
  try {
    if (draft.id) {
      const updatedText = await callTool("repotory_notes_update", {
        id: draft.id,
        content: draft.content,
        title: draft.title,
        tags: draft.tags,
        category: draft.kind,
      });
      let detail = parseNoteRead(updatedText);
      if (!detail) {
        // The update succeeded (no throw) but the payload is unusable: one
        // more read gets the truth rather than trusting a guess.
        detail = parseNoteRead(await callTool("repotory_notes_read", { id: draft.id }));
      }
      if (!detail) {
        view.postEditorError("Saved, but reading the note back failed — reopen it to see the result.");
        return;
      }
      if (draft.project_id && detail.project_id && draft.project_id !== detail.project_id) {
        try {
          await moveNoteViaRpc(draft.id, draft.project_id);
          detail = { ...detail, project_id: draft.project_id };
        } catch (err) {
          view.postEditorError(
            `Fields saved, but moving the note failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
      }
      view.postSaved(detail);
      return;
    }
    const createdText = await callTool("repotory_notes_create", {
      project_id: draft.project_id,
      title: draft.title,
      content: draft.content,
      tags: draft.tags,
      category: draft.kind,
    });
    const created = parseNoteRead(createdText);
    if (!created) {
      view.postEditorError("Created, but reading the note back failed — search for it to see the result.");
      return;
    }
    view.postCreated(
      { type: "note", id: created.id, project_id: created.project_id, title: created.title, snippet: "" },
      created,
    );
  } catch (err) {
    view.postEditorError(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Move a note to another project over the HTTP RPC bridge.
 *
 * The MCP surface has no move tool on purpose (MoveNote is registered
 * desktop-only: re-filing knowledge is a human decision an agent must not
 * make), and this extension is a human-driven client — the same bridge the
 * JetBrains plugin and the browser frontend use. Throws on failure so the
 * caller can report the partial save honestly.
 */
async function moveNoteViaRpc(noteId: number, projectId: number): Promise<void> {
  const response = (await postJson(serverUrl(), "/api/rpc", {
    method: "MoveNote",
    args: [noteId, projectId],
  })) as { error?: string } | null;
  if (response?.error) {
    throw new Error(response.error);
  }
}

// `repotory-init` is private and is not installed globally, so a shipped VSIX
// cannot assume it exists in the user's project. Prefer the copy bundled into the
// extension itself (scripts/sync-init.mjs puts it there at compile time); fall
// back to a workspace copy so developing inside this repository still uses the
// live source.
async function findInitScript(
  context: vscode.ExtensionContext,
): Promise<vscode.Uri | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const candidates = [vscode.Uri.joinPath(context.extensionUri, "repotory-init", "index.mjs")];
  if (folder) {
    candidates.push(vscode.Uri.joinPath(folder.uri, "scripts", "repotory-init", "index.mjs"));
  }
  for (const candidate of candidates) {
    try {
      await vscode.workspace.fs.stat(candidate);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

/**
 * Run the bundled installer without opening a terminal.
 *
 * The extension host is Electron, so `process.execPath` is the editor binary;
 * ELECTRON_RUN_AS_NODE turns it into a plain Node runtime. Falling back to
 * `node` on PATH covers forks that disable that switch. Only a spawn failure
 * (ENOENT/EACCES) falls back — a non-zero exit is a real installer error and
 * must not be retried with a second runtime.
 */
function runInitScript(
  script: vscode.Uri,
  cwd: string,
  args: string[],
): Promise<void> {
  const attempt = (command: string, env: NodeJS.ProcessEnv): Promise<void> =>
    new Promise((resolve, reject) => {
      execFile(
        command,
        [script.fsPath, ...args],
        { cwd, env, timeout: 60_000, windowsHide: true },
        (err, stdout, stderr) => {
          if (stdout.trim()) output.appendLine(stdout.trim());
          if (stderr.trim()) output.appendLine(stderr.trim());
          if (err) reject(err);
          else resolve();
        },
      );
    });

  return attempt(process.execPath, { ...process.env, ELECTRON_RUN_AS_NODE: "1" }).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT" && err.code !== "EACCES") throw err;
      output.appendLine(`Electron-as-node unavailable (${err.code}); retrying with node on PATH.`);
      return attempt("node", process.env);
    },
  );
}

async function registerMcp(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage(
      "Repotory: 请先打开一个项目文件夹——MCP 注册会写入该项目的 .mcp.json / .vscode/mcp.json / .cursor/mcp.json。",
    );
    return;
  }
  const script = await findInitScript(context);
  if (!script) {
    const choice = await vscode.window.showWarningMessage(
      "Repotory: 扩展内没有找到 repotory-init，请重新安装扩展。",
      "打开文档",
    );
    if (choice === "打开文档") {
      void vscode.env.openExternal(vscode.Uri.parse(AI_INTEGRATION_DOC));
    }
    return;
  }

  const bin = findBinary();
  const args = ["--yes", "--with-hook"];
  if (bin) args.push("--bin", bin);

  await withProgress("registering MCP server", async () => {
    try {
      await runInitScript(script, folder.uri.fsPath, args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const choice = await vscode.window.showErrorMessage(
        `Repotory: 自动注册失败（${message}）。`,
        "查看日志",
        "在终端手动运行",
      );
      if (choice === "查看日志") output.show(true);
      if (choice === "在终端手动运行") {
        // Last-resort escape hatch, not the primary path: the terminal exists
        // only when the silent run could not complete.
        const terminal = vscode.window.createTerminal({ name: "repotory-init", cwd: folder.uri });
        terminal.sendText(
          `node "${script.fsPath}" ${args
            .map((arg) => (arg.includes(" ") ? `"${arg}"` : arg))
            .join(" ")}`,
        );
        terminal.show();
      }
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      "Repotory: MCP 服务器已写入当前项目的客户端配置（Claude Code / Cursor / VS Code / Windsurf），重载窗口后生效。",
      "查看日志",
    );
    if (choice === "查看日志") output.show(true);
  });
}

function binarySourceLabel(source?: BinarySource): string {
  switch (source) {
    case "setting":
      return "设置 repotory.mcpPath";
    case "env":
      return `环境变量 ${MCP_ENV}`;
    case "storage":
      return "扩展存储";
    case "path":
      return "PATH";
    case "common":
      return "常见安装目录";
    default:
      return "";
  }
}

async function resolveWorkspaceForDiagnostics(): Promise<{
  reachable: boolean;
  resolution: WorkspaceResolution | null;
}> {
  const dir = workspacePath();
  if (!dir) return { reachable: true, resolution: null };
  try {
    const response = (await postJson(serverUrl(), "/api/rpc", {
      method: "ResolveWorkspacePath",
      args: [dir],
    })) as { result?: WorkspaceResolution | null };
    return { reachable: true, resolution: response.result ?? null };
  } catch {
    return { reachable: false, resolution: null };
  }
}

async function isMcpRegistered(dir: string | undefined): Promise<boolean> {
  const files = [
    ...(dir
      ? [".mcp.json", path.join(".vscode", "mcp.json"), path.join(".cursor", "mcp.json")]
      : []),
    path.join(os.homedir(), ".codeium", "windsurf", "mcp_config.json"),
  ];
  for (const rel of files) {
    const target = path.isAbsolute(rel) ? rel : path.join(dir ?? "", rel);
    try {
      const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(target));
      if (/"repotory"\s*:/.test(Buffer.from(raw).toString("utf8"))) return true;
    } catch {
      /* missing or unreadable */
    }
  }
  return false;
}

interface DiagnosticAction extends vscode.QuickPickItem {
  run: () => Promise<void>;
}

/**
 * One place that answers "why does this not work?" and offers the fix inline.
 * Every row is clickable: binary missing -> file picker/releases; service down
 * -> re-check; workspace unmatched -> explanation; MCP not registered -> run
 * the bundled installer. This is the GUI replacement for the old
 * "install this, run that command" error dialogs.
 */
async function diagnose(context: vscode.ExtensionContext): Promise<void> {
  const binary = resolveMcpBinary();
  const serverOk = await pingHeadless();
  const dir = workspacePath();
  const workspaceState = await resolveWorkspaceForDiagnostics();
  const registered = await isMcpRegistered(dir);
  const repositoryName = workspaceState.resolution?.Repository?.path
    ? path.basename(workspaceState.resolution.Repository.path)
    : undefined;

  const items: DiagnosticAction[] = [
    {
      label: binary.path ? "$(check) repotory-mcp" : "$(error) repotory-mcp",
      description: binary.path ?? binary.problem ?? "未找到",
      detail: binary.path
        ? `来源：${binarySourceLabel(binary.source)}`
        : "点击选择可执行文件；取消后可改从 Releases 下载",
      run: async () => {
        if (binary.path) {
          output.appendLine(`repotory-mcp: ${binary.path}`);
          output.show(true);
          return;
        }
        const picked = await pickMcpBinary();
        if (!picked) {
          void vscode.env.openExternal(vscode.Uri.parse(RELEASES_URL));
          return;
        }
        await diagnose(context);
      },
    },
    {
      label: serverOk ? "$(check) 本地服务" : "$(warning) 本地服务",
      description: serverOk
        ? serverUrl()
        : `未连接到 ${serverUrl()}（搜索仍可经 repotory-mcp 完成）`,
      detail: serverOk ? "健康检查通过" : "桌面版可在设置中修改 repotory.serverUrl；点击重新检测",
      run: async () => {
        await diagnose(context);
      },
    },
    {
      label: dir
        ? workspaceState.resolution?.Project
          ? "$(check) 工作区"
          : "$(warning) 工作区"
        : "$(circle-slash) 工作区",
      description: !dir
        ? "未打开文件夹"
        : !workspaceState.reachable
          ? "服务不可达，暂时无法解析"
          : workspaceState.resolution?.Project
            ? `${workspaceState.resolution.Project.name}${
                repositoryName ? ` · ${repositoryName}` : ""
              }`
            : "未匹配知识库项目",
      detail: dir ?? "",
      run: async () => {
        if (!dir) {
          void vscode.window.showWarningMessage("先打开一个项目文件夹。");
          return;
        }
        if (!workspaceState.reachable) {
          void vscode.window.showWarningMessage(
            "本地服务不可达，无法解析工作区；启动服务后再检测。",
          );
          return;
        }
        if (!workspaceState.resolution?.Project) {
          void vscode.window.showInformationMessage(
            "该文件夹还不在知识库中：先在 Repotory 桌面应用里扫描/导入；命令本身仍可用。",
          );
          return;
        }
        output.appendLine(
          `workspace: ${dir} -> ${workspaceState.resolution.Project.name}${
            workspaceState.resolution.Repository
              ? ` / ${workspaceState.resolution.Repository.path}`
              : ""
          }`,
        );
        output.show(true);
      },
    },
    {
      label: registered ? "$(check) MCP 客户端配置" : "$(circle-outline) MCP 客户端配置",
      description: registered ? "已写入 repotory 条目" : "当前项目尚未注册",
      detail: dir
        ? "写入 .mcp.json / .vscode/mcp.json / .cursor/mcp.json（后台执行，不打开终端）"
        : "需要先打开项目文件夹",
      run: async () => {
        if (!dir) {
          void vscode.window.showWarningMessage("先打开一个项目文件夹。");
          return;
        }
        await registerMcp(context);
        await diagnose(context);
      },
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: "Repotory 环境诊断",
    placeHolder: "选择一项查看详情或修复",
  });
  if (picked) await picked.run();
}

// 打开 Repotory 桌面应用：优先用平台原生方式启动，找不到时引导到 Releases 下载。
async function openDesktop(): Promise<void> {
  let cmd: string;
  switch (process.platform) {
    case "darwin":
      cmd = "open -a Repotory";
      break;
    case "win32":
      cmd = "start \"\" repotory.exe";
      break;
    default:
      cmd = "repotory";
      break;
  }
  exec(cmd, (err) => {
    if (err) {
      void vscode.window
        .showErrorMessage(
          "Repotory: 桌面应用未找到。请先从 GitHub Releases 下载并安装 Repotory 桌面应用。",
          "打开 Releases 页面",
        )
        .then((choice) => {
          if (choice === "打开 Releases 页面") {
            void vscode.env.openExternal(
              vscode.Uri.parse(
                "https://github.com/sky-jiangcheng/repotory/releases",
              ),
            );
          }
        });
    }
  });
}

// 首次安装引导：让新用户一眼看出这是 Repotory 扩展，并一步进入配置向导。
async function onboard(context: vscode.ExtensionContext): Promise<void> {
  const already = context.globalState.get<boolean>("repotory.onboarded");
  if (already) return;

  const choice = await vscode.window.showInformationMessage(
    "👋 欢迎使用 Repotory。\n\n" +
      "配置向导会自动检测 repotory-mcp、检查本地服务、并把 MCP 写入当前项目——" +
      "不需要手动敲命令。",
    "开始配置",
    "稍后再说",
  );

  if (choice === "开始配置") {
    await diagnose(context);
  }

  await context.globalState.update("repotory.onboarded", true);
}

// ---------------------------------------------------------------- lifecycle

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  output = vscode.window.createOutputChannel("Repotory", { log: true });
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 60);
  statusItem.text = "$(repo) Repotory";
  statusItem.tooltip = "Repotory: click to load the session context";
  statusItem.command = "repotory.loadContext";
  void refreshLastHandoff();

  const searchView = new RepotorySearchViewProvider(context);
  searchView.onSearch = (query) => runSearch(searchView, query);
  searchView.onSelect = (id) => selectHit(searchView, id);
  searchView.onOpen = (hit) => openHit(hit);
  searchView.onEdit = (id) => openEditorForNote(searchView, id);
  searchView.onCreate = (projectId) => openEditorForNew(searchView, projectId);
  searchView.onOrganize = (id) => organizeNoteInView(searchView, id);
  searchView.onSave = (draft) => saveEditorDraft(searchView, draft);
  void refreshScope(searchView);
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refreshScope(searchView)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${CONFIG_SECTION}.${MCP_PATH_KEY}`)) resetMcp();
    }),
  );

  const handoffTimer = setInterval(() => void refreshLastHandoff(), 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(handoffTimer) });

  const register = (id: string, fn: () => Promise<void>) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async () => {
        try {
          await fn();
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Repotory: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    );

  register("repotory.loadContext", loadContext);
  register("repotory.handoff", writeHandoff);
  register("repotory.search", async () => {
    const query = await vscode.window.showInputBox({
      prompt: "Repotory — search notes & todos (FTS5)",
      placeHolder: "e.g. deploy hook",
      ignoreFocusOut: true,
    });
    if (!query) return;
    await runSearch(searchView, query);
  });
  register("repotory.registerMcp", () => registerMcp(context));
  register("repotory.diagnose", () => diagnose(context));
  register("repotory.setMcpPath", async () => {
    await pickMcpBinary();
  });
  register("repotory.openDesktop", () => openDesktop());

  context.subscriptions.push(
    statusItem,
    vscode.window.registerWebviewViewProvider("repotory.notesSearch", searchView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    { dispose: () => mcp?.stop() },
  );

  statusItem.show();
  void pingHeadless().then((ok) => {
    if (!ok) {
      statusItem.tooltip =
        "Headless service not reachable at " +
        serverUrl() +
        " — commands still work through repotory-mcp";
    }
  });
  void onboard(context);
}

export function deactivate(): void {
  mcp?.stop();
}
