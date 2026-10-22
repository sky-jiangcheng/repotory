# Repotory for JetBrains

**Your local knowledge base, inside your IDE.** Repotory keeps what your coding agents learn — why a decision was made, what gotcha you hit, what to do next — in a local, searchable store. This plugin puts it where you work: a **Repotory** tool window that searches your notes and todos, and opens the result in the Repotory web UI.

One build covers the whole IntelliJ family — it declares `com.intellij.modules.platform`, so IntelliJ IDEA, PyCharm, WebStorm, GoLand and the rest all install the same zip.

## What it does

| Surface | What it does |
|---|---|
| Tool window **Repotory** | The search box. Typing searches your knowledge base (300 ms after the last keystroke) and the hits list in the window; the status line under it says what happened — `N result(s) for "…"`, `No matches for "…"`, or the reason the search did not run |
| Result list | One line per hit: title · kind (`note` / `todo`) · the matched snippet. Double-click (or select and press **Open in Repotory**) opens that hit in the browser |
| **Open in Repotory** button | Opens the hit's deep link — `/project/<id>?noteId=<id>` for a note, `/project/<id>?tab=todos` for a todo — in your system browser |
| **Tools → Repotory** | Opens the tool window (also on its title bar) |
| **Settings → Tools → Repotory** | Server address, optional server binary path, a **Test connection** button that tells "API and web UI both reachable" from "API-only, the link would 404", and **Start local service** for a one-click launch |

## Requirements

- **IntelliJ IDEA 2024.2 or newer** (any IntelliJ-family IDE). The plugin runs on the JRE the IDE ships with (JBR 21 on 2024.2+), **independently of your project's JDK**. A project that compiles with **JDK 8** is fully supported — the plugin never loads your project's JDK, never compiles your code, and never needs Java 8 APIs. Building the plugin from source is the only Java-21 task (see Development).
- A **`repotory-server`** binary. You do not have to start it by hand: the plugin can start a local one with one click. It looks for the binary in this order — **Settings | Tools | Repotory → Server binary**, `REPOTORY_SERVER_BIN`, `PATH`, then the usual Homebrew / Scoop / `~/.local/bin` directories. Download the release bundle (`repotory-server-<platform>.tar.gz` / `.zip`), which contains the binary **and** its `web/` directory — the plugin passes `--web-dist <bundle>/web` automatically, so "Open in Repotory" deep links work with no flags.
- Already running a service (desktop app, a server you started yourself, or one on another port)? Just set its address — the plugin reuses it and never spawns a second process.

The plugin **never downloads or builds** anything: if no binary is found, the tool window offers the file picker and the release page instead. Everything is loopback-only by design, so there is nothing to authenticate and nothing that leaves your machine.

### Starting the server yourself (optional)

The one-click start is just a shortcut for:

```bash
./repotory-server --port 18765 --web-dist <bundle>/web
```

`--web-dist` matters for result links. Without it the server is API-only: search works, but every result link 404s. The release bundle's `web/` directory is the **server** build of the web assets (base `/`); the desktop `web/dist` (base `./`) is not interchangeable. The plugin does not embed the SPA itself (one rendering of the knowledge UI, the desktop app's).

## First launch

1. Open the **Repotory** tool window from the right-hand tool window bar, or **Tools | Repotory**.
2. Type a query. If no service is running, the status line says so and a **Start local service** button appears next to the results.
3. Press it. The plugin looks for `repotory-server` (see Requirements), starts it on the configured port with its bundled `web/` directory, waits for `/health`, and retries the query. If no binary exists yet, choose **Set Path…** (file picker) or **Open Download Page**, then press start again.
4. Prefer to check things by hand? **Settings | Tools | Repotory** has the address, the binary path, **Test connection** and **Start local service**:
   - *Connected: … — API and web UI both reachable.* → everything works.
   - *Connected: …, but API-only: "Open in Repotory" would 404.* → the running server has no web UI; restart it with `--web-dist` or use the release bundle.
   - *No response from …* → nothing is listening; press **Start local service**.

