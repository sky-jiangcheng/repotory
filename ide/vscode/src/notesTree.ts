// Knowledge search sidebar (tree view "repotory.notesSearch").
// Thin client: renders hits from repotory_notes_search (MCP) or /api/search
// (headless HTTP) — all business logic stays in the Repotory service layer.
import * as vscode from "vscode";
import { excerpt, hitText, type NoteHit } from "./headless.js";

export const MAX_HITS = 50;

// parseSearchHits lives in headless.ts, beside the transport it parses for:
// the payload shape is the MCP tool's contract, not a tree-view detail. It used
// to be here, and it sliced the JSON array from its first "{" — which made
// every search look empty. Parsing is now whole-document (headless.ts).

export class NotesSearchProvider implements vscode.TreeDataProvider<NoteItem> {
  private hits: NoteHit[] = [];
  private scope = "";
  private hint = 'Repotory Knowledge Base — run "Repotory: Search Knowledge" to query your notes & todos';
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  getTreeItem(element: NoteItem): vscode.TreeItem {
    return element;
  }

  /**
   * Announce what the view is scoped to. An idle sidebar that says only "run the
   * search command" is indistinguishable from a broken one, so once the workspace
   * resolves it states the project and repository it will search within.
   */
  setScope(scope: string): void {
    this.scope = scope;
    this.emitter.fire();
  }

  getChildren(): NoteItem[] {
    if (this.hits.length === 0) {
      const label = this.scope ? `${this.scope} — ${this.hint}` : this.hint;
      return [new NoteItem(label, undefined)];
    }
    const items = this.hits.slice(0, MAX_HITS).map((hit) => {
      const title =
        typeof hit.title === "string" && hit.title
          ? hit.title
          : excerpt(hitText(hit), 40) || `note ${String(hit.id ?? "?")}`;
      return new NoteItem(title, hit);
    });
    if (this.hits.length > MAX_HITS) {
      items.push(new NoteItem(`…${this.hits.length - MAX_HITS} more (refine the query)`, undefined));
    }
    return items;
  }

  setHint(hint: string): void {
    this.hits = [];
    this.hint = hint;
    this.emitter.fire();
  }

  setHits(hits: NoteHit[], query: string): void {
    this.hits = hits;
    if (hits.length === 0) this.hint = `No results for "${query}"`;
    this.emitter.fire();
  }
}

export class NoteItem extends vscode.TreeItem {
  constructor(label: string, hit?: NoteHit) {
    super(label, vscode.TreeItemCollapsibleState.None);
    if (!hit) {
      this.contextValue = "hint";
      return;
    }
    // The hit carries a snippet (the matched excerpt), never the full body:
    // the description, the tooltip and the read-only preview all show that.
    // Fetching the whole note would need repotory_notes_read, and this list
    // mixes notes with todos, which have no note row to read.
    const text = hitText(hit);
    const kind = hit.type === "todo" ? "Todo" : "Note";
    const heading = `${kind} ${String(hit.id ?? "?")} — ${label}`;
    this.description = excerpt(text, 60);
    this.tooltip = text || `${heading} (no snippet returned)`;
    const body = text ? `${heading}\n\n${text}\n` : `${heading}\n\n(snippet unavailable)\n`;
    this.command = {
      command: "vscode.open",
      title: "Read Note",
      arguments: [
        vscode.Uri.from({
          scheme: "repotory-notes",
          path: `/note-${String(hit.id ?? "0")}.md`,
          query: Buffer.from(body).toString("base64"),
        }),
      ],
    };
  }
}