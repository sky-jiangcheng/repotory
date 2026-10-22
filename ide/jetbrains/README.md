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
| **Settings → Tools → Repotory** | Server address plus a **Test connection** button that tells "API and web UI both reachable" from "API-only, the link would 404" |

## Requirements

- A running **Repotory headless service** — the plugin is a client and never starts one (ADR-0027 decision 4: server lifecycle is *connect only*).

  ```bash
  cd web && npm ci && npm run build:server   # → web/dist-server, base path "/"
  go build -o repotory-server ./cmd/server
  ./repotory-server --port 18765 --web-dist web/dist-server
  ```

  Default address is `http://127.0.0.1:18765`; the port is also settable via `REPOTORY_HTTP_PORT` or `--port`. The service is loopback-only by design, so there is nothing to authenticate and nothing that leaves your machine.

- **`--web-dist` matters.** Without it the server is API-only: search works, but every result link 404s. Point it at `web/dist-server` — the **server** build of the web assets (`npm run build:server`), whose base path is `/`. The regular `npm run build` (`web/dist`) is the **desktop** build, base `./`, and is not interchangeable: deep links into it load the page but every asset request resolves against the route and 404s. The Repotory desktop app serves the same UI, so running the app is an alternative to `--web-dist`; the plugin does not embed the SPA itself (one rendering of the knowledge UI, the desktop app's).

## First launch

1. Make sure a Repotory service is running (see above). If it is not, the first search tells you so in the status line instead of showing an empty list.
2. Open **Settings | Tools | Repotory**, check the address, and press **Test connection**:
   - *Connected: … — API and web UI both reachable.* → everything works.
   - *Connected: …, but API-only: "Open in Repotory" would 404.* → restart the server with `--web-dist` (or open the desktop app) before clicking a result.
   - *No response from … Is the Repotory server running?* → nothing is listening on that address.
3. Open the **Repotory** tool window from the right-hand tool window bar, or **Tools | Repotory**, and type in the search box.

If you click a result while the service is API-only, you do not land on a bare 404: the plugin says so and offers **Open Anyway** / **Copy URL** / **Cancel**.

## Settings

| Setting | Default | Description |
|---|---|---|
| Server address | `http://127.0.0.1:18765` | Repotory headless service URL |

The address is stored in the IDE's own properties store (`repotory.xml`), not in Repotory's database — a client must not write into the service's storage.

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
| `untilBuild` | `243.*` |
| Built and verified against | IntelliJ IDEA CE 2025.2 |

The build target (2025.2) is newer than the declared floor (242) on purpose: the plugin uses only platform APIs that exist in 242 (tool window, settings page, Swing, `java.net`), and `verifyPlugin` is what proves that.

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