// api/types.ts — Payload types shared between the Wails bindings and the
// (standalone-dev) HTTP fallback. Mirrors the Go types in internal/domain and
// internal/service.

export interface Project {
  id: number
  name: string
  root_path: string
  level_override: number
  is_auto_grouped: boolean
  is_starred: boolean
  created_at: string
  // 'scanned' | 'import_placeholder' | 'default' (ADR-0023). The dashboard shows
  // placeholder/default buckets with a badge so unfiled knowledge is visible.
  // Optional only so pre-existing test mocks keep compiling — the Go binding
  // always sends it (json tag, no omitempty), so runtime values are never absent.
  project_kind?: string
  repo_count: number
  total_added: number
  total_deleted: number
  my_added: number
  my_deleted: number
  my_files: number
  // 7-day personal additions over the window ending on the same anchor date as
  // my_added. Surfaces that rank by "recent" activity (the search page's hot
  // projects) must use this: my_added is a single-day metric and reads 0 on any
  // day without personal commits, which would silently rank alphabetically.
  my_added_7d: number
  is_workday: boolean
  below_standard: boolean
}

export interface MergeSibling {
  id: number
  name: string
  root_path: string
  repos: number
  notes: number
  todos: number
}

// What a "merge up" would swallow. Built server-side from the same listing the
// merge consumes, so the confirmation dialog cannot understate the damage.
export interface MergePreview {
  target_id: number
  target_name: string
  new_root: string
  siblings: MergeSibling[]
  repos: number
  notes: number
  todos: number
}

export interface ProjectDetail {
  id: number
  name: string
  root_path: string
  level_override: number
  is_auto_grouped: boolean
  // See Project.project_kind — always present from Go, optional for mocks.
  project_kind?: string
  repos: RepoInfo[]
}

// OrganizeGroup mirrors internal/domain.OrganizeGroup (ADR-0023): a landing
// project (import placeholder / the default bucket) that still holds unfiled
// notes, offered for reassignment in the knowledge-base organize view.
export interface OrganizeGroup {
  project_id: number
  name: string
  root_path: string
  kind: string
  note_count: number
  repo_bound: boolean
}

export interface RepoInfo {
  id: number
  path: string
  project_id: number
  last_scanned_at: string
  stats: DailyStat[]
  /** Browsable commit log for the repo's origin remote; '' when it has none. */
  web_url?: string
}

/**
 * One commit, read from git on demand. `hash` is the full SHA — it is what
 * makes a row actionable (cherry-pick, forge search), so the UI exposes it for
 * copy rather than treating the commit as read-only text.
 */
export interface RepoCommit {
  hash: string
  time: string
  message: string
  author: string
  repo: string
  branch: string
}

export interface DailyStat {
  id: number
  repository_id: number
  stat_date: string
  author: string
  files_changed: number
  lines_added: number
  lines_deleted: number
}

export interface Summary {
  date: string
  repo_count: number
  total_files: number
  total_added: number
  total_deleted: number
  my_added: number
  my_deleted: number
  my_files: number
  is_workday: boolean
}

export interface AppConfig {
  config: Record<string, string>
  scan_roots: string[]
}

/**
 * State of the AI call audit plugin (ADR-0030).
 *
 * The counters are read from the recent-call window, not from the whole
 * table: the table has no retention policy (an audit trail that can be
 * quietly pruned is not one), so a lifetime count is not available by
 * design.
 */
export interface AIAuditStatus {
  audit_enabled: boolean
  review_input: boolean
  review_output: boolean
  rule_count: number
  call_count: number
  blocked_count: number
  flagged_count: number
  surface: string
  table_exists: boolean
  /**
   * The retention POLICY as a machine-readable token ("append_only"), not a
   * sentence. The UI renders it in the reader's own language.
   */
  retention: string
}

/**
 * One audited model call.
 *
 * There is deliberately no prompt or response field: the audit trail stores
 * a SHA-256 hash and a character count, never the text. That is what keeps
 * the trail from becoming a second copy of the knowledge base.
 */
export interface AICallLogEntry {
  id: number
  created_at: string
  surface: string
  endpoint: string
  model: string
  prompt_hash: string
  prompt_chars: number
  response_chars: number
  input_verdict: string
  output_verdict: string
}

