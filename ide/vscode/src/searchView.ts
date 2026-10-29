// Repotory knowledge search — a webview view with a T-shaped layout:
//
//   ┌───────────────────────────────────────────────┐
//   │ brand header: mark + wordmark + tagline + scope│  ← identity & promo
//   ├──────────────────────┬────────────────────────┤
//   │ search box           │ detail (defaults to    │
//   │ [notes | wiki pages] │ knowledge thumbnails   │
//   │                      │ (the first hit)        │
//   └──────────────────────┴────────────────────────┘
//
// The thin-client discipline is unchanged: this file renders, it never
// searches. Queries go to the extension host (repotory-mcp over stdio,
// the same path the commands use) and answers come back as messages;
// the full body of a note is fetched on selection via
// repotory_notes_read, the full body of an approved knowledge page via
// repotory_wiki_read. Everything business-side stays in the shared Go
// service layer (ADR-0009).
//
// Two sources, two id spaces. Notes/todos and knowledge pages have separate
// id sequences, so a hit carries the source it came from and the reader keeps
// one space on screen at a time — mixing them would make "id 12" ambiguous
// (the same reason the web app keeps its wiki browse on its own route).
//
// The detail pane doubles as the note maintenance surface (2026-10-23):
// edit a note (title / tags / kind / project), create a new note under the
// same project, and ask the AI to tidy the note — the tidy result is a
// PROPOSAL that opens the same editor, so reviewing machine-generated
// wording IS the edit flow and only the user's save persists it.
import * as vscode from "vscode";
import { excerpt, hitText, parseOrganizeProposal, parseProjects, parseSearchHits, type NoteHit, type OrganizeProposal, type ProjectOption, type WikiPageSummary } from "./headless.js";

export const MAX_HITS = 50;

/**
 * Which knowledge space the sidebar is reading.
 *
 * "notes" = notes + todos (the historical scope, `repotory_notes_search`).
 * "wiki" = the approved knowledge pages (ADR-0032, `repotory_wiki_search`).
 */
export type Source = "notes" | "wiki";

/** One hit as the webview needs it: identity, kind and the matched excerpt. */
export interface Thumb {
  /** Which id space this hit belongs to — "note", "todo" or "wiki". */
  type: string;
  id: number;
  project_id: number;
  title: string;
  snippet: string;
  /** The page kind of a knowledge page (concept / synthesis / entity). */
  pageKind?: string;
  /** The page's slug, shown next to its title in the detail pane. */
  slug?: string;
}

interface Detail {
  type: string;
  id: number;
  project_id: number;
  title: string;
  /** Full body for notes; the matched excerpt for todos (no row to read). */
  body: string;
  source: "note" | "wiki" | "snippet" | "error";
  updated_at?: string;
  tags?: string;
  /** The note's kind, so the editor can round-trip it (notes only). */
  kind?: string;
  /** The page kind of an approved knowledge page (concept / synthesis / entity). */
  pageKind?: string;
  /** The page slug, for an approved knowledge page. */
  slug?: string;
}

/** The editable fields of a note, as the editor pane holds them. */
export interface EditorDraft {
  /** 0 = a new note under `project_id`. */
  id: number;
  project_id: number;
  title: string;
  tags: string;
  kind: string;
  content: string;
}

type ExtMessage =
  | { type: "search"; query: string; source: Source }
  | { type: "source"; source: Source }
  | { type: "select"; id: number }
  | { type: "open"; hit: Thumb }
  | { type: "copy"; text: string }
  | { type: "edit"; id: number }
  | { type: "create"; projectId: number }
  | { type: "organize"; id: number }
  | { type: "save"; draft: EditorDraft }
  | { type: "cancelEdit" };

type ViewMessage =
  | { type: "state"; query: string; scope: string; source: Source; hits: Thumb[]; selectedId?: number }
  | { type: "scope"; scope: string }
  | { type: "detail"; detail: Detail }
  | { type: "error"; message: string }
  | { type: "editor"; draft: EditorDraft; projects: ProjectOption[]; proposal: boolean; warning?: string }
  | { type: "editorError"; message: string }
  | { type: "saved"; detail: Detail }
  | { type: "created"; hit: Thumb; detail: Detail };

// The promo line under the wordmark. It is the only marketing copy in the
// product surface, and it says what the knowledge base actually holds.
const TAGLINE = "The local-first memory layer for AI coding agents";

const KINDS = ["knowledge", "log", "idea", "other"];

