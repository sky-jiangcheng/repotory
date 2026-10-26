# ADR-0031: Global page scope — giving the cross-project profile layer a human-filled entry point

- Status: Accepted (**implemented and rehearsed against a live-database copy on 2026-10-26**. db-layer `SetWikiPageScope`; service layer `PromoteWikiPageToGlobal` / `AssignWikiPageProject` / `ListApprovedWikiPages`; a new "Page scope" area on the review page; all three bindings registered in `bindingSurfaces` as desktop-only)
- Date: 2026-10-26
- Related: [ADR-0014](0014-llm-wiki-knowledge-compiler.md) (the compiled-knowledge layer — where pages come from), [ADR-0015](0015-w3-minimal-compile-loop.md) (**the red line this ADR is derived from**: only a human publishes into retrieval), [ADR-0019](0019-entity-resolution-merge.md) (the same species of decision: a merge is always triggered by a human), [ADR-0006](0006-scope-freeze.md) (scope freeze — this ADR widens no product boundary), [ADR-0030](0030-ai-call-audit.md) (the contemporaneous trust-surface argument style)
- Starting schema: v28 (**this ADR changes no schema** — the global tier reuses the NULL semantics `wiki_pages.project_id` already had)

## Background

### Fact one: L3 is structurally empty

`repotory_context` assembles four layers: L3 cross-project profile / L2 project scenario / L1 curated notes / L0 raw transcripts. L3 selects pages at `internal/service/context_layers.go:216`:

```go
if p.ProjectID != 0 || p.Status != db.WikiStatusApproved {
    continue
}
```

And **every page-creating path forces a project id**: the compiler (`wiki_compile.go`), community synthesis (`wiki_community.go`), answer filing (`FileAnswerAsPage`), hand-written pages (`CreateWikiPage`). No path can produce a page with `project_id = 0`.

Measured on the live library (2026-10-26, read-only query): 45 wiki pages, **0 global pages** (approved 27 / rejected 18). In other words L3 has been empty since it was written — **not "not enough data" but "structurally impossible"**. The layer is written to answer "what is this person like across projects", and the only answer it could ever give was "nothing".

### Fact two: the schema already reserved the global page

Design note #1 in `internal/db/wiki.go` says *"project_id is nullable (a page may span projects)"*; `CreateWikiPageAs` has always written `var pid any; if projectID > 0 { pid = projectID }` — passing 0 stores SQL **NULL**. `internal/db/wiki_merge.go:103-105` goes further: *"A global page (project_id 0) may take either role"* — **cross-project merging already treats a global page as an acceptable side**, so all that was missing was a way to create one.

### Fact three: retrieval already treats a global page as visible to every project

`internal/service/wiki_evidence.go:300`:

```go
if projectID > 0 && p.ProjectID != 0 && p.ProjectID != projectID {
    continue // another project's page: correct to skip, not to hide
}
```

The `p.ProjectID != 0` clause means **a page with `project_id = 0` is visible to every project**. Promotion is therefore a **widening** (a page owned by one project becomes visible to all), not a move. That makes both the payoff and the risk plain: the payoff is that L3 finally has content and the cross-project profile works; the risk is that **one misjudged page now steers every project's answers** — which is why it has to be a human's click.

## Decisions

**1. L3 gets no automatic fallback — only a human "promote to global page" action.**

The rejected alternative was "produce a cross-project summary alongside every compile". It violates ADR-0015 verbatim (the line quoted at `context_layers.go:29-33`):

> Producing L3 automatically is exactly the "model writes into the store with no gate" ADR-0015 refuses.

An automatically produced L3 is the model writing into the memory layer with nobody reviewing it — the very thing ADR-0015 refuses. **This ADR does not do it and does not reserve any code path for it.**

**2. A global page is an approved page with `project_id` emptied; only approved pages may change scope.**

