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
   - ① Knowledge-base search tool window: FTS/hybrid search over notes + wiki pages (via the existing search bindings; semantic and graph-aware retrieval follow the `semantic_search` / `wiki_graph_search` gates naturally — the plugin carries no gate logic and re-implements no ranking);
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