function toThumbs(hits: NoteHit[]): Thumb[] {
  return hits.slice(0, MAX_HITS).map((hit) => ({
    type: hit.type ?? "note",
    id: Number(hit.id ?? 0),
    project_id: Number(hit.project_id ?? 0),
    title:
      typeof hit.title === "string" && hit.title
        ? hit.title
        : excerpt(hitText(hit), 40) || `note ${String(hit.id ?? "?")}`,
    snippet: excerpt(hitText(hit), 140),
  }));
}

/**
 * The approved knowledge pages as thumbnails.
 *
 * The id space is separate from the notes' one, so the type carries "wiki" —
 * that is what tells the reader which tool to read the hit back with. The
 * page kind (concept / synthesis / entity) rides along as the badge text.
 */
function toWikiThumbs(pages: WikiPageSummary[]): Thumb[] {
  return pages.slice(0, MAX_HITS).map((page) => ({
    type: "wiki",
    id: Number(page.id ?? 0),
    project_id: Number(page.project_id ?? 0),
    title: typeof page.title === "string" && page.title ? page.title : `page ${String(page.id ?? "?")}`,
    snippet: excerpt(typeof page.snippet === "string" ? page.snippet : "", 140),
    pageKind: typeof page.kind === "string" ? page.kind : "",
    slug: typeof page.slug === "string" ? page.slug : "",
  }));
}

/**
 * The brand mark, inlined so the webview needs no resource roots and no
 * image loads. Same construction as build/icon.svg (the brand SSOT): warm
 * field, hairline ink frame, the brand R.
 */
const MARK_SVG = `<svg viewBox="0 0 512 512" width="34" height="34" aria-hidden="true" focusable="false">
  <rect width="512" height="512" fill="#F5F0E4"/>
  <rect x="26" y="26" width="460" height="460" fill="none" stroke="#1B1B1B" stroke-width="9"/>
  <g transform="translate(21.06 13.06) scale(0.941176)">
    <path fill="#1B1B1B" fill-rule="nonzero" d="M195.6 426H121.56V86H282.79Q306.17 86 325.17 93.79Q344.17 101.59 357.56 115.96Q370.96 130.33 378.26 150.3Q385.57 170.27 385.57 194.62Q385.57 229.21 370.23 255.03Q354.88 280.84 323.71 292.53L390.44 426H308.12L248.69 301.3H195.6ZM273.54 238.95Q290.1 238.95 299.6 230.43Q309.09 221.9 309.09 205.34V183.91Q309.09 167.35 299.6 158.82Q290.1 150.3 273.54 150.3H195.6V238.95Z"/>
  </g>
</svg>`;

