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
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    return toHits(JSON.parse(trimmed));
  } catch {
    /* fall through to the tolerant path */
  }
  const starts = [trimmed.indexOf("["), trimmed.indexOf("{")].filter((i) => i >= 0).sort((a, b) => a - b);
  for (const start of starts) {
    try {
      return toHits(JSON.parse(trimmed.slice(start)));
    } catch {
      /* try the next boundary */
    }
  }
  return [];
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

export function excerpt(text: unknown, max = 90): string {
  if (typeof text !== "string") return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}