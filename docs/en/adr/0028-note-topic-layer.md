# ADR-0028: The topic layer — the subject between project and note (project → topic → note)

Status: **Accepted (implemented and browser-verified end to end, 2026-10-25)** — schema v27 adds the `note_topics` table and `project_notes.topic_id`; 5 backend bindings, the frontend filter strip / editor selector / Knowledge-page topic aggregation, and the plugin-side wording all landed; `go test ./...` green, `npm test` 226 tests green, real-browser inspection screenshots in `outputs/e2e-2026-10-25/`. The inspection surfaced three real defects, all fixed — see "Implementation corrections". **A second pass on 2026-10-25** caught two plugin-side leftovers (the JetBrains `plugin.xml` description and a status message still called the project a "主题"), and re-verified at runtime that all three transport paths of decision 5 hold the invariant; screenshots in `outputs/e2e-2026-10-25-topic/`
Date: 2026-10-25
Related: [ADR-0023](0023-note-ownership-knowledge-organize.md) (note ownership — this ADR adds a layer on top of the "a note always belongs to a project" invariant it established, turning two levels into three), [ADR-0022](0022-agent-memory-discovery-sync.md) (the derived display field `source_type` — this ADR's `topic_name` is the same kind of field: computed on the server, never stored), [ADR-0019](0019-entity-resolution-merge.md) (merging is always human-triggered — the same-name topic merge below inherits that discipline); starting schema **v26**
The owner's original request (2026-10-25): "our notes belong to a project, but there needs to be another layer of subject between the project and the note — a note can be filed under a topic, a project can have notes under several topics; we mentioned this back when we were doing the plugin, check whether it was implemented" — **the check came back: not implemented**. The plugin's dropdown labelled `Topic (主题)` actually selected the **project**; the word was borrowed, and the topic layer was only a verbal concept at that time

## Background

The note layer's existing shape is two levels: **project → note**. That shape is fine while a repository's notes are all of one kind, but a project like CBiPay immediately shows its limit: 8 notes covering a payment-gateway call-chain verification, a branch-query SOP, an OpenCode session import, and a sample test note — they share no subject except "happens to live in the same repository".

The owner wants three levels: **project → topic → note**, with "a project can have notes under several topics" — a topic is a layer inside the project that can be added and removed, not a field on the project.

One fact worth recording: the owner said this was mentioned back when the plugin was built, so this is not a new request but a **deferred old one**. Checking the code showed the dropdown labelled `Topic (主题)` took a project id and wrote it into the note's `project_id`. So the word "topic" was already borrowed to mean "project". Once the topic layer lands, that plugin dropdown has to be renamed to "Project" — otherwise one word means two different things in the same product.

## Decision

**1. A topic is its own entity, not a field on the project.** New table `note_topics` (`id` / `project_id` / `name` / `description` / derived `note_count` / timestamps), plus a nullable `project_notes.topic_id` with `ON DELETE SET NULL`. The reason: a topic has its own lifecycle — it can be renamed, deleted, counted and filtered by name. All of that expressed through a string column like `projects.topic` means a rename has to sweep every note.

**2. A topic belongs to exactly one project.** `note_topics.project_id` is a hard foreign key plus `UNIQUE(project_id, name)`. This invariant is the source of all the complexity in this ADR, and the reason it has to be held carefully (see Decision 5).

**3. Filing and unfiling are both `SetNoteTopic(noteID, topicID)`, where `topicID=0` clears.** Same nature as `MoveNote` (changing project): this is an **organizing act**, not an edit of the note's text, so it **takes effect immediately** and the user is not asked to press save a second time. Changing the topic dropdown in the editor writes to the database right away.

**4. Deleting a topic keeps the notes.** They fall back to "unfiled". This matches ADR-0023's discipline that destructive convergence is always human-triggered and deletion is manually opt-in: deleting a topic deletes a category label, not knowledge.

**5. All three paths that could break the "a topic belongs to its project" invariant are closed.** This is the part that is easiest to miss while implementing — three existing note-moving paths silently broke it:

| Path | Old behaviour | Fix |
|---|---|---|
| `MoveNote` (note changes project) | only `project_id` changed, `topic_id` stayed | the same UPDATE also sets `topic_id = NULL` — a note keeping the old project's topic id would point at a topic the new project does not own |
| `MergeProjectUp` (project swallows a sibling) | notes came along, the sibling's topics were **cascade-deleted** | `MigrateTopicsInto` moves the source project's topics into the target; a same-name target topic is **merged** (notes re-pointed, duplicate row deleted), matching `UNIQUE(project_id, name)` |
| `ReassignLandingNotes` (Knowledge-page organizing) | notes moved to the target project, topics lost | the same `MigrateTopicsInto` call |

The third is the subtlest: the organizing feature (ADR-0023) exists to give drifting knowledge a home, so if topics evaporate during the reorganization, the organizing action itself destroys the user's classification intent — the one thing organizing must never do.

**6. The derived display field `topic_name` is computed on the server, never stored.** Same as ADR-0022's `source_type`: a topic can be renamed, so keeping a redundant copy means a rename has to synchronize two places. The list side does one `TopicNames(db)` lookup for the whole table (`internal/db/note_topics.go`) rather than one query per note.

**7. Frontend: one topic list, many consumers.** `useTopics(projectId)` owns the list and the selection; the filter strip, the editor selector and the note list read the same one. Both the list and the selection carry their `projectId`, so switching projects **invalidates them by derivation** (`state.projectId === projectId ? state.topics : []`) rather than by resetting state inside an effect — a shape forced by the `react-hooks/set-state-in-effect` ESLint rule that also happens to avoid "a filter pointing at another project's topic shows an empty list, so the user thinks the notes are gone".

**8. The strip always renders; the "all / unfiled" chips only appear when the project has topics.** The "+ New topic" button must always be there — otherwise a project with no topics has no way to grow its first one. (This is a UX dead end the implementation introduced and then removed — see "Implementation corrections".)

**9. The Knowledge page aggregates and filters by topic name.** Same-named topics across projects count as one subject (a user's notes under "payment gateway" may well be spread across several projects). The Knowledge page therefore shows a **topic view**, not a project view.

**10. The plugin-side wording is corrected.** The dropdown in the VS Code / JetBrains plugins that actually selects a project is relabelled from `Topic (主题)` to `Project (项目)`, the internal variable `topic` becomes `projectField`, and the JetBrains method `newNoteUnderSelectedTopic` becomes `newNoteUnderSelectedProject`. With the topic layer landed, "topic" has a definite meaning in the product and can no longer be borrowed.

## Options matrix (how to express a topic)

| Option | Value | Main risk |
|---|---|---|
| A string column on the project, e.g. `projects.topic` | smallest change | one topic per project, which cannot carry "several topics under a project"; renaming sweeps the table; nothing to delete or count |
| A free-form tag on the note, reusing the existing `tags` column | zero schema change | tags are flat and ownerless, with no lifecycle and no counts; `tags` is already free-form annotation, and mixing the two robs both of meaning |
| **This decision: a standalone `note_topics` table plus a nullable `topic_id`** | topics have a lifecycle, a count and a filter; notes still always belong to a project (ADR-0023's invariant survives) | a three-level structure means every note-moving path must answer "what about the topic?" — Decision 5 is the complete list of those paths, and a new moving path must re-ask |
| Notes without a project, topics promoted to the top level | conceptually purest | breaks ADR-0023's "a note always has an owner"; a huge change surface with no matching product benefit |

## Consequences

- Positive: notes gain a third organizing dimension; topics can be renamed, deleted and counted; the Knowledge page can slice across projects by subject; the word "topic", borrowed during the plugin work, now has a definite meaning.
- Negative (stated plainly): the schema moves from v26 to v27 (one table, one nullable column), which touches `ExpectedSchemaVersion` and the reversible-migration tests; a three-level structure means "who owns this note" has three answers (project / topic / landing), so every path that moves a note must ask what happens to the topic — Decision 5 is that question's complete list; same-named topics across projects mean different things on the two pages (distinct within a project, identical on the Knowledge page), which is deliberate (the user's classification intent carries across projects by name) but has to be explained in the UI.

## Open questions (with recommendation)

| # | Question | Recommendation |
|---|------|------|
| 1 | Can a topic move across projects? | Not this round. A topic belonging to exactly one project is this ADR's core invariant; moving one across projects is re-parenting and needs its own thinking about same-name conflicts and merge semantics |
| 2 | Should the Knowledge page offer topic creation / rename? | No. The Knowledge page is a cross-project read view; topic management belongs to the project page |
| 3 | Do unfiled notes need a bulk filing action? | Worth doing (an extension of ADR-0023's organizing area), but out of this round |

## Implementation corrections (facts that differ from the design)

1. **A UX dead end the implementation introduced and then removed**: the filter strip was first written as `{(topics.length > 0 || activeTopicId !== 0) && <TopicFilterBar/>}` — with no topics yet the whole strip was hidden, taking the "create the first topic" entry point with it. Changed to **always render the strip**, showing the "all / unfiled" chips only when topics exist.
2. **The editor selector bounced back (found by browser inspection)**: the topic reached the database and the strip's counts updated, but the editor's controlled `<select>` snapped straight back to "No topic". The select's value was bound to `editDraft.topicId` while the write path only updated `notes` — the write and the read were looking at two different states. The fix syncs the draft at the single write point, `handleSetNoteTopic`.
3. **Renaming / deleting did not sync the card badges (found by browser inspection)**: note cards carry the server-sent `topic_name` (a derived column), so a rename touched only the topic list and the card kept the old name — the strip said the new name while the card said the old one. `handleRenameTopic` / `handleDeleteTopic` now bring the local `notes` along.
4. **A draft can outlive its topic**: drafts live in localStorage and may live longer than the topic they name. The original implementation would "create the note first, then fail the filing", leaving a half-finished note that a retry would duplicate. The filing is now validated against the topic list first, a stale filing is dropped, and a filing failure no longer fails the whole save (the note already exists).
5. **A drifting test fixture**: `internal/core/plugin/runtime/runtime_test.go` hand-rolled its own copy of the old `project_notes` table; after schema v27 added `topic_id` that copy drifted and the whole package failed to import. It now uses the production `db.InitDB(":memory:")` directly (`landing_test.go` in the same package set that precedent).
6. **The plugin's wording collided with the topic layer**: the plugin dropdown was labelled `Topic (主题)` while selecting a project. With the topic layer landed it has to be called "Project", or the same product uses the same word for two different things in the IDE and on the desktop.

## Second pass (2026-10-25)

The first pass's self-assessment — "the plugin-side wording all landed" — turned out to be wrong on re-inspection. Two leftovers survived, both on the JetBrains side (the VS Code side was already correct):

7. **The JetBrains `plugin.xml` feature description still read "主题 (topic)"** — that is the copy the Marketplace user reads, and it told them the plugin selected a topic. Changed to "项目 (project)".
8. **The JetBrains `RepotoryToolWindow` save-failure message read "the topic move failed"** — what it reports is a *note moved to another project* failing. Changed to "the project move failed".

The pass also re-verified, **at runtime rather than only in unit tests**, that all three transport paths of Decision 5 hold the invariant:

| Path | How it was verified at runtime | Result |
|---|---|---|
| `MoveNote` (a note changes project) | moved a note to another project, then queried the database | `topic_id` reset to NULL automatically; across the whole table, "a note pointing at another project's topic" = 0 rows |
| `ReassignLandingNotes` (organizing files notes) | filed notes out of a source project that already had a same-named topic | the same-named topic row was merged away and the notes re-pointed at the survivor; 0 invariant violations |
| Same-named topics across projects (Decision 9) | gave each of two projects a topic called "调用链核验", one note under each | inside a project they are two distinct topics; on the Knowledge page they aggregate into **one** chip "调用链核验 (3)", and clicking it shows 3 cards spanning both projects |

That last row is the most valuable capability of this layer: **a subject view rather than a project view** — the notes a user filed under "支付网关" may be spread across several projects, and the Knowledge page can slice across them.