function html(nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Repotory Knowledge Search</title>
<style>
  :root {
    --r-border: var(--vscode-panel-border, var(--vscode-contrastBorder, #444));
    --r-muted: var(--vscode-descriptionForeground, #888);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; display: flex; flex-direction: column;
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground, #333);
    background: var(--vscode-sideBar-background, #fff);
  }
  /* ---------- top: identity & promo ---------- */
  header.brand {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 14px 11px; flex: none;
    border-bottom: 1px solid var(--r-border);
  }
  .mark { flex: none; display: block; border-radius: 3px; }
  .wordmark { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .wordmark b { font-size: 14px; font-weight: 700; letter-spacing: 0.02em; }
  .wordmark span { font-size: 11px; line-height: 1.35; color: var(--r-muted); }
  .scope {
    margin-left: auto; flex: none; max-width: 45%;
    font-size: 10px; text-align: right; color: var(--r-muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  /* ---------- body: left list, right detail ---------- */
  main { flex: 1; display: flex; min-height: 0; }
  .list {
    width: 46%; min-width: 170px; max-width: 330px; flex: none;
    display: flex; flex-direction: column;
    border-right: 1px solid var(--r-border);
  }
  .search { padding: 8px; flex: none; }
  /* The source switch: notes and knowledge pages live in separate id spaces,
     so the reader shows one space at a time. */
  .sources { display: flex; gap: 4px; margin-bottom: 6px; }
  .src {
    flex: 1; min-width: 0; padding: 4px 6px; font-size: 11px; cursor: pointer;
    text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: var(--vscode-font-family, sans-serif);
    color: var(--vscode-foreground, #333);
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.18));
    border: 1px solid transparent; border-radius: 4px;
  }
  .src.active {
    color: var(--vscode-button-foreground, #fff);
    background: var(--vscode-button-background, #06c);
  }
  .search input {
    width: 100%; padding: 5px 8px; font-size: 12px;
    font-family: var(--vscode-font-family, sans-serif);
    color: var(--vscode-input-foreground, #333);
    background: var(--vscode-input-background, #fff);
    border: 1px solid var(--vscode-input-border, #ccc);
    border-radius: 4px; outline: none;
  }
  .search input:focus { border-color: var(--vscode-focusBorder, #06c); }
  .thumbs { flex: 1; overflow-y: auto; }
  .thumb {
    padding: 8px 10px; cursor: pointer;
    border-bottom: 1px solid var(--r-border);
    border-left: 2px solid transparent;
  }
  .thumb:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.12)); }
  .thumb.active {
    background: var(--vscode-list-activeSelectionBackground, rgba(0,120,215,.15));
    border-left-color: var(--vscode-focusBorder, #06c);
  }
  .thumb .row { display: flex; align-items: baseline; gap: 6px; }
  .thumb .t {
    flex: 1; min-width: 0; font-size: 12px; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .thumb .s {
    margin-top: 3px; font-size: 11px; line-height: 1.4; color: var(--r-muted);
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .badge {
    flex: none; font-size: 9px; font-weight: 600; letter-spacing: 0.04em;
    text-transform: uppercase; padding: 1px 5px; border-radius: 4px;
    border: 1px solid currentColor;
  }
  .badge.note { color: var(--vscode-textLink-foreground, #06c); }
  .badge.todo { color: var(--vscode-editorWarning-foreground, #b90); }
  .badge.wiki { color: var(--vscode-charts-purple, #8250df); }
  .empty { padding: 18px 14px; font-size: 12px; line-height: 1.5; color: var(--r-muted); }
  /* ---------- detail pane ---------- */
  .detail { flex: 1; min-width: 0; overflow-y: auto; padding: 16px 18px; }
  .detail h2 {
    margin: 0 0 6px; font-size: 16px; font-weight: 700; line-height: 1.3;
    overflow-wrap: anywhere;
  }
  .meta {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
    font-size: 11px; color: var(--r-muted); margin-bottom: 14px;
  }
  .body { font-size: 13px; line-height: 1.65; overflow-wrap: anywhere; }
  .body pre {
    margin: 10px 0; padding: 10px 12px; overflow-x: auto;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.12));
    border-radius: 6px; font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
  }
  .body code {
    padding: 1px 4px; border-radius: 3px;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.12));
    font-family: var(--vscode-editor-font-family, monospace); font-size: 12px;
  }
  .body pre code { padding: 0; background: none; }
  .body h3, .body h4 { margin: 14px 0 6px; }
  .body ul, .body ol { margin: 8px 0; padding-left: 22px; }
  .body a { color: var(--vscode-textLink-foreground, #06c); }
  /* A mermaid fence renders as a labelled diagram card. The webview ships
     no diagram engine (that is a multi-MB dependency for a sidebar), so the
     source stays visible and editable; the desktop app draws it. */
  .diagram {
    margin: 10px 0; border: 1px solid var(--r-border); border-radius: 6px; overflow: hidden;
  }
  .diagram-head {
    padding: 4px 10px; font-size: 10px; font-weight: 600; letter-spacing: .04em;
    text-transform: uppercase; color: var(--r-muted);
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.12));
  }
  .diagram pre { margin: 0; border-radius: 0; }
  .diagram-note {
    padding: 4px 10px; font-size: 10px; color: var(--r-muted);
    border-top: 1px solid var(--r-border);
  }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
  .actions button {
    padding: 5px 12px; font-size: 12px; cursor: pointer;
    font-family: var(--vscode-font-family, sans-serif);
    color: var(--vscode-button-foreground, #fff);
    background: var(--vscode-button-background, #06c);
    border: none; border-radius: 4px;
  }
  .actions button.secondary {
    color: var(--vscode-foreground, #333);
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.18));
  }
  .actions button:hover { filter: brightness(1.12); }
  .actions button:disabled { opacity: .55; cursor: default; filter: none; }
  /* ---------- editor pane (edit / new / AI proposal) ---------- */
  .editor { display: flex; flex-direction: column; gap: 10px; }
  .editor .banner {
    padding: 8px 10px; font-size: 12px; line-height: 1.5;
    border: 1px solid var(--vscode-focusBorder, #06c); border-radius: 6px;
    background: rgba(0,120,215,.08);
  }
  .editor .banner em { display: block; margin-top: 4px; font-style: normal; color: var(--r-muted); }
  .editor .err {
    padding: 8px 10px; font-size: 12px;
    border: 1px solid var(--vscode-errorForeground, #c33); border-radius: 6px;
    background: rgba(204,51,51,.08);
  }
  .editor input[type=text], .editor select, .editor textarea {
    width: 100%; padding: 6px 8px; font-size: 12px;
    font-family: var(--vscode-font-family, sans-serif);
    color: var(--vscode-input-foreground, #333);
    background: var(--vscode-input-background, #fff);
    border: 1px solid var(--vscode-input-border, #ccc);
    border-radius: 4px; outline: none;
  }
  .editor input:focus, .editor select:focus, .editor textarea:focus {
    border-color: var(--vscode-focusBorder, #06c);
  }
  .editor textarea {
    min-height: 180px; resize: vertical; line-height: 1.5;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .editor .row { display: flex; gap: 8px; }
  .editor .row select { flex: 1; min-width: 0; }
  .editor .preview {
    padding: 10px 12px; font-size: 13px; line-height: 1.65;
    border: 1px dashed var(--r-border); border-radius: 6px;
    overflow-wrap: anywhere;
  }
  .editor .preview-label { font-size: 10px; font-weight: 600; letter-spacing: .04em;
    text-transform: uppercase; color: var(--r-muted); margin-bottom: 6px; }
  /* idle / promo pane before the first search */
  .promo { text-align: left; padding: 8px 4px; }
  .promo .mark { width: 56px; height: 56px; margin-bottom: 14px; }
  .promo h2 { margin-bottom: 8px; }
  .promo p { color: var(--r-muted); font-size: 12px; line-height: 1.6; max-width: 46ch; }
  .promo kbd {
    padding: 1px 5px; font-size: 10px; border-radius: 3px;
    font-family: var(--vscode-editor-font-family, monospace);
    border: 1px solid var(--r-border);
  }
</style>
</head>
<body>
<header class="brand">
  <span class="mark">${MARK_SVG}</span>
  <span class="wordmark"><b>Repotory</b><span>${TAGLINE}</span></span>
  <span class="scope" id="scope"></span>
</header>
<main>
  <section class="list">
    <div class="search">
      <div class="sources" role="group" aria-label="Knowledge source">
        <button class="src active" data-source="notes" type="button">Notes &amp; todos</button>
        <button class="src" data-source="wiki" type="button">Wiki pages</button>
      </div>
      <input id="q" type="search" placeholder="Search notes & todos…" spellcheck="false">
    </div>
    <div class="thumbs" id="thumbs"></div>
  </section>
  <section class="detail" id="detail"></section>
</main>
<script nonce="${nonce}">
const MARK_SVG = ${JSON.stringify(MARK_SVG)};
const KINDS = ${JSON.stringify(KINDS)};
const vscode = acquireVsCodeApi();
const q = document.getElementById('q');
const thumbsEl = document.getElementById('thumbs');
const detailEl = document.getElementById('detail');
const scopeEl = document.getElementById('scope');
const srcButtons = Array.from(document.querySelectorAll('.src'));
let hits = [];
let selectedId = undefined;
let debounce = undefined;
// Which knowledge space the sidebar reads: notes/todos or the approved
// knowledge pages. They are separate id spaces, so the reader shows one at a
// time and the host reads a hit back with the tool that owns its space.
let source = 'notes';
// Editor state: null = reading, otherwise the pane holds a draft. A draft
// survives a failed save (the message handler only replaces it on success),
// because losing typed text to a transport error is how people stop trusting
// an editor.
let editor = null;
// The last detail rendered, so Cancel can restore the reading pane without
// another round trip.
let lastDetail = null;

// setSource switches the space the sidebar reads. notify is false when the
// host is the one that switched it, so the two never talk in circles.
function setSource(next, notify) {
  source = next;
  for (const b of srcButtons) b.classList.toggle('active', b.dataset.source === next);
  q.placeholder = next === 'wiki'
    ? 'Search approved knowledge pages…'
    : 'Search notes & todos…';
  if (notify) vscode.postMessage({ type: 'source', source: next });
}

for (const b of srcButtons) {
  b.addEventListener('click', () => setSource(b.dataset.source, true));
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// Minimal markdown for note bodies: the note store is markdown, and a wall
// of raw asterisks undoes the point of a detail pane. Anything unknown is
// escaped and shown verbatim — never dropped.
function md(src) {
  const blocks = [];
  let text = String(src ?? '');
  text = text.replace(/\`\`\`([^\\n]*)\\n([\\s\\S]*?)\`\`\`/g, (_, lang, code) => {
    if (lang.trim().toLowerCase() === 'mermaid') {
      blocks.push('<div class="diagram"><div class="diagram-head">Flowchart · mermaid source</div>' +
        '<pre>' + esc(code.replace(/^\\n/, '')) + '</pre>' +
        '<div class="diagram-note">Renders as a diagram in the Repotory desktop app; the source stays editable here.</div></div>');
    } else {
      blocks.push('<pre><code>' + esc((lang ? lang + '\\n' : '') + code.replace(/^\\n/, '')) + '</code></pre>');
    }
    return '\\u0000' + (blocks.length - 1) + '\\u0000';
  });
  const inline = (s) => esc(s)
    .replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>')
    .replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<strong>$1</strong>')
    .replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, '<a href="$2">$1</a>');
  const out = [];
  let list = null;
  for (const para of text.split(/\\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    if (/^\\u0000\\d+\\u0000$/.test(p)) { out.push(blocks[+p.slice(1, -1)]); list = null; continue; }
    const lines = p.split('\\n');
    let buffer = [];
    const flush = () => { if (buffer.length) { out.push('<p>' + buffer.map(inline).join('<br>') + '</p>'); buffer = []; } };
    for (const line of lines) {
      const h = line.match(/^(#{1,4})\\s+(.*)$/);
      const ul = line.match(/^[-*]\\s+(.*)$/);
      const ol = line.match(/^\\d+[.)]\\s+(.*)$/);
      if (h) { flush(); out.push('<h' + (h[1].length + 2) + '>' + inline(h[2]) + '</h' + (h[1].length + 2) + '>'); }
      else if (ul) { flush(); if (list !== 'ul') { if (list) out.push('</' + list + '>'); out.push('<ul>'); list = 'ul'; } out.push('<li>' + inline(ul[1]) + '</li>'); }
      else if (ol) { flush(); if (list !== 'ol') { if (list) out.push('</' + list + '>'); out.push('<ol>'); list = 'ol'; } out.push('<li>' + inline(ol[1]) + '</li>'); }
      else { if (list) { out.push('</' + list + '>'); list = null; } buffer.push(line); }
    }
    flush();
    if (list) { out.push('</' + list + '>'); list = null; }
  }
  return out.join('\\n');
}

function badge(text, cls) {
  return '<span class="badge ' + esc(cls || text) + '">' + esc(text) + '</span>';
}

// The badge of a hit: a knowledge page shows its page kind (concept /
// synthesis / entity), everything else shows its type (note / todo).
function hitBadge(hit) {
  if (hit.type === 'wiki') return badge(hit.pageKind || 'wiki', 'wiki');
  return badge(hit.type, hit.type);
}

function renderThumbs() {
  if (!hits.length) {
    thumbsEl.innerHTML = '<div class="empty">No knowledge captured for this query yet.<br>Search above, or run <b>Repotory: Search Knowledge</b> from the Command Palette.</div>';
    return;
  }
  thumbsEl.innerHTML = '';
  for (const hit of hits) {
    const el = document.createElement('div');
    el.className = 'thumb' + (hit.id === selectedId ? ' active' : '');
    el.dataset.id = String(hit.id);
    el.innerHTML = '<div class="row">' + hitBadge(hit) + '<span class="t">' + esc(hit.title) + '</span></div>' +
      (hit.snippet ? '<div class="s">' + esc(hit.snippet) + '</div>' : '');
    el.addEventListener('click', () => select(hit.id));
    thumbsEl.appendChild(el);
  }
}

function renderPromo() {
  detailEl.innerHTML = '<div class="promo">' + MARK_SVG +
    '<h2>Knowledge, where you already are.</h2>' +
    '<p>Repotory keeps what your coding agents learn — why a decision was made, what gotcha you hit, what to do next — in a local, searchable store. ' +
    'Everything you capture is one search away; results open in full right here.</p>' +
    '<p>Press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>R</kbd> <kbd>S</kbd> (macOS: <kbd>Ctrl</kbd>+<kbd>Cmd</kbd>+<kbd>R</kbd> <kbd>S</kbd>) to search without touching the mouse.</p>' +
    '</div>';
}

function renderDetail(d) {
  editor = null;
  // The badge is HTML (built by badge()); the rest is escaped text. Joining
  // them through one esc() pass used to print the badge's markup verbatim.
  const metaText = [];
  if (d.type === 'wiki') {
    if (d.slug) metaText.push(d.slug);
    // A global page belongs to no project (ADR-0031): it speaks in every
    // project. Saying "global" is honest; "project 0" is not.
    metaText.push(d.project_id ? 'project ' + d.project_id : 'global');
  } else if (d.project_id) {
    metaText.push('project ' + d.project_id);
  }
  if (d.updated_at) metaText.push('updated ' + d.updated_at.slice(0, 10));
  if (d.tags) metaText.push(d.tags);
  if (d.source === 'snippet') metaText.push('excerpt');
  const badgeHtml = d.type === 'wiki' ? badge(d.pageKind || 'wiki', 'wiki') : badge(d.type, d.type);
  detailEl.innerHTML = '<h2>' + esc(d.title) + '</h2>' +
    '<div class="meta">' + badgeHtml + '<span>·</span> #' + d.id +
    metaText.map((m) => '<span>·</span> ' + esc(m)).join('') + '</div>' +
    '<div class="body">' + (d.body ? md(d.body) : '<p><i>No content returned for this item.</i></p>') + '</div>' +
    '<div class="actions">' +
    (d.type === 'note'
      ? '<button id="edit">Edit</button>' +
        '<button id="new" class="secondary">New note here</button>' +
        '<button id="organize" class="secondary" title="Let the AI restructure this note — review, then save">AI Tidy</button>'
      : '') +
    '<button id="open">Open in Repotory</button>' +
    '<button id="copy" class="secondary">Copy</button>' +
    '</div>';
  const open = document.getElementById('open');
  if (open) open.addEventListener('click', () => {
    vscode.postMessage({ type: 'open', hit: hits.find((h) => h.id === d.id) });
  });
  const copy = document.getElementById('copy');
  if (copy) copy.addEventListener('click', () => {
    vscode.postMessage({ type: 'copy', text: d.title + '\\n\\n' + (d.body ?? '') });
  });
  const edit = document.getElementById('edit');
  if (edit) edit.addEventListener('click', () => vscode.postMessage({ type: 'edit', id: d.id }));
  const add = document.getElementById('new');
  if (add) add.addEventListener('click', () => vscode.postMessage({ type: 'create', projectId: d.project_id }));
  const organize = document.getElementById('organize');
  if (organize) organize.addEventListener('click', () => {
    organize.disabled = true;
    organize.textContent = 'Tidying…';
    vscode.postMessage({ type: 'organize', id: d.id });
  });
}

function kindOptions(selected) {
  return KINDS.map((k) => '<option value="' + k + '"' + (k === selected ? ' selected' : '') + '>' + k + '</option>').join('');
}

function projectOptions(projects, selectedId) {
  return projects.map((p) =>
    '<option value="' + p.id + '"' + (p.id === selectedId ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('');
}

function renderEditor(draft, projects, proposal, warning) {
  editor = draft;
  const banner = proposal
    ? '<div class="banner">AI tidied draft — review, then save.' +
      (warning ? '<em>' + esc(warning) + '</em>' : '') + '</div>'
    : '';
  const err = '<div class="err" id="editor-err" style="display:none"></div>';
  const projectField = projects.length
    ? '<label class="preview-label">Project (项目)</label><select id="e-project">' + projectOptions(projects, draft.project_id) + '</select>'
    : '<input type="text" value="' + esc('project ' + draft.project_id) + '" disabled>';
  detailEl.innerHTML = '<div class="editor">' + banner + err +
    '<label class="preview-label">Title</label>' +
    '<input type="text" id="e-title" value="' + esc(draft.title) + '" placeholder="note title">' +
    '<div class="row">' +
    '<div style="flex:1"><label class="preview-label">Kind</label><select id="e-kind">' + kindOptions(draft.kind) + '</select></div>' +
    '<div style="flex:2"><label class="preview-label">Tags</label><input type="text" id="e-tags" value="' + esc(draft.tags) + '" placeholder="comma, separated"></div>' +
    '</div>' +
    projectField +
    '<label class="preview-label">Content (Markdown)</label>' +
    '<textarea id="e-content" spellcheck="false">' + esc(draft.content) + '</textarea>' +
    '<div class="preview"><div class="preview-label">Preview</div><div id="e-preview-body">' +
    (draft.content ? md(draft.content) : '<i>Nothing to preview yet.</i>') + '</div></div>' +
    '<div class="actions">' +
    '<button id="e-save">' + (draft.id ? 'Save' : 'Create note') + '</button>' +
    '<button id="e-cancel" class="secondary">Cancel</button>' +
    '</div>' +
    '</div>';

  const content = document.getElementById('e-content');
  const preview = document.getElementById('e-preview-body');
  content.addEventListener('input', () => {
    preview.innerHTML = content.value ? md(content.value) : '<i>Nothing to preview yet.</i>';
  });
  document.getElementById('e-save').addEventListener('click', () => {
    const btn = document.getElementById('e-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    const projectSel = document.getElementById('e-project');
    vscode.postMessage({
      type: 'save',
      draft: {
        id: draft.id,
        project_id: projectSel ? Number(projectSel.value) : draft.project_id,
        title: document.getElementById('e-title').value,
        tags: document.getElementById('e-tags').value,
        kind: document.getElementById('e-kind').value,
        content: content.value,
      },
    });
  });
  document.getElementById('e-cancel').addEventListener('click', () => {
    editor = null;
    vscode.postMessage({ type: 'cancelEdit' });
    // Reading state resumes from the last detail the host sent; if none is
    // known, re-select the current hit so the pane is never left blank.
    if (lastDetail) renderDetail(lastDetail);
  });
}

function select(id) {
  selectedId = id;
  renderThumbs();
  // Immediate feedback: the pane shows the hit's title and "loading…"
  // instead of sitting on the previous note until the body arrives.
  const hit = hits.find((h) => h.id === id);
  if (hit) {
    detailEl.innerHTML = '<h2>' + esc(hit.title) + '</h2>' +
      '<div class="meta">' + hitBadge(hit) + '<span>·</span> #' + hit.id + '<span>·</span> loading…</div>' +
      (hit.snippet ? '<div class="body">' + esc(hit.snippet) + '</div>' : '');
  }
  vscode.postMessage({ type: 'select', id });
}

q.addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    vscode.postMessage({ type: 'search', query: q.value.trim(), source });
  }, 300);
});

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'state') {
    hits = msg.hits || [];
    // The host may have switched the space (a command-palette search in the
    // other one): follow it without posting back, so the two never loop.
    if (msg.source && msg.source !== source) setSource(msg.source, false);
    if (msg.query !== undefined && document.activeElement !== q) q.value = msg.query;
    scopeEl.textContent = msg.scope || '';
    scopeEl.title = msg.scope || '';
    // Default selection: the first hit, so the detail pane is never empty
    // while results are on screen.
    if (hits.length && (!selectedId || !hits.some((h) => h.id === selectedId))) {
      selectedId = hits[0].id;
      vscode.postMessage({ type: 'select', id: selectedId });
    }
    if (!hits.length) { selectedId = undefined; editor = null; renderPromo(); }
    renderThumbs();
  } else if (msg.type === 'detail') {
    lastDetail = msg.detail;
    renderDetail(msg.detail);
  } else if (msg.type === 'editor') {
    lastDetail = null;
    renderEditor(msg.draft, msg.projects || [], !!msg.proposal, msg.warning);
  } else if (msg.type === 'editorError') {
    // The draft is kept: the user fixes the transport problem and presses
    // save again, without retyping.
    const err = document.getElementById('editor-err');
    if (err) { err.textContent = msg.message; err.style.display = 'block'; }
    const btn = document.getElementById('e-save');
    if (btn) { btn.disabled = false; btn.textContent = editor && editor.id ? 'Save' : 'Create note'; }
  } else if (msg.type === 'saved') {
    lastDetail = msg.detail;
    renderDetail(msg.detail);
  } else if (msg.type === 'created') {
    if (!hits.some((h) => h.id === msg.hit.id)) hits = [msg.hit, ...hits];
    selectedId = msg.hit.id;
    renderThumbs();
    lastDetail = msg.detail;
    renderDetail(msg.detail);
  } else if (msg.type === 'scope') {
    scopeEl.textContent = msg.scope || '';
    scopeEl.title = msg.scope || '';
  } else if (msg.type === 'error') {
    editor = null;
    detailEl.innerHTML = '<div class="empty">' + esc(msg.message) + '</div>';
  }
});

renderPromo();
</script>
</body>
</html>`;
}

export class RepotorySearchViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = html(nonce());

    webviewView.webview.onDidReceiveMessage((msg: ExtMessage) => {
      switch (msg.type) {
        case "search":
          void this.onSearch?.(msg.query, msg.source);
          break;
        case "source":
          void this.onSource?.(msg.source);
          break;
        case "select":
          void this.onSelect?.(msg.id);
          break;
        case "open":
          void this.onOpen?.(msg.hit);
          break;
        case "copy":
          void vscode.env.clipboard.writeText(msg.text);
          break;
        case "edit":
          void this.onEdit?.(msg.id);
          break;
        case "create":
          void this.onCreate?.(msg.projectId);
          break;
        case "organize":
          void this.onOrganize?.(msg.id);
          break;
        case "save":
          void this.onSave?.(msg.draft);
          break;
        case "cancelEdit":
          /* the webview already restored the reading pane locally */
          break;
      }
    });
  }

  /** Set by the extension: run one query through the shared search path. */
  onSearch?: (query: string, source: Source) => Promise<void> | void;
  /** Set by the extension: the reader switched knowledge spaces. */
  onSource?: (source: Source) => Promise<void> | void;
  /** Set by the extension: fetch the full body of the selected hit. */
  onSelect?: (id: number) => Promise<void> | void;
  /** Set by the extension: deep-link the hit into the Repotory web UI. */
  onOpen?: (hit: Thumb) => Promise<void> | void;
  /** Set by the extension: open the editor for an existing note. */
  onEdit?: (id: number) => Promise<void> | void;
  /** Set by the extension: open the editor for a new note under a project. */
  onCreate?: (projectId: number) => Promise<void> | void;
  /** Set by the extension: run the AI tidy and open its proposal. */
  onOrganize?: (id: number) => Promise<void> | void;
  /** Set by the extension: persist an editor draft (update or create). */
  onSave?: (draft: EditorDraft) => Promise<void> | void;

  /** Push search results into the view (from the command path or the webview box). */
  postHits(query: string, hits: NoteHit[], scope: string): void {
    const thumbs = toThumbs(hits);
    this.lastHits = thumbs;
    this.post({ type: "state", query, scope, source: "notes", hits: thumbs });
  }

  /** Push approved knowledge pages into the view (ADR-0032). */
  postWikiPages(query: string, pages: WikiPageSummary[], scope: string): void {
    const thumbs = toWikiThumbs(pages);
    this.lastHits = thumbs;
    this.post({ type: "state", query, scope, source: "wiki", hits: thumbs });
  }

  /** Clear the list, staying in the given space. */
  postEmpty(source: Source, scope: string): void {
    this.lastHits = [];
    this.post({ type: "state", query: "", scope, source, hits: [] });
  }

  /** The hits currently on screen, so the host can resolve a hit by id. */
  lastHits: Thumb[] = [];

  postDetail(detail: Detail): void {
    this.post({ type: "detail", detail });
  }

  postError(message: string): void {
    this.post({ type: "error", message });
  }

  /** Open the editor pane with a draft (existing note, new note or proposal). */
  postEditor(draft: EditorDraft, projects: ProjectOption[], proposal: boolean, warning?: string): void {
    this.post({ type: "editor", draft, projects, proposal, warning });
  }

  /** A save/create failed: show it inside the editor, keep the draft. */
  postEditorError(message: string): void {
    this.post({ type: "editorError", message });
  }

  /** A save succeeded: swap the editor for the freshly saved note. */
  postSaved(detail: Detail): void {
    this.post({ type: "saved", detail });
  }

  /** A create succeeded: add the new note to the list and show it. */
  postCreated(hit: Thumb, detail: Detail): void {
    this.post({ type: "created", hit, detail });
  }

  setScope(scope: string): void {
    this.post({ type: "scope", scope });
  }

  private post(message: ViewMessage): void {
    void this.view?.webview.postMessage(message);
  }
}

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

/** Parse the repotory_notes_read tool result into the fields the pane shows. */
export function parseNoteRead(text: string): Detail | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const obj = parsed as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object") return undefined;
  const note = (obj.note ?? obj) as Record<string, unknown>;
  const id = Number(note.id ?? 0);
  if (!id) return undefined;
  return {
    type: "note",
    id,
    project_id: Number(note.project_id ?? 0),
    title: typeof note.title === "string" && note.title ? note.title : `note ${id}`,
    body: typeof note.content === "string" ? note.content : "",
    source: "note",
    updated_at: typeof note.updated_at === "string" ? note.updated_at : undefined,
    tags: typeof note.tags === "string" && note.tags ? note.tags : undefined,
    kind: typeof note.kind === "string" && note.kind ? note.kind : undefined,
  };
}

export { parseSearchHits };
export type { OrganizeProposal };
