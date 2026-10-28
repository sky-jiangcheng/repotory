# ADR-0032: Approved page visibility — letting human-approved knowledge be read by humans again

- Status: Accepted (**written and implemented on 2026-10-28, promoted on the user's approval the same day**. The implementation and verification results are in the "Implementation corrections" and "Verification record" sections below)
- Date: 2026-10-28
- Related: [ADR-0014](0014-llm-wiki-knowledge-compiler.md) (the compiled-knowledge layer — where pages come from), [ADR-0015](0015-w3-minimal-compile-loop.md) (**the gate is on the write side**: only a human publishes into retrieval), [ADR-0021](0021-temporal-graph-page-versions.md) (the page-revision flow — this ADR is read-only and does not touch revisions), [ADR-0031](0031-global-page-scope.md) (global page scope — **it explicitly left the browsing surface to this ADR**), [ADR-0009](0009-ide-presence.md) (the thin-client distribution discipline), [ADR-0027](0027-jetbrains-plugin.md) (the second IDE distribution surface), [ADR-0006](0006-scope-freeze.md) (scope freeze — this ADR widens no product boundary)
- Starting schema: v28 (**this ADR changes no schema**)

## Background

### Fact one: 27 approved pages are completely invisible to humans

Read-only measurement of the live library (2026-10-28):

```
status counts:      approved 27 / rejected 18
global pages:       0        (project_id IS NULL)
approved kinds:     concept 16 / synthesis 10 / entity 1
page_links:         55
approved with access_count > 0:  6
```

And there are exactly two places in `web/src` that render a page body, both on the review page: `web/src/pages/Review.tsx:721` (the body of a pending page) and `:720` (the one-line summary of an error-page tombstone). **Nothing renders the body of an approved page.** The route table (`web/src/App.tsx`) has no wiki entry, the main navigation has no entry, and neither `/knowledge` nor `/review` accepts a page parameter.

### Fact two: the approval gate pays off only as "fodder for answers"

ADR-0015's gate is on the **write** side: compiled output lands as pending, and only a human's approval lets it into retrieval. Those 27 approved pages are exactly the gate's output — they have passed it, they are knowledge a human said was fine.

But after passing, their only destination is AI evidence: the **sole writer** of `access_count` / `last_accessed_at` (schema v26) is `db.TouchWikiPages` at `internal/service/wiki_evidence.go:204` — "this page was dropped into some answer's evidence block". Only 6 of the 27 have `access_count > 0`, because only 6 have been touched by AI evidence gathering.

The result is a closed loop: **a human spends effort approving → the page enters retrieval → the page is consumed only as LLM fodder → the human can never read it.** The gate itself is right (ADR-0015's argument still holds), but it defines "publishing" as "may be cited" and **never defined it as "may be read"**. This ADR supplies the second half.

### Fact three: the db layer could already search; the service/app layer never exposed it

`SearchWikiPages` at `internal/db/wiki_fts.go:91` has been there for a while: approved-only (`p.status = 'approved'`), bm25 ranking (title weight 3.0 / content 1.0), a CJK multi-term OR relaxation fallback. ADR-0014 W2's comment — "**W2 is that consumer**" — points at exactly this function, and the consumer never came.

There is one non-test call site in the whole repository: `internal/service/wiki_evidence.go:271`, inside the evidence path. `SearchAll` covers notes and todos only, so `repotory_notes_search`, `/api/search?all=1`, the desktop knowledge search, the VS Code sidebar and the JetBrains tool window — **not one of the five product entry points can find a knowledge page**.

### Fact four: ADR-0031 explicitly left the browsing surface to this ADR

The "what this ADR does not do" list of [ADR-0031](0031-global-page-scope.md) says: "no separate browsing page or route for global pages — that belongs to the `/wiki` browsing surface of TODO Sprint 1.1 (a separate decision)". A global page is "knowledge a human chose, speaking across projects"; without a browsing surface it can only ever be fodder inside the L3 layer.

## Decision

**1. Approved pages are readable by humans: a new `/wiki` browsing surface plus a `/wiki/:id` detail route.**

- The browsing surface = a list of approved pages plus retrieval (with an empty query the list is ordered by update time; with a query it is bm25-ranked).
- The detail route renders the page body (Markdown, through the existing sanitisation chain), the metadata (kind / slug / scope / updated time) and its source notes.
- **Only approved pages are listed.** Pending and rejected pages stay on the review page only — that is where the gate lives, and duplicating them into a second surface would blur "what needs review" against "what is published".

**2. Read-only. This ADR offers no way to edit an approved page.**

Editing approved content collides immediately with ADR-0021's revision semantics (`page_versions` snapshots, who changed what, when). That flow deserves its own decision, and this ADR does not touch it — **a read-only visibility change does not dilute the weight of an approval**: what a human approved is "this sentence is right", not "this sentence may never change again".

**3. Retrieval reuses the existing `db.SearchWikiPages` semantics; the only addition is a scope filter.**

- approved-only + bm25 + CJK relaxation fallback: **unchanged**, so that a second notion of "how pages are searched" cannot appear.
- The scope semantics are **exactly** those of the evidence path (`wiki_evidence.go:300`): picking a project means "that project's pages plus the global pages (`project_id IS NULL`)"; picking nothing means all of them.
- In the implementation the filter is pushed down into SQL (`project_id = ? OR project_id IS NULL`), **not filtered in Go** — filtering in Go lets another project's pages consume the limit first and squeezes the current project's pages out.

**4. Human browsing does not write `access_count`.**

The schema v26 comment fixes the column's meaning: "how often a page has been **USED (surfaced into an answer's evidence)**". A human opening a page is a different kind of access; mixing the two would make one signal mean both "used by an answer" and "read by a human", and any future ranking/decay policy depending on it would read one meaning as two. **Keeping the signal single-purpose costs the browsing path its reinforcement.**

**5. MCP twins: `repotory_wiki_search` + `repotory_wiki_read`.**

Both are `SurfaceMCPBacked`. The reasoning matches `repotory_notes_read`: **reading a page that has already passed the gate is a pure read; the gate is on the write side.** (Unlike ADR-0031's three scope bindings — those are the "decide what speaks for me" human work, an entirely different nature.)

**6. Both IDE distribution surfaces consume it.**

The VS Code sidebar and the JetBrains tool window can both retrieve and open approved pages. **The thin-client discipline is unchanged**: a plugin writing its own FTS query is a duplication of the retrieval logic (ADR-0009 / ADR-0027 say this over and over), so both sides only call the binding — VS Code through the MCP tool, JetBrains through the `/api/rpc` bridge.

**7. `/wiki` enters the main navigation.**

Invisible knowledge is knowledge that does not exist. The 27 pages have been sitting in the library for a while (the compile chain first produced pages on 2026-10-14); burying them in a corner nobody finds is not an option.

## Option matrix (how approved pages become visible to humans)

| Option | Value | Main cost | Verdict |
|---|---|---|---|
| **A standalone `/wiki` browsing surface + detail route** (this decision) | Pages have addresses, deep links, and can be opened from the IDE; the review page keeps its own job | One more top-level page | **Adopted** |
| Fold it into the `/knowledge` knowledge page | No extra navigation item | The knowledge page's subject is "notes"; a page is a different species. Their filter dimensions differ (kind vs tags/topics), so merging makes both harder to use | Rejected |
| Just add an "Approved" tab to the review page | Smallest change | It puts "reading" inside the "reviewing" surface, implying reading requires review first; and the approved pages drown in the pending queue's visual weight | Rejected |
| Let `SearchAll` merge pages into the note search results | One search box covers everything | Page and note ids are both autoincrement (id 1 exists in both), so mixing them collides on ids — this repository has already paid for that lesson with notes/todos (`TestSearchAllKeepsNoteAndTodoIDSpacesApart`); and a page "hit" is not the same kind of thing as a note "hit" | Rejected |
| Auto-publish approved pages to an external wiki | Wider reach | Breaks the "locally private" promise (a hard constraint of ADR-0030) and exceeds the scope freeze | Rejected |

## Consequences

**Positive**:

- The 27 approved pages become visible to humans for the first time; the gate's payoff is no longer a single consumer.
- Pages get stable addresses (`/wiki/:id`): they can be deep-linked, written into handoffs, and opened from the IDE.
- The IDE distribution surfaces (VS Code / JetBrains) share the desktop's retrieval semantics instead of each telling its own story.
- No schema change: no new column, no version bump, no migration-chain churn.

**Negative (not glossed over)**:

- **Browsing produces no reinforcement** (decision 4), so `access_count` still reflects only "used by an answer".
- **Read-only** (decision 2): a human who spots a typo in a page cannot fix it. Fixing it goes through ADR-0021's revision flow — an acknowledged follow-up debt, not pretended away.
- **One more top-level page.** The navigation bar already has six items; a seventh is a real attention cost. It is offset by the worse cost of "the pages are invisible".
- **The project scope is semantic, not physical isolation**: with project A selected, `/wiki` still shows global pages (the widening result of ADR-0031). The UI must label them "global", otherwise "search within a project" looks like a filter that failed.

## Implementation corrections (facts that differ from the design)

1. **`db.SearchWikiPages` gained a `projectID` parameter rather than a new sibling function.** The old signature was `(db, query, limit)`; if the scope filter went into a separate function, the approved-only / bm25-weight / CJK-relaxation semantics would be copied — and copies drift. Changing the signature keeps "how pages are searched" a single implementation in this repository. (Cost: six test call sites had to follow.)
2. **`SearchWikiPagesMatch` gained the scope too**, because it is the relaxation path taken after the strict match fails. Both paths must see the same visible set, otherwise "searchable but not findable" differences would drift with the number of query terms.
3. **The browsing list's empty-query branch does not reuse FTS.** With no query it runs a separate approved-only list query (ordered by `updated_at` descending), because `SearchWikiPages` **deliberately returns nothing for an empty query** (its comment says why: callers use it as a retrieval stage, and "everything" would swamp the evidence budget).
4. **Added the LIKE fallback the notes path has had for a long time and the page search was missing.** The trigram index stores 3-rune windows, so a 2-character Chinese query ("时态") is **structurally unmatchable** in FTS — the page is in the library, the index simply holds no window that narrow. The notes path has had `searchNotesLike` for that (`internal/db/search.go:100`); the page search did not. Measured against the live library: `SearchWikiPages(0, "时态")` returned 0 rows while `时态图` returned 1 — **a page that demonstrably exists was answered on screen as "no matching knowledge pages"**, the one answer a local knowledge base must never give. The fix mirrors the notes path: when the query cannot be served by FTS, fall back to LIKE (a title match outranks a content-only match, then `updated_at` descending), retrying with the terms OR-ed when the whole query is several words.
   - **It landed in the shared `db.SearchWikiPages`, not in a browse-only branch**: the evidence path, the browse surface, the MCP tools and both IDE distribution surfaces now go through one implementation — which is exactly the reason behind decision 3 ("how pages are searched" is one implementation in this repository). The side effect is that a 2-character query in the evidence path now returns pages instead of nothing.
   - **The fallback does not widen visibility**: the approved-only filter and the scope predicate are carried over verbatim into the LIKE branch, so only "how a match is found" changed, not "who may see it". A test pins that.
5. **Punctuation splits the term, and each segment is judged on its own instead of the whole sentence once.** Verification after the implementation exposed a second gap (see section 4 of the "Verification record" below): a Chinese question ending in a question mark returned **zero** page hits. The cause sat in the shared `expandForFTS` — it decides "is this a CJK run?" with `isCJKRun`, and **punctuation is not CJK**, so the whole sentence was emitted as one unmatchable phrase, the relaxation had a single term to OR, and gave up. **Chinese questions are mostly punctuation**, so this was the most common input shape there is.
   - The fix: `expandForFTS` splits at punctuation first (except the double quote — that is FTS5's phrase delimiter, and the callers escape it by doubling), then judges each segment; CJK segments expand into trigrams, the others keep their old shape (mixed scripts are still not guessed at).
   - **It landed in the shared `internal/db/search.go`, not in a browse-only branch**: the notes path and the page path got better together — measured, `SearchAll` went from 0 hits to hits on the same punctuated question.
   - The strict AND path is untouched: the relaxation still only fires when the strict path found nothing, so "a working answer is never displaced by a looser one" stays an invariant.

## Verification

See the "Verification record" at the end of this document.

## What this ADR deliberately does not do (explicit blanks)

- No editing of approved pages (decision 2; that belongs to ADR-0021's revision flow).
- No public preview of pending pages (the review page already shows them, and that is where the gate lives).
- No change to ADR-0015's approval gate, no change to ADR-0031's scope semantics.
- No backlink graph / relationship visualisation for pages (the db layer holds 55 edges, but visualisation is a separate decision).
- No cross-device page sync (scope freeze, ADR-0006).

## Verification record

The measured record from the 2026-10-28 implementation. **Every item below was run, not inferred.**

### 1. Automated tests

| Where | Cases | Result |
|---|---|---|
| `internal/db` (`wiki_browse_test.go`) | 7 cases: scope sees own and global pages only / the list applies the same scope / the scope applies before the LIMIT / a 2-character CJK query falls back to LIKE / the fallback does not widen visibility / a punctuated Chinese question still hits / multi-term OR retry | all green |
| `internal/service` (`wiki_browse_test.go`) | 5 cases: lists approved pages only / a project scope keeps global pages visible / refuses unapproved pages / **human browsing does not write `access_count`** / the detail carries edges and source notes | all green |
| `web/src/pages/Wiki.test.tsx` + `wiki/WikiDetail.test.tsx` | 13 cases (8 + 5): the list carries each page's scope / searching only after a query is typed / the project dropdown lands in the URL / a deep link adopts the query / "empty library" and "no match" are said differently / a failure does not pretend to be an empty library / the detail renders Markdown, metadata and sources / a `[[wikilink]]` becomes a clickable link / a page the backend did not approve is refused | all green |
| `go test ./...` | the whole repository | pass |

### 2. Read-only measurement of the live library (`/api/rpc`)

```
BrowseWikiPages(0, 200)        → 27 pages   (= every approved page in the library, no more, no fewer)
SearchWikiPages(0, "时态", 20) →  1 hit → id 45 "ADR-0021: 时态图——page_versions快照…"
GetWikiPage(45)                → body 204 chars; out_links 6; in_links 0; source_note_ids [202]
```

`BrowseWikiPages` returning exactly 27 matches the library's approved count shows the **browsing surface leaks no pending or rejected page**.

### 3. Distribution surfaces

- **MCP**: `tools/list` measured 18 tools, including `repotory_wiki_search` / `repotory_wiki_read`; `repotory_wiki_read(45)` returns the same body as `/api/rpc`'s `GetWikiPage(45)`.
- **VS Code**: `tsc --noEmit` passes (EXIT=0). The plugin only calls MCP tools; it does not write its own retrieval (thin-client discipline).
- **JetBrains**: this machine has no Gradle, so the cached Kotlin 2.2.0 compiler was pointed at the cached IDEA CE 2025.2 platform: **EXIT=0 / 0 errors** (the 9 deprecation warnings are all pre-existing). CI's `jetbrains-plugin-test` (`gradle buildPlugin`) remains the packaging gate.

### 4. A second gap found while verifying, and fixed: punctuated Chinese questions

Hit while verifying `repotory_ask` (see [ADR-0033](0033-mcp-ask-evidence-answer.md)): a Chinese question ending in a question mark returned **zero** page hits.

```
SearchWikiPages(0, "时态图是什么？为什么需要它？")  → 0 before the fix
SearchWikiPages(0, "时态图是什么")                  → 1
```

The cause sits in the shared layer: `expandForFTS` decides "is this a CJK run?" with `isCJKRun`, and **punctuation is not CJK** — so the whole sentence was emitted as one unmatchable phrase, the relaxation had a single term to OR, and gave up. **Chinese questions are mostly punctuation**, so this was the most common input shape there is. The fix landed in the shared `expandForFTS` (split at punctuation first, then judge each segment), so **the notes path and the page path got better together**:

```
SearchWikiPages(0, "时态图是什么？为什么需要它？")  → 1 after the fix (id 45)
```

After the fix: `internal/db` and `internal/service` are green and `go test ./...` passes.

### 5. Browser walkthrough (headless server + a real browser)

| Walked through | Result |
|---|---|
| Main navigation | a new "知识页" ("Knowledge pages") item, pointing at `/wiki` |
| List page | renders "27 张已批准的知识页" (27 approved knowledge pages), each row carrying a kind badge / owning project / slug / snippet / update date and linking to `/wiki/:id` |
| Scope dropdown | picking CBiPay narrows the list from **27 pages to 6** (matching the library's six approved CBiPay pages one by one), and the URL follows to `?project=25` |
| Retrieval | typing the punctuated Chinese question "时态图是什么？" hits **1 page** (ADR-0021); the URL follows to `?q=…` |
| Detail page `/wiki/45` | renders kind / project / slug / title / update time / source (wiki-compile) / body; "来源笔记" ("Source notes") links to `笔记 202` ("Note 202"); "出链" ("Outgoing links") lists six links to other pages |
| Browser console | no errors |

### 6. What was NOT verified (recorded honestly)

- **The JetBrains plugin was never installed on a real IDE**: the verification stops at "it compiles". Icon-masking questions (TODO 4.7) are exactly the kind that only a real machine can answer.
- **"Browsing does not raise `access_count`**" rests on a unit test alone (`TestBrowsingDoesNotCountAsAccess`); there is no long-running comparison against the live library.
- **The "global" label on global pages was not checked against the live library**: there are currently 0 global pages (ADR-0031's promotion action has not been used on the live library yet), so that rendering branch is covered by unit tests only.
