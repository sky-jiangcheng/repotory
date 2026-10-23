# ADR-0024: Home page workbench — merge home with dashboard, split global search into its own page, add recommendations

- Status: **Accepted (2026-10-16, proposed directly by the user)**; **Decision 1 was amended on 2026-10-23 against what actually shipped — see the "Amendment record" at the end**
- Date: 2026-10-16
- Related: [ADR-0017](0017-one-kernel-two-entry-points.md) (this ADR revises the two-column side-by-side wording in its UI-alignment section; the principle "dashboard stays on the first screen, is not hidden by default" remains unchanged), [ADR-0006](0006-scope-freeze.md) (the dashboard remains a supporting capability; this ADR adds no new backend features)

> **Amendment note (2026-10-23)**: Decisions 2 and 3 shipped exactly as written. **Decision 1 did not** — the home page never absorbed the dashboard panels; it became the knowledge-assistant workbench instead, and `/dashboard` was never redirected and is still its own top-level page. The original wording above is kept as history; where it conflicts with the [amendment record](#amendment-record) at the end, that section governs.

## Background

After D25 / ADR-0017 landed, `/` (Home) rendered as "left column: memory ring + right column: full embedded `<Dashboard />`" in a two-column side-by-side layout, while the `/dashboard` route independently rendered the same Dashboard component again. This produced three problems:

1. **Duplicate rendering**: the same "goal ring + heatmap + summary + project grid" rendered in two top-level routes; two navigation entries pointed to the same content; every future dashboard change had to account for two containers.
2. **Layout debt**: the two-column side-by-side layout stacked unevenly at the ≤1080 px breakpoint — ADR-0017 already fixed a real defect on the day of promotion (memory ring collapsed, search box and handoff list hidden under the dashboard); on narrow screens, the two-column layout was essentially a forced fit.
3. **Search had no landing spot**: global search was scattered across three places (an inline input in Home, the ⌘K CommandPalette, and the dashboard's project search dropdown) with no directly reachable top-level entry; the "empty state" of search — hot projects, hot tags — had nowhere to live inside the command palette; a cold-start user opening search would see only a blank input box.

## Decisions

1. **Home = workbench (single-column fusion)**〔⚠ this item did not ship as written — see the amendment record at the end; decisions 2 and 3 shipped as written〕: `/` redesigned as a top-to-bottom narrative flow: today's goal hero (goal ring + summary) → heatmap → memory ring bar (recent handoff items in a horizontal strip + a prominent "global search" entry point) → control row (date / filter / sort / rescan) → project grid → status bar. The inline search block and handoff column in Home's left column are removed. The `/dashboard` route becomes a redirect to `/`; the main navigation drops the "Dashboard" item and adds a "Search" item. The Dashboard component is retained as a panel referenced from the home page; no features removed, not hidden by default.
2. **Global search as its own top-level page `/search`**: a large search box with autofocus; debounced search over notes and todos; results grouped into "Projects / Notes / Todos"; the query syncs to the URL via `?q=` for deep-linking. The ⌘K CommandPalette remains as the keyboard quick-switcher; its first action (new handoff) is unchanged.
3. **Recommendations land in the `/search` empty state**: with no query, a recommendation area shows the top-6 hot projects (sorted by recent personal added-line count descending, ties broken by star count and repo count, all zeros fall back to default order) and hot tag chips (clicking a tag fills it into the search box and executes the search). Sorting is purely front-end; no backend fields added, no schema changes.

## Rationale

- Duplicate rendering is real maintenance cost and positioning noise; the single-column fusion turns "memory ring + project status" from "two columns squeezing each other" into a single narrative stream, preserving ADR-0017's intent (both visible on the same screen, narrative aligned) while removing the narrow-screen layout exception that had been a long-standing problem.
- Search deserves a page that can carry "empty-state value": with no query, hot projects and tags give a foothold that a transient command palette cannot; a top-level page also gives stable anchors for the manual, keyboard shortcuts, and external links.
- Not touching the backend was deliberate: existing endpoints already supply all fields needed for sorting (`my_added` / `is_starred` / `repo_count` / `ListAllTags`); this is a pure information-architecture change, leaving schema and statistics upgrades for a future with real demand signals.

## Consequences

- **Positive**: duplicate routing eliminated; narrow-screen layout complexity reduced; search gains a top-level entry and a recommendations slot; `Home.test` / `Search.test` directly pin the new structure.
- **Negative**: old `/dashboard` links (bookmarks, doc references) will be redirected — a one-time migration; the two-column wording in ADR-0017 is revised by this ADR, and readers of the old text should reference the note; hot ranking is a client-side heuristic (no historical activity weighting); tags have no popularity counter, and "hot" is defined by the page's labels.
- **Boundary**: dashboard assets (goal ring, heatmap, working-day alerts) remain on the first screen; ADR-0017's stance of "do not remove from first screen, do not hide by default, do not delete" is unchanged — the only change is the container: from an independent route merged into the home page, and two columns side-by-side replaced by a single-column fusion.

## Amendment record

Amended 2026-10-23 against what actually shipped; the wording above is left untouched as history, and where the two conflict this section governs. Trigger: the ADR (plus the `docs/adr/index.md` row and the `TODO.md` status block) asserted "`/dashboard` redirects to `/`, navigation drops the Dashboard item" — a claim that never held in code, while the user-facing manual (`docs/features/dashboard.md`) and CHANGELOG `[2.4.0]` described the opposite shape. Three documents contradicting each other is precisely the "describing an architecture that does not exist" failure AGENTS.md warns about.

**Point by point** (left: decision 1 as written; right: what shipped on the day of v2.4.0 and still holds at v2.11.0)

| Decision 1 as written | What actually shipped |
|---|---|
| Home = single-column fusion of the dashboard panels (hero → heatmap → control row → project grid) | Home = the **knowledge-assistant workbench** (`web/src/pages/home/HomeKnowledgeAssistant.tsx`) + memory-ring strip + key-projects / today's-activity cards; the dashboard panels are **not rendered on Home** (`web/src/pages/Home.tsx:120`) |
| `/dashboard` redirects to `/` | **Never redirected**: `/dashboard` has always been its own top-level route rendering Dashboard (`web/src/App.tsx:325`; already the case in the v2.4.0 landing commit `97f6496`) |
| Navigation drops "Dashboard", adds "Search" | "Search" was added; **"Dashboard" stayed** — both items coexist (`web/src/App.tsx:104`, `:107`), and Home offers an explicit "open the full dashboard" link (`web/src/pages/Home.tsx:156`) |
| Decisions 2 and 3 | **Shipped as written**: `/search` as a top-level page, debounced search, results in three groups, `?q=` deep links, and an empty state with the top-6 hot projects and top-12 hot tags (`web/src/pages/Search.tsx:71`, `:81`) |

**Why it did not ship as written**: decision 1 required moving the whole dashboard panel set onto `/`, while Home was simultaneously being rebuilt as the assistant workbench — stacking both would have put back the "everything on the first screen" problem this ADR set out to remove. The trade-off actually taken was **separation of responsibilities**: the dashboard keeps its own route and is restored as a top-level page with a direct navigation entry, while Home focuses on human-knowledge dialogue (this is the wording CHANGELOG `[2.4.0]` already carries — the "home is dashboard+1" redundancy went away because Home stopped embedding the dashboard, not because the dashboard moved into Home).

**What still holds**: duplicate rendering was in fact eliminated (Home no longer embeds Dashboard), just in the opposite direction from what this ADR proposed. ADR-0017's "dashboard stays on the first screen, is not hidden by default, is not deleted" is honored as a persistent first-screen link plus an always-reachable top-level page, not by merging it into the first screen. The one-time link migration listed under *Negative* never happened, so it never cost anything either.

**Going forward**: this ADR's title and filename still say "merge home with dashboard", which is the original proposal's wording and no longer describes the product. If that trade-off is reversed again, write a new ADR and supersede this one rather than stacking a second amendment layer here.
