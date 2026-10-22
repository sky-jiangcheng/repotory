# ADR-0027: JetBrains plugin kickoff — the second IDE distribution surface under the thin-client discipline

Status: **Accepted (2026-10-22)** — on the day of drafting the 4 open questions were ruled under the owner's delegation (see "Ruling on the open questions"); scheduling is a separate matter
Date: 2026-10-22
Related: [ADR-0009](0009-ide-presence.md) (this ADR revises its Decision 4: JetBrains moves from "deferred" to "kickoff"), [ADR-0007](0007-session-memory-protocol.md) (MCP as the single execution interface), [ADR-0006](0006-scope-freeze.md) (distribution surfaces are not platformization), [ADR-0017](0017-one-kernel-two-entry-points.md) (the headless API is the plugin's consumption surface), VS Code extension (`ide/vscode`, the first IDE distribution surface)

## Background

[ADR-0009](0009-ide-presence.md) Decision 4 deferred the JetBrains plugin: "an independent Kotlin/Gradle codebase doubles the maintenance surface; do not kick off or write code until a real demand signal (issues/stars) arrives and a dedicated ADR argues the case". The "issue/star magnitude" in that threshold is a **proxy metric for the public-distribution scenario** — estimating real demand from the volume of stranger users' signals, to avoid maintaining a second tech stack for a user base that does not yet exist.

On 2026-10-22 the project owner gave the demand signal directly and ruled to kick off. The proxy metric loses meaning here: the owner is themself a daily JetBrains IDE user, so the demand signal arrives in its most direct form (an explicit instruction from the owner), and the risk of "maintaining code for users who do not exist" is void — maintainer and user are the same person. ADR-0009's substantive reason for deferring (the doubled maintenance surface) still holds, but its precondition (demand uncertainty) is gone; this ADR is the execution of its legacy clause "once a real demand signal arrives, argue the case in a dedicated ADR".

Capability-side facts (each verified):

- The headless server (`cmd/server`, default `127.0.0.1:18765`, loopback-only) exposes, via the generic `/api/rpc` bridge, **exactly the same** binding surface as the desktop Wails app, plus REST endpoints for the dsh plugin / agents — every capability the plugin needs (search, notes, wiki, evidence) is already available, and `/api/rpc` is validated daily by the web frontend's real load.
- The MCP server (`repotory-mcp`) can be registered into JetBrains AI Assistant / the built-in MCP client (ADR-0009's background already confirmed native support), but that serves the agent flow only; the **human** still gets zero native UI in the IDE — command palette, tool windows, status bar: Repotory is absent. That is the visibility blind spot ADR-0009 set out to fix, continuing onto the second IDE family.
- The VS Code extension (`ide/vscode`) has landed and validated the thin-shell pattern: palette commands, status bar, sidebar search — all zero-logic-duplication through the shared service layer. The JetBrains plugin is the second reuse of that pattern, not a new pattern to explore — the design risk was already digested by the first IDE surface.

## Decision

1. **Kick off, inheriting the thin-client discipline**: the plugin is a thin shell — it calls the shared service layer over headless HTTP (primarily `/api/rpc`) with zero logic duplication; it adds no execution interface (MCP stays the single execution interface, ADR-0007); the plugin evolves only with the external API, never with internal implementation. Any sub-proposal violating this discipline is out of the MVP.
2. **MVP scope (porting the VS Code extension pattern)**:
   - ① Knowledge-base search tool window: FTS/hybrid search over notes + todos (via the existing `SearchAll` binding; semantic and graph-aware retrieval follow the `semantic_search` / `wiki_graph_search` gates naturally — the plugin carries no gate logic and re-implements no ranking);
   - ② Result jump: open the Repotory SPA in the system browser, located at that result (same-origin server address; deep-link routes follow the frontend as-is, supplemented during the MVP with minimal route parameters where missing; no full UI embedding inside the plugin);
   - ③ Settings page: server address (default `http://127.0.0.1:18765`) + connection health check;
   - ④ One-click MCP registration (reusing `repotory-init`'s registration approach, writing the JetBrains-side MCP client configuration) — if the IDE configuration surface proves too unstable during implementation, degrade to documentation guidance without blocking the MVP.
3. **Technical form**: Kotlin + Gradle (IntelliJ Platform Plugin); an independent codebase. The doubled maintenance surface predicted by ADR-0009 is hereby **knowingly accepted**, with its boundary pressed down to the API layer by the thin-client discipline.

## Ruling on the open questions (2026-10-22, delegated by the owner)

1. **Target IDE family and version baseline → IntelliJ IDEA CE first, platform-level compatibility, baseline 242 (2024.2+)**. Measured on the owner's machine: the daily JetBrains IDE is IntelliJ IDEA CE (`/Applications/IntelliJ IDEA CE.app` = 2025.2.6.1, support dir `IdeaIC2025.2`, plus an `IntelliJIdea2024.3-backup`; no GoLand anywhere — the original question's "e.g. GoLand" premise does not hold). The plugin declares `com.intellij.modules.platform`: every API the MVP needs (tool window / settings page / browser jump / HTTP) is pure platform API, so one build installs into the whole IntelliJ family (including the PyCharm CE on this machine) with no per-product fork. `sinceBuild=242` covers the owner's recent 2024.3 and current 2025.2 with margin; development and acceptance run on IDEA CE 2025.2; the baseline is re-checked before any public distribution.
2. **Distribution → private distribution first** (disk share / private update site; no signing or review friction); Marketplace revisited once the plugin stabilizes (original recommendation adopted).
3. **Session capture → out of the MVP**: strictly align with the VS Code extension's validated capability set; terminal/capture integration waits for a real pain point (original recommendation adopted).
4. **Server lifecycle → connect-only**: connect to an existing instance (user-started / autostart), thin shell with zero lifecycle management (original recommendation adopted); managed auto-launch revisited on a real pain point, following the dsh plugin's practice and documented then. The lifecycle item ADR-0009 left behind is hereby settled on the JetBrains side.

## Consequences

- Positive: the JetBrains family gains visible in-IDE presence (tool window / settings), completing the second distribution shelf; the thin-client discipline keeps the maintenance surface limited to API-layer evolution; the search backend directly benefits from the lane-2 production pipeline (`semantic_search` + graph-aware evidence enabled 2026-10-22), so the plugin inherits the full-pipeline caliber at zero extra cost.
- Negative: +1 independent Kotlin/Gradle codebase (the doubled maintenance surface — ADR-0009's original reason for deferring, knowingly accepted by the owner given an explicit demand signal); one build covers only JetBrains, with no VSIX-style fork-family amortization.
- Neutral: no contact with the scope freeze (`repotory` binary name / data directory / MCP prefix `repotory_*` unchanged; the plugin is a distribution surface, not platformization — ADR-0006's reconciliation clause continues to apply).
- Legacy: Marketplace listing materials (screenshots / description / icon) and signing — distribution is now ruled as private-first, so this waits until the plugin stabilizes and the Marketplace agenda opens; the `sinceBuild` baseline is re-checked at the same time.

## Implementation correction record (verified layer by layer while the MVP landed, 2026-10-22)

The MVP has landed in `ide/jetbrains/` (Kotlin + Gradle, 7 source files); both `buildPlugin` and `verifyPlugin` (against IDEA CE 2025.2) pass. What follows records what the implementation measured and the corrections it forced on the decision text.

### Decision 2①'s "wiki pages" search — measured, both ends are missing and the middle was never connected; the decision text is corrected

Decision 2① originally read "FTS/hybrid search over notes + wiki pages (via the existing search bindings)". Verifying layer by layer while writing the code, the real state is **three segments, each with its own status**:

| Layer | State of wiki-page search |
|---|---|
| db layer | ✅ **complete** — `db.SearchWikiPages` (`internal/db/wiki_fts.go:91`): the `wiki_pages_fts` FTS5 trigram index + bm25(3.0, 1.0) ranking + an **approved-only** filter (ADR-0015's core rule: a page no human has reviewed must never enter retrieval) + the same `escapeFTS` / `escapeFTSOR` relaxation as the notes path (a whole Chinese sentence expands into trigrams). Landed with ADR-0014 W2, with tests (`wiki_compile_test.go` / `wiki_community_test.go`) |
| service / app binding layer | ❌ **not exposed** — `SearchAll` (`internal/db/search.go:205`) covers notes + todos only; the app bindings' retrieval set is `SearchProjects` / `SearchNotes` / `SearchAll`, with **no wiki-page search entry**. The note in ADR-0014 — "search is the first thing a consumer needs, and W2 is that consumer" — W2 landed long ago, and **the consumer never came** |
| frontend | ❌ **no browsing surface** — no component in `web/src` renders the content of an approved wiki page (`Review.tsx` reads `p.content` in exactly two places: the pending review queue and the rejected tombstones); neither `/knowledge` nor `/review` accepts page parameters, and the route table (`web/src/App.tsx:324-333`) has no wiki-page entry. The real database holds **27 approved pages that are entirely invisible in the UI** |

The VS Code extension (the first IDE distribution surface, whose pattern ADR-0027 requires the MVP to port) goes through `repotory_notes_search` and **also searches notes only**.

**Ruling: decision 2① is corrected to "notes + todos" (via the existing `SearchAll` binding), and wiki-page search becomes a separate todo.** Three reasons:

1. **The thin-client discipline requires the plugin to duplicate no logic.** For the plugin to search wiki pages, the service layer needs an entry point — and none exists. Writing the FTS query in the plugin (even by copying those few dozen db-layer lines) **is** logic duplication and violates Decision 1 directly.
2. **Adding the backend binding alone does not close the loop.** Even if the service/app layer exposed `SearchWikiPages`, clicking a wiki hit in the plugin would land **nowhere** — there is no browsing surface and no addressable route for an approved page. Decision 2② asks to "open the Repotory SPA in the system browser, located at that result"; with no landing spot, that cannot be honored. The real gap is **"approved wiki pages are invisible to the user"** — an independent product gap (27 pages invisible in the UI), not a plugin problem, and closing it is a new feature rather than this ADR's wrap-up.
3. **The porting principle comes first.** Decision 2's title is literally "MVP scope (**porting the VS Code extension pattern**)", and the VS Code side's capability set is notes. Aligning the MVP with its pattern beats shipping something outside that pattern in half-working form (findable but not reachable) inside the MVP.

**Wiki-page search and its browsing surface are therefore filed as a separate todo in `TODO.md`**, to be specced in an ADR before any work: it needs a browsing UI and an addressable route for approved pages, a `SearchWikiPages` binding, and both IDE distribution surfaces consuming them.

### Decision 2②'s deep-link parameters — taken from the frontend as-is, verified

The plugin's first draft guessed `?note=` and `?page=`. The frontend's actual truth is `?noteId=` (`web/src/pages/ProjectDetail.tsx:58` reads `searchParams.get('noteId')`) and `?tab=todos` for todos (`web/src/App.tsx:323-337` route table). Corrected to match, and "deep-link routes follow the frontend as-is" is not read as license to invent parameters — the only reason a deep link exists is to **land the user where they can see something**.

### Four real defects the compile verification exposed

Compile verification (`buildPlugin` + `verifyPlugin` against IDEA CE 2025.2) surfaced four genuine problems in the first-draft code, all fixed:

| Defect | Symptom | Fix |
|---|---|---|
| `IntelliJPlatformType` not imported | Gradle script compilation failure | added `import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType` |
| Kotlin compiler older than the platform's metadata | a wall of "Module was compiled with an incompatible version of Kotlin (binary 2.2.0, expected 2.0.0)" plus an internal compiler error | Kotlin plugin 2.0.21 → **2.2.0** (a compiler must never be older than the metadata it reads) |
| `RepotoryPanel` implemented `Disposable` but was used as a `JPanel` | "Unresolved reference" on `layout` / `add` | made it a `JPanel` + `Disposable` (a tool window needs a Swing component, and it must be releasable with its content) |
| wrong `getToolWindow` entry point | "Unresolved reference 'getToolWindow'" | the correct entry is `ToolWindowManagerEx.getInstanceEx(project).getToolWindow(id)` (package `com.intellij.openapi.wm.ex`; `WindowManager` has no project-taking overload) |

Also fixed: `plugin.xml` had no `<description>` — the Plugin Verifier ruled it an "Invalid plugin descriptor" (`<description>` is a required property of a valid plugin). It is now present.

`verifyPlugin` reports **no compatibility problem** against IDEA CE 2025.2. The `sinceBuild=242` being lower than the build target 252 is deliberate (Decision 1 requires covering 2024.2+); the `build.gradle.kts` comment spells out that "the build target is the newest IDE, while the declared floor is the lowest version the plugin promises to support" — the plugin uses only platform APIs that exist in 242 (tool window, settings page, Swing, `java.net`), which is exactly what the Verifier is there to prove.
