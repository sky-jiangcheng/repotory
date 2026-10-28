// Thin HTTP helper for the Repotory headless service (repotory server).
// The headless API is loopback-only by design (see internal/httpapi/server.go).
import * as http from "node:http";

export function getJson(base: string, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, { method: "GET" }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`invalid JSON from ${path}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(4000, () => {
      req.destroy(new Error(`timeout: ${path}`));
    });
    req.end();
  });
}

export function postJson(base: string, path: string, body: unknown): Promise<unknown> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      base + path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`invalid JSON from ${path}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(4000, () => {
      req.destroy(new Error(`timeout: ${path}`));
    });
    req.end(payload);
  });
}

// NoteHit mirrors domain.SearchHit as it crosses the wire (internal/domain/
// types.go): type/id/project_id/title/snippet. There is no "content" field — the
// server sends only the matched excerpt (snippet). `content` is kept as a
// tolerated alias for older/alternative payloads, nothing more.
export interface NoteHit {
  type?: string;
  id?: number;
  project_id?: number;
  title?: string;
  snippet?: string;
  content?: string;
  [key: string]: unknown;
}

/**
 * Parse the text returned by the `repotory_notes_search` MCP tool into hits.
 *
 * The tool result is a *JSON array*, not an object: cmd/mcp/results.go's
 * makeJSONResult ignores its name argument and marshals []domain.SearchHit
 * directly, so the body starts with "[" — never "{". The sidebar used to slice
 * the document from its first "{" before parsing, which dropped the leading "["
 * of every real payload and made the whole list render as "No results".
 *
 * Whole-document parse first (the array, and the legacy {"hits":[…]} envelope,
 * both succeed here); only if that fails do we tolerate a preamble by retrying
 * from each candidate "[" / "{" boundary.
 */
export function parseSearchHits(text: string): NoteHit[] {
  const parsed = parseJsonLenient(text);
  if (parsed === undefined) return [];
  return toHits(parsed);
}

/**
 * Parse a tool result as JSON, tolerating a preamble.
 *
 * The tool results are bare JSON documents; the tolerant retry only runs when
 * the whole-document parse fails, so a well-formed payload is never re-cut.
 */
function parseJsonLenient(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to the tolerant path */
  }
  const starts = [trimmed.indexOf("["), trimmed.indexOf("{")].filter((i) => i >= 0).sort((a, b) => a - b);
  for (const start of starts) {
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      /* try the next boundary */
    }
  }
  return undefined;
}

function toHits(parsed: unknown): NoteHit[] {
  if (Array.isArray(parsed)) return parsed as NoteHit[];
  const hits = (parsed as { hits?: unknown } | null)?.hits;
  if (Array.isArray(hits)) return hits as NoteHit[];
  const notes = (hits as { notes?: unknown } | null)?.notes;
  if (Array.isArray(notes)) return notes as NoteHit[];
  return [];
}

/** The display text of a hit: the matched snippet, with `content` as a fallback. */
export function hitText(hit: NoteHit): string {
  if (typeof hit.snippet === "string" && hit.snippet) return hit.snippet;
  if (typeof hit.content === "string" && hit.content) return hit.content;
  return "";
}

/**
 * One approved knowledge page as it crosses the wire
 * (service.WikiPageSummary): identity, kind, scope and the matched excerpt.
 *
 * `project_id` is 0 for a global page (ADR-0031): it speaks for no single
 * project, which the reader must be able to SEE rather than infer.
 */
export interface WikiPageSummary {
  id?: number;
  slug?: string;
  title?: string;
  kind?: string;
  project_id?: number;
  updated_at?: string;
  snippet?: string;
  [key: string]: unknown;
}

/** One approved page in full (service.WikiPageDetail). */
export interface WikiPageDetail {
  id: number;
  slug: string;
  title: string;
  kind: string;
  project_id: number;
  updated_at: string;
  content: string;
  source: string;
}

/**
 * Parse the `repotory_wiki_search` tool result into page summaries.
 *
 * The result is a bare JSON array, like every other list tool (see
 * parseSearchHits) — the same tolerant parse applies.
 */
export function parseWikiPages(text: string): WikiPageSummary[] {
  const parsed = parseJsonLenient(text);
  if (!Array.isArray(parsed)) return [];
  return parsed as WikiPageSummary[];
}

/**
 * Parse the `repotory_wiki_read` tool result into one page.
 *
 * A shape check, not a repair pass: an unusable payload returns undefined and
 * the caller falls back to the matched excerpt, because a pane that shows
 * nothing is worse than one that shows the excerpt and says so.
 */
export function parseWikiRead(text: string): WikiPageDetail | undefined {
  const parsed = parseJsonLenient(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const page = parsed as Record<string, unknown>;
  const id = Number(page.id ?? 0);
  if (!id) return undefined;
  return {
    id,
    slug: typeof page.slug === "string" ? page.slug : "",
    title: typeof page.title === "string" && page.title ? page.title : `page ${id}`,
    kind: typeof page.kind === "string" ? page.kind : "",
    project_id: Number(page.project_id ?? 0),
    updated_at: typeof page.updated_at === "string" ? page.updated_at : "",
    content: typeof page.content === "string" ? page.content : "",
    source: typeof page.source === "string" ? page.source : "",
  };
}

export function excerpt(text: unknown, max = 90): string {
  if (typeof text !== "string") return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One project as the webview's project dropdown needs it. */
export interface ProjectOption {
  id: number;
  name: string;
}

/**
 * Parse the `repotory_projects_list` tool result into dropdown options.
 *
 * Same whole-document-first discipline as parseSearchHits: the tool returns
 * a bare JSON array, and a tolerant retry only runs when that fails.
 */
export function parseProjects(text: string): ProjectOption[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ProjectOption[] = [];
  for (const raw of parsed) {
    const obj = raw as Record<string, unknown> | null;
    const id = Number(obj?.id ?? 0);
    if (!id) continue;
    const name = typeof obj?.name === "string" && obj.name ? obj.name : `project ${id}`;
    out.push({ id, name });
  }
  return out;
}

/** The AI tidying proposal as the webview needs it: fields plus caveats. */
export interface OrganizeProposal {
  note_id: number;
  title: string;
  content: string;
  tags: string;
  warning?: string;
}

/**
 * Parse the `repotory_notes_organize` tool result. The service already
 * backfills an empty title from the stored note and clips fields to the
 * store's bounds, so this is a shape check, not a repair pass: an unusable
 * payload returns undefined and the caller shows the raw error instead of
 * opening an editor with half a draft.
 */
export function parseOrganizeProposal(text: string): OrganizeProposal | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return undefined;
  }
  const obj = parsed as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object") return undefined;
  const content = typeof obj.content === "string" ? obj.content : "";
  if (!content.trim()) return undefined;
  return {
    note_id: Number(obj.note_id ?? 0),
    title: typeof obj.title === "string" ? obj.title : "",
    content,
    tags: typeof obj.tags === "string" ? obj.tags : "",
    warning: typeof obj.warning === "string" && obj.warning ? obj.warning : undefined,
  };
}