- db layer `SetWikiPageScope(db, id, projectID)`: `projectID == 0` → `project_id = NULL`.
- **Why NULL and not the literal 0**: `wiki_pages.project_id` carries `FOREIGN KEY ... REFERENCES projects(id)`, and the database runs with `PRAGMA foreign_keys=ON` (`internal/db/db.go:37`). There is no project row with id 0, so writing 0 is rejected by the constraint. `CreateWikiPageAs` has always expressed the global tier with NULL; this ADR uses the same spelling, and a test pins the fact (`TestSetWikiPageScope_LiteralZeroIsRejectedByTheForeignKey` — if the foreign key ever stops biting, that test goes red).
- **Only approved may move**: a pending page promoted to the global tier would be invisible to *every* project-scoped review feed (the pending and rejected queries filter on `project_id`), becoming an orphan page nobody could ever approve; a rejected page is a tombstone and has no business speaking at all. Scope changes therefore require published knowledge.

**3. A scope change touches neither status / content / source nor `updated_at`.**

- Not status/content/source: scope says "where this page may speak", not "what this page says". Approval remains the separate human act ADR-0015 is about, and it is not quietly undone along the way.
- Not `updated_at`: the lint's staleness pass reads `updated_at` as "which of two conflicting pages is the newer claim". A scope change that makes stale knowledge look fresh is a visibility operation polluting freshness semantics.
- Consequence: the `page_versions` snapshot trigger only fires on status/title/content/kind changes (`internal/db/wiki_versions.go:118-126`), so **a scope change produces no version snapshot** — the history records "what a human approved", not "who owns this page".

**4. Promotion is reversible: the inverse move names its target project explicitly.**

Once a page is promoted, the project it came from is no longer knowable from the row (`project_id` is NULL), so "move it back" is the human naming a project: `AssignWikiPageProject(pageID, projectID)`. **A one-way ratchet is not a feature.**

**5. Scope changes do not alter retrieval's project filter; project-scoped inventories still filter by project.**

Once an approved page enters the global tier it no longer appears in its old project's lint / export / compile vocabulary / merge candidates (those queries all filter on `project_id = ?`). That is the semantics of ownership: a global page belongs to no project. **Retrieval is the opposite** — it has always seen global pages from every project (fact three). This asymmetry is a fact of the existing code; this ADR does not change it (changing it touches eight call sites and belongs to a separate decision).

**6. The review page gains a "Page scope" area; promotion takes two clicks.**

- Placement: the review page — the only surface where a person meets model output — alongside the pending and rejected queues.
- Shape: **not a review card**. A scope change is not a verdict, so the row carries no body, no source notes and no version history — only who this page is, where it currently speaks, and what can be done from there.
- The promote button takes **two clicks** (same pattern as "adopt merge" on the same page): it changes the direction of every future answer in every project, and one stray click should not count.
- Moving a page back requires picking a project from a dropdown; until one is picked the button is disabled and says why.
- Global pages appear only in the "all projects" view (they belong to no project), consistent with the existing filter semantics.

**7. All three bindings are desktop-only, with no MCP twin.**

`ListApprovedWikiPages` / `PromoteWikiPageToGlobal` / `AssignWikiPageProject` are all registered in `internal/app/surface.go`'s `bindingSurfaces` as `SurfaceDesktopOnly` with reasons; the latter two also join the human-gate list in `surface_test.go` (`TestBindingSurfaceHumanGateHolds`). The reasoning is of the same family as ADR-0019's merge: **a capability that decides "this page speaks for me" on the user's behalf is not one an agent may call.**

## Option matrix (how to fill the empty layer)

| Option | Payoff | Main risk | Verdict |
|---|---|---|---|
| **A human clicks "promote to global page"** (this decision) | L3 has content; the cross-project profile works; smallest change surface (no schema change) | Depends on a human clicking; L3's quality is a human's | **Adopted** |
| Automatic cross-project summaries | Zero maintenance; L3 always has content | Violates the ADR-0015 red line directly (model writes into the memory layer unreviewed) | Rejected |
| Add an `is_global` column so both tiers coexist | The page stays visible inside its project | Schema v29 + migration + two filter semantics; turns ownership into two contradictory dimensions | Rejected (out of scope) |
| Let the compiler / community synthesis emit global pages | Automatic | Same as above, and the model decides "this page represents me" | Rejected |
| Do nothing | Zero risk | L3 stays structurally empty; the cross-project profile product line has no landing spot | Rejected |