If you click a result while the service is API-only, you do not land on a bare 404: the plugin says so and offers **Open Anyway** / **Copy URL** / **Cancel**.

## Settings

| Setting | Default | Description |
|---|---|---|
| Server address | `http://127.0.0.1:18765` | Repotory headless service URL |
| Server binary | empty (auto-detect) | Path to `repotory-server`; empty means `REPOTORY_SERVER_BIN`, then `PATH`, then common install directories |

Both values are stored in the IDE's own properties store (`repotory.xml`), not in Repotory's database — a client must not write into the service's storage.

## Scope

Search covers **notes and todos**, through the same `SearchAll` binding the desktop app and the VS Code extension use — FTS5 (bm25, with a `LIKE` fallback) computed server-side. The plugin reimplements no ranking, no snippet extraction and no gating; it renders what the service returns.

**Wiki pages are not searchable from the plugin yet**, and this is deliberate: the service layer exposes no wiki-page search binding, and the frontend has no addressable route for an approved page either — so a wiki hit would be findable but not reachable. Filed as a separate todo with the corrections recorded in [ADR-0027](https://github.com/sky-jiangcheng/repotory/blob/master/docs/en/adr/0027-jetbrains-plugin.md).

**Not in the MVP:** session capture, and one-click MCP registration (JetBrains-side MCP client configuration proved too unstable to ship; MCP registration stays with `repotory-init` for now).

## Install

The plugin is **privately distributed first** (ADR-0027, ruling 2) — it is not on the JetBrains Marketplace yet. Install the zip from disk:

1. Download or build `repotory-jetbrains-<version>.zip` (below).
2. **Settings | Plugins | ⚙ | Install Plugin from Disk…** and pick the zip.
3. Restart the IDE.

The plugin is a thin client — every answer comes from the same `internal/service` layer as the Repotory desktop app, read from your local SQLite knowledge base. Nothing leaves your machine.

## Compatibility

| | |
|---|---|
| `sinceBuild` | `242` — IntelliJ 2024.2 and newer |
| `untilBuild` | none — no upper bound, so 2025.x and later install normally |
| Built and verified against | IntelliJ IDEA CE 2025.2 |
| Project JDK | irrelevant — JDK 8, 11, 17 or 21 projects all work; the plugin runs on the IDE's bundled JBR |

The build target (2025.2) is newer than the declared floor (242) on purpose: the plugin uses only platform APIs that exist in 242 (tool window, settings page, Swing, `java.net`), and `verifyPlugin` is what proves that. Older builds declared `untilBuild = "243.*"`, which made the plugin refuse to load on every IDE after 2024.3 — including the 2025.2 it was built for. That cap is gone.

## Development

There is **no Gradle wrapper** in this directory — use a local Gradle (this plugin is developed and verified with **Gradle 8.10.2**) and **JDK 21**:

```bash
cd ide/jetbrains
gradle buildPlugin     # → build/distributions/repotory-jetbrains-<version>.zip
```

The build resolves the IntelliJ Platform 2025.2 distribution on first run (about 1.2 GB into the Gradle cache). To also run the Plugin Verifier against IDEA CE 2025.2:

```bash
gradle verifyPlugin    # reports API misuse and binary-compatibility problems
```

CI runs `gradle buildPlugin` on every push and pull request (`jetbrains-plugin-test` in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)), so a Kotlin breakage cannot sit on `master` unnoticed. `verifyPlugin` is heavier (it downloads a full IDE) and is run locally: `gradle verifyPlugin`.

Architecture and scope: [ADR-0027](https://github.com/sky-jiangcheng/repotory/blob/master/docs/en/adr/0027-jetbrains-plugin.md). The plugin talks to the loopback-only headless service over `GET /health` and `POST /api/rpc`; zero business logic lives here.