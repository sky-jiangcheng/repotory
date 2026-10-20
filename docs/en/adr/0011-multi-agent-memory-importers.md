# ADR-0011: Multi-agent memory importers — reusable pipeline + per-source feasibility

- Status: Accepted (2026-10-19: framework + all five sources landed — claude AUTO; codex / opencode / openclaw / hermes (curated + sessions) as opt-in MANUAL; Cursor deferred after verification, see decision 3. Decision 4's dry-run preview shipped: PreviewKnowledgeImport classifies a source's documents against the real idempotency key with zero writes.)
- Date: 2026-10-03
- Relates to: ADR-0002 (in-process plugin runtime), ADR-0007, ADR-0010, TODO M2. (Chinese original: `docs/adr/0011-*.md`.)

## Background

Repotory already has a clean pipeline: a `plugin.KnowledgeImporter` yields `[]plugin.ImportDoc` → registered via `Runtime.RegisterSource` → `upsertDoc` idempotently upserts notes keyed by (project, source, title). Originally only Claude was implemented. M2 extends it to other agents, whose on-disk formats are undocumented and drift.

## Decision

1. **Reuse the pipeline**, no new mechanism — each source is a Go `KnowledgeImporter`.
2. **Shared helpers extracted when the 2nd source landed** (`internal/importers/memsrc`: `MatchProject`, `ReadCapped`, `TargetProject`, `StripFrontmatter`, `ClipToBytes`).
3. **Per-source feasibility, verified against real files (never guessed):**
   - **codex** ✅ `~/.codex/sessions/**/rollout-*.jsonl` (streaming; `cwd`→project).
   - **opencode** ✅ `~/.local/share/opencode/storage/session/<hash>/ses_*.json` (already summarized: title/summary/directory).
   - **openclaw** ✅ global `~/.openclaw-autoclaw/workspace/*.md`.
   - **hermes** (Nous Research, separate product) ✅ curated `~/.hermes/memories/*.md` + sessions (since 2026-10-13, from `$HERMES_HOME/state.db`; see the implementation-correction note at the end of the Chinese ADR for the schema, verified against TencentDB-Agent-Memory's shipped asset importer).
   - **cursor** — verified → **deferred**: history is in an unofficial `state.vscdb` (bubble blobs + versioned headers + ProseMirror; no project path in-DB) → low-ROI/fragile.
4. **Opt-in by default**: raw transcripts / global memory are privacy-sensitive → `RegisterSourceManual` excludes them from startup auto-import (`ImportAll` runs curated sources only). Global-memory sources attach to a config-named target project (`openclaw_project`/`hermes_project`); unset → skipped.
5. **Security**: OpenClaw/Hermes homes contain private keys / `.env` / vaults → importers are **hard-allowlisted to the one memory dir, non-recursive** (asserted by tests).

## Consequences

- Positive: multi-agent memory flows into one KB via a pattern every source reuses.
- Risk: each source is maintenance debt bound to an upstream format; mitigated by golden-file tests + lenient parse + verify-first gate.

> **Real-machine verification (2026-10-20): the Hermes sessions chain works end to end; the schema evidence is upgraded to the official documentation.** `hermes-agent` is an open-source (MIT) Nous Research project, and the official developer doc `session-storage.md` documents the `state.db` layout directly (`sessions` / `messages` / FTS5 / `schema_version`, WAL mode) — `messages(session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp)` matches this ADR's read columns exactly, upgrading the "TencentDB-Agent-Memory shipped-consumer" evidence to "official docs + real-machine data". v0.22.2 was installed on this machine via the official install.sh (the HTTPS clone timed out → `HERMES_REPO_URL` pointed at the SSH remote), configured against LM Studio (`model.provider=lmstudio`, bonsai-27b), and `hermes chat --oneshot` produced the first real `state.db` (`source='oneshot'` — the importer does not filter by source, so oneshot sessions are read like any other). Sandbox-database import against the real data: detection ✓ (state.db alone marks the source detected), first import created=1, re-run idempotent updated=1, and a missing memories/ directory degrades to a graceful no-op. No layout drift was observed.