## Consequences

**Positive**:

- L3 goes from "structurally empty" to "one click and it has content": the cross-project profile in `repotory_context` can speak for the first time.
- A global page is visible to retrieval in every project — a general convention need not be written once per project.
- Promotion is reversible, and every move leaves a log line (`wiki: page N (slug) promoted from project M to the global tier`).
- No schema change: no column, no version bump, no migration chain touched; ADR-0021's reversibility contract is unaffected.

**Negative (stated plainly)**:

- **L3's quality depends on people.** The global tier is not a model summary; it is pages a human chose. If nobody promotes, L3 stays empty — the accepted outcome here (automatic filling was rejected by ADR-0015).
- **Promotion is a widening.** One misjudged page now steers every project's answers. The two-click confirmation and the approved-only precondition are the only two gates; **there is no third automatic gate**.
- **The page leaves its old project's project-scoped inventories** (lint / export / compile vocabulary / merge candidates). Retrieval is unaffected (fact three), but "which pages does this project have" loses one. Moving it back restores it.
- **No version snapshot is produced** (decision 3), so "this page used to be global" is not visible in `page_versions` — the history records content only. Audit scope changes through Git and the log lines.
- The review page's approved list **has no pagination**: the frontend caps at 100 rows and states the true total (`review.scopeTruncated`).

## Implementation corrections (facts that differed from the design)

1. **In the database a global page is NULL; Go reads 0.** `pageColumns` projects `COALESCE(project_id, 0)`, so the frontend's `project_id = 0` means "global". This matches the TODO's wording "set `project_id` to 0", but **what is stored is NULL** — writing 0 is rejected by the foreign key.
2. **The inverse move asks the human to name the project, rather than "returning to the original project".** The original project is unknowable after promotion (`project_id` is NULL), so the UI offers a project dropdown — which also answers "I promoted this wrongly, so which project does it belong to?".
3. **The scope area only appears when there are approved pages.** With none, there is nothing to promote, and a section about an action nobody can take is noise.
4. **Promotion takes two clicks; moving back does not.** Promotion changes the direction of every future answer in every project; moving back is a restoration. They are not of the same magnitude.

## Verification

- **Live-database copy rehearsal (2026-10-26)**: ran the real service path against a `.backup` copy of the live library (the live file was read-only throughout and never written). Rehearsal page `id=1 slug=cbipay project=25` (approved): **L3 entries 0 → 1**, raw column `project_id IS NULL` = 1, **retrieval by slug still returns the page** (among 3 hits), and **L3 returns to 0** after moving it back. The rehearsal script was deleted and the copy cleaned up.
- **Go regression**: `internal/db/wiki_scope_test.go` (5 cases: NULL storage / the foreign key rejecting the literal 0 / round trip / unknown project / missing page) and `internal/service/wiki_scope_test.go` (8 cases: L3 filled / still retrievable / cross-project visibility / unapproved refused / idempotence / reversible / bad targets / missing page). `go test ./...` green across 37 packages.
- **Frontend regression**: 4 new cases in `Review.test.tsx` (scope labels / two-click confirmation / moving back with a named project / not rendered when empty). `npm test` green across 34 files and 246 cases; `npx tsc --noEmit` and `npm run lint` both clean.

## Explicitly out of scope

- No automatic global summaries (ADR-0015 red line, decision 1).
- No dedicated browse page or route for global pages — that belongs to the `/wiki` browse surface in TODO Sprint 1.1 (a separate decision).
- No change to the filtering semantics of project-scoped inventories (decision 5).
- No MCP tool (decision 7).
- Scope changes are not written into `page_versions` (decision 3).