export interface Todo {
  id: number
  project_id: number
  title: string
  completed: boolean
  priority: number
  sort_order: number
  created_at: string
  updated_at: string
}

export type NoteKind = 'knowledge' | 'log' | 'idea' | 'other'

export interface Note {
  id: number
  project_id: number
  title: string
  content: string
  tags: string
  kind: string
  pinned: boolean
  source: string
  // Derived display bucket of `source` (ADR-0022 决策 4): "agent-import" |
  // "user-conversation" | "project-extract" | "manual". Filled by the server,
  // never computed here — one mapping, one truth.
  source_type?: string
  // The topic this note is filed under, inside its project (schema v27:
  // project -> topic -> note). topic_id is 0 when the note has no topic —
  // a legitimate state, since every note written before v27 has none.
  topic_id: number
  // The topic's display name, filled by the server alongside topic_id.
  topic_name?: string
  sort_order: number
  created_at: string
  updated_at: string
}

// NoteTopic is one topic of one project — the layer between a project and the
// notes filed under it (schema v27). A topic belongs to exactly one project,
// so the same subject name in two projects is two topics.
export interface NoteTopic {
  id: number
  project_id: number
  name: string
  description: string
  sort_order: number
  // How many notes are filed under this topic.
  note_count: number
  created_at: string
  updated_at: string
}

// A note joined with its parent project, for the global knowledge hub.
export interface NoteWithProject extends Note {
  project_name: string
  root_path: string
}

export interface NoteVersion {
  id: number
  note_id: number
  title: string
  content: string
  tags: string
  kind: string
  created_at: string
}

/**
 * The AI's tidying proposal for one note (internal/service/note_organize.go).
 * A PROPOSAL, never a write: the caller puts it into the note editor and the
 * user's own save lands it. `warning` carries non-fatal caveats (a truncated
 * reply, a model that ignored the output protocol) that must be shown next to
 * the draft rather than swallowed.
 */
export interface NoteOrganizeResult {
  note_id: number
  title: string
  content: string
  tags: string
  warning?: string
}

export interface Tech {
  name: string
  category: string
}

export interface LanguageStat {
  language: string
  count: number
}

export interface Dependency {
  name: string
  version: string
  source: string
}

export interface TopContributor {
  author: string
  count: number
}

export interface ActivityStat {
  total_commits: number
  active_days: number
  last_commit_date: string
  commit_rate_30d: number
  active_months: number
}

export interface RecentCommit {
  time: string
  message: string
  author: string
  repo: string
  branch: string
}

export interface ProjectOverview {
  readme_excerpt: string
  tech_stack: Tech[]
  languages: LanguageStat[]
  dependencies: Dependency[]
  top_contributors: TopContributor[]
  activity: ActivityStat | null
  recent_commits: RecentCommit[]
  cached: boolean
}

export interface ImportResult {
  synced: number
  updated: number
  skipped: number
}

export interface SearchHit {
  type: 'note' | 'todo'
  id: number
  project_id: number
  project_name: string
  title: string
  snippet: string
  tags?: string
  updated_at: string
}

export interface TodoCount {
  project_id: number
  count: number
  total: number
}

export interface NoteCount {
  project_id: number
  count: number
}

export interface HeatmapDay {
  date: string
  lines_added: number
  lines_deleted: number
  commits: number
}

export interface HeatmapResponse {
  days: HeatmapDay[]
}

export interface StatusBarData {
  current_time: string
  last_commit_time: string
  last_commit_repo: string
  last_commit_branch: string
  last_commit_msg: string
}

export interface ScanStatus {
  running: boolean
  backfilling: boolean
  message: string
  progress: number
  total: number
}

export interface SourceStatus {
  name: string
  plugin: string
  detected: boolean
  enabled: boolean
  detail: string
  // Derived display bucket: 'agent-import' | 'user-conversation' |
  // 'project-extract' | 'manual' (mirrors runtime.SourceType).
  type: string
  // Per-source sync trail (ADR-0022 决策 3). The round-level status says
  // "the last sync had a problem"; these say WHICH source and when.
  last_run?: string
  last_error?: string
}

export interface ImportRun {
  created: number
  updated: number
  skipped: number
}

export interface ImportPreviewItem {
  title: string
  action: 'create' | 'update' | 'skip'
  project_id: number
}

// What a knowledge source WOULD import, classified without writing anything
// (ADR-0011 decision 4 dry-run).
export interface ImportPreview {
  source: string
  created: number
  updated: number
  skipped: number
  items: ImportPreviewItem[]
}

// KnowledgeSyncStatus reports the periodic knowledge sync's last round
// (matches Go service.KnowledgeSyncStatus).
export interface KnowledgeSyncStatus {
  last_run: string
  last_error: string
}

// HandoffEntry is one row of the first-screen memory ring (D25): a handoff
// note as a content-free entry point. Opening an entry routes to the project;
// the body stays on the knowledge page. Matches Go service.HandoffEntry.
export interface HandoffEntry {
  note_id: number
  project_id: number
  project_name: string
  title: string
  updated_at: string
  auto_captured: boolean
}

// HandoffResult is what a session capture persists (matches Go service.HandoffResult).
export interface HandoffResult {
  note_id: number
  title: string
  tags: string
}
export interface ImportCompletedEvent {
  source: string
  created: number
  updated: number
  skipped: number
  error?: string
}

// Evidence layer (ADR-0014 M6-W2): the retrieved, citable context an AI answer
// was built from, plus the budget accounting that shaped it.
export interface EvidenceItem {
  ref: string // "P1" / "N2" — positional label from this retrieval only
  // 'todo' never comes from the server (GatherEvidence emits page|note only);
  // it marks the local no-AI fallback cards built from SearchAll hits.
  type: 'page' | 'note' | 'todo'
  id: number
  project_id?: number
  project_name?: string
  title: string
  slug?: string
  kind: string
  snippet: string
  rank: number
  source_path?: 'fts' | 'graph' | 'semantic' | 'fact' | string
}

export interface Evidence {
  items: EvidenceItem[]
  dropped: number
  elapsed_ms: number
  truncated: boolean
}

export interface EvidenceAnswer {
  reply: string
  evidence: Evidence
  // True when the server cut the reply off (finish_reason "length") instead of
  // the model finishing. A half-sentence answer is indistinguishable from a
  // complete one on screen, so the panel has to say so itself.
  truncated?: boolean
}

// --- Wiki review & compile jobs (ADR-0015 / ADR-0016) -----------------------
// Shapes mirror internal/db.WikiPage / PageEdge / CompileJob and
// internal/service.WikiPendingPage. Kept here rather than inlined so the review
// tab and the endpoints agree on one definition.

export interface WikiPage {
  id: number
  slug: string
  title: string
  kind: string
  project_id: number
  content: string
  updated_at: string
  status: string
  source: string
}

export interface PageEdge {
  page_id: number
  slug: string
  title: string
  kind: string
  relation: string
  inbound: boolean
}

export interface WikiPendingPage {
  page: WikiPage
  source_note_ids: number[]
  out_links: PageEdge[]
  in_links: PageEdge[]
}

export interface CompileJob {
  id: number
  project_id: number
  // 'compile' | 'lint' — one queue, two kernels (ADR-0016 待决 ①). The counters
  // below mean different things per kind, so a row must be labelled before it is
  // rendered: notes_done is "notes compiled" for one and "pages linted" for the other.
  kind: string
  requested_notes: number
  status: string
  notes_total: number
  notes_done: number
  pages_created: number
  pages_updated: number
  links_created: number
  attachments: number
  revision_todos: number
  rejected_ops: number
  // Lint jobs only: findings filed as todos. Always 0 for a compile job.
  findings: number
  stopped?: string
  note?: string
  // Either one of the backend's stable failure codes (db.CompileJobErr* — the
  // review page maps those to localized copy) or a wrapped Go error, which is
  // diagnostic text and stays verbatim.
  error?: string
  created_at: string
  started_at?: string
  finished_at?: string
}

// --- Concept merge (ADR-0019) -------------------------------------------------
// Shapes mirror internal/service.MergeCandidate{,Report} and internal/db.MergeResult.

/**
 * One pair of pages that look like the same concept twice. The direction is
 * PROVISIONAL (structural evidence only): the loser is the page that would be
 * absorbed, the winner the one whose row stays untouched.
 */
export interface MergeCandidate {
  winner_id: number
  winner_slug: string
  loser_id: number
  loser_slug: string
  score: number
  signals: string[]
  shared_notes: number
  project_id: number
}

export interface MergeCandidateReport {
  project_id: number
  pages: number
  pairs_scored: number
  pairs_possible: number
  candidates: MergeCandidate[]
  truncated: boolean
}

export interface WikiLinkSuggestion {
  slug: string
  title: string
  kind: string
  page_id: number
  matched: string
}

/** What an executed absorption actually moved. All-zero is how a replay of a
 *  finished merge shows itself. */
export interface MergeResult {
  loser_id: number
  loser_slug: string
  winner_id: number
  winner_slug: string
  edges_redirected: number
  edges_dropped: number
  notes_reattached: number
  loser_previous_status: string
}

// --- Community synthesis (ADR-0020) -------------------------------------------
// Mirrors internal/service.WikiCommunityReport. The structural half is free and
// always present; the generation half is zero when the consent gate is off, in
// which case llm_note says so and must be shown instead of the zeros.
export interface WikiCommunityReport {
  project_id: number
  approved_pages: number
  edges: number
  communities_found: number
  dropped_small: number
  dropped_large: number
  isolated: number
  rounds: number
  converged: boolean
  pages_created: number
  pages_updated: number
  documents_linked: number
  notes_attached: number
  revision_todos: number
  empty_bodies: number
  summarized_slugs: string[]
  skipped_by_budget: string[]
  outbound_bytes: number
  calls: number
  community_gate_off: boolean
  llm_note?: string
  elapsed_ms: number
  run_at: string
}

// --- Wiki page version snapshots (ADR-0021) -----------------------------------
// Mirrors internal/db.PageVersion: one frozen snapshot of a page's APPROVED
// content, written by a database trigger. Newest first, as returned.
export interface WikiPageVersion {
  id: number
  page_id: number
  title: string
  content: string
  kind: string
  source: string
  created_at: string
}

// --- Update check -------------------------------------------------------------
// Mirrors internal/service.UpdateInfo: the verdict of one GitHub Releases
// check. The app downloads the bundle and verifies its digest, but it never
// replaces its own binary — the verified file is handed to the OS installer.

// One downloadable file attached to a release.
export interface UpdateAsset {
  name: string
  url: string
  size: number
  // digest is the digest the release API publishes for this asset, in
  // "sha256:<hex>" form. Empty when the release carries none.
  digest: string
}

export interface UpdateInfo {
  // current is the running build's version.
  current: string
  // latest is the newest published tag, without the "v" prefix.
  latest: string
  // has_update is true when latest is a higher semver than current.
  has_update: boolean
  // release_url is the human-facing release page.
  release_url: string
  // published_at is the release timestamp (RFC 3339).
  published_at: string
  // notes is the release body, truncated by the backend.
  notes: string
  // assets are the release's app bundles (MCP server / plugin archives excluded).
  assets: UpdateAsset[]
  // download_url / download_name point at the bundle built for this platform.
  // Empty when the release ships none for it — the UI falls back to the page.
  download_url: string
  download_name: string
  // download_sha256 is the digest the release published for that bundle.
  download_sha256: string
  // download_size is the bundle's size in bytes, 0 when unknown.
  download_size: number
}

/**
 * Mirrors internal/service.DownloadState: the progress of the in-app update
 * download.
 */
export type DownloadPhase =
  /** No download has started. */
  | 'idle'
  /** Bytes are moving. */
  | 'running'
  /** The file is complete and its digest is being checked. */
  | 'verifying'
  /** The file is downloaded and its digest matched. */
  | 'done'
  /** The download or the verification failed. */
  | 'failed'
  /** The user canceled the download. */
  | 'canceled'

export interface DownloadState {
  phase: DownloadPhase
  /** The release tag this download belongs to. */
  version: string
  /** The bundle's file name. */
  file_name: string
  /** Bytes written so far. */
  downloaded: number
  /** Expected size in bytes, 0 when unknown. */
  total: number
  /** Smoothed transfer rate in bytes per second. */
  speed: number
  /** ETA in seconds, -1 when it cannot be estimated. */
  remaining_seconds: number
  /** The local file path, set once the download completes. */
  path: string
  /** The failure reason when phase is 'failed'. */
  error: string
  /** Whether the digest matched the one the release published. */
  checksum_verified: boolean
}
