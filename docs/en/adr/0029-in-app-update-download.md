# ADR-0029: In-app update download — a modal progress dialog plus a corner card, never a self-replacement

Status: **Accepted (implemented and browser-verified end to end, 2026-10-25)** — `internal/service/update.go` provides the advisory-only check, the exact-shape asset filter and the SHA256 verification; the frontend `UpdateDownloadUI` provides the modal / corner-card pair; the navigation badge and the settings card share one check. The real GitHub API path verified clean ("you are on the latest version", v2.13.1), and the download states were reproduced by interception and inspected screenshot by screenshot — see `outputs/e2e-2026-10-25/`
Date: 2026-10-25
Related: [ADR-0006](0006-scope-freeze.md) (scope freeze — this is the desktop app maintaining itself, not a product-boundary expansion), [ADR-0025](0025-backup-recovery.md) (the local-first, nothing-leaves-the-machine posture extends here into "never replaces itself"); no schema change in this ADR
The owner's original request (2026-10-25): "follow Qwen Office's approach to the update download details" — the reference is Qwen Office's update download UX: **a progress modal + minimize to a corner card + a completion dialog + release notes + the current version**

## Background

Until now the desktop app only had "Settings → Check for updates", which jumped straight to the GitHub release page and left the download to the user. That path has three problems:

1. **A 100 MB bundle is waited on in the browser.** The release page offers a link; the progress, the speed and the ETA all live in a browser tab, while the thing the user most wants to do at that moment is keep working in the app.
2. **Neither the current version nor the release notes are shown.** "Is there a newer version?" is a riddle — the user has to compare tags themselves.
3. **The app and the bundle are disconnected.** The user has to hand the downloaded file to the system installer, and nobody is responsible for the integrity step in between.

Qwen Office's handling is worth copying: **the download happens inside the app, the progress has a modal, the modal can be minimized into a small card in the lower-left corner so the user can carry on, a finished download gets an explicit completion dialog (with the verification result and the install entry point), and the current version plus the release notes are shown throughout.**

One thing should not be copied though: **the app updating itself**. Letting a program replace itself hands the execution rights of a network transfer to the running code.

## Decision

**1. Advisory only: detect, never auto-download, auto-install or auto-replace the binary.** A detected new version is only announced; the download is triggered explicitly by the user; when it finishes the file is handed to the **system installer**, and the user decides when to install. The reason is written at the top of `internal/service/update.go`: trust surface.

**2. Asset filtering must match the exact shape.** `appAssetPattern = ^repotory-(darwin|windows|linux)-(amd64|arm64)\.(dmg|zip|tar\.gz|AppImage|deb|msi)$`. The same release also carries `repotory-mcp-*` / `repotory-server-*` / the VSIX / the JetBrains plugin zip — all of them contain "repotory" and a platform token, so a **looser match would offer the user an MCP server archive as "the new version of the app"**. When the release ships no bundle for the running platform (CI does not build linux/arm64), the UI falls back to the release page.

**3. One single source of truth: a module-level store.** `web/src/api/updateStatus.ts` holds the verdict; the navigation badge and the settings card share the same check. Two independent checks would hit GitHub's API twice per launch and could contradict each other — a badge saying "up to date" next to a card saying "2.13.0 available" is worse than either alone. A failure keeps the last successful verdict: one network hiccup should not wipe known information off the screen.

**4. Two progress surfaces, one snapshot.** The modal (the primary view — 100 MB deserves a progress bar and an ETA that cannot scroll away) and the lower-left corner card (the minimized form, so the user can carry on) read the same `api/downloadStatus.ts` snapshot, so a "62% in the modal against 41% in the card" state is impossible. The card is mounted at app level (`App.tsx`), not inside the settings tab — the download has to survive navigation.

**5. Polling, not Wails events.** The backend downloads in the background and exposes the state through a binding; the frontend polls every 400 ms. The reason: the headless server's browser UI goes over the RPC bridge, where there is no Wails runtime event listener; polling behaves identically in both runtimes.

**6. "Download finished" means the SHA256 verification passed.** Only then is it reported as verified; otherwise the UI says plainly that it is unverified. On completion the user gets two buttons: later (dismiss) and open installer (hand it to the system).

**7. `OpenBrowserURL` allows https only.** Opening the download link in the system browser is the one path that leaves the app, so the protocol is locked down.

**8. The startup check has two gates and fails silently.** The user's switch (`update_check_enabled`) plus the desktop runtime (a browser tab pointed at a headless server has no use for self-maintenance, but the manual button in the settings tab still works there). Failures are silent — a machine that cannot reach GitHub should not see an error banner across the whole app on every launch; the settings tab re-runs the check on demand and shows the reason there.

**9. Runtime split.** `openBrowserURL` goes through the Wails binding on the desktop and `window.open` in browser mode — the headless server's UI is also a browser tab, where the Wails binding has no context and must fail.

## Options matrix (how to do the download)

| Option | Value | Main risk |
|---|---|---|
| **This decision: download in-app, verify, hand to the system installer** | the user never has to leave the app; integrity is accounted for; progress is visible | the app has to implement a downloader and a verification step; the system installer still has to finish the job |
| Download in-app and replace the binary automatically | least effort for the user | **trust surface**: running code is replaced by the result of a network transfer, and a failure can leave a half-broken app on disk |
| Only link to the release page (today's behaviour) | cheapest to implement | progress and verification are handed to the browser; nothing like the Qwen Office experience |
| Go through a system package manager (brew / scoop) | consistent with the distribution channels | bypasses the SHA256SUMS self-verification; and the user may not have the relevant package manager installed |

## Consequences

- Positive: the update experience matches Qwen Office's (progress modal / corner card / completion dialog / release notes / current version); the download happens inside the app and is verified; the app never replaces itself.
- Negative (stated plainly): an in-app downloader has to handle interruptions, sizes, verification failures and cancellation — a fair amount of code; the last step still depends on an external program, so it is not fully closed; the startup check is one outbound request, and even a silent failure is one network attempt per launch.

## Implementation corrections (facts that differ from the design)

1. **The release notes are rendered without `utils/markdown.ts`.** That module pulls KaTeX and highlight.js into the same lazy chunk; the release notes are just a Markdown blob, and using it would drag two heavy dependencies into the update path. `marked` plus `DOMPurify` are used directly instead.
2. **The real release asset names are the only reliable source for the filter**: `repotory-mcp-*` / `repotory-server-*` / `repotory-vscode-*.vsix` / `repotory-jetbrains-*.zip` / `SHA256SUMS` coexist with the four app bundles. Running the filter against a real GitHub API response after a release is the cheapest way to be sure.
3. **The "a newer version exists" state is hard to reproduce naturally in a browser**: when the local build is the latest, the check always answers "you are on the latest version". The inspection intercepts the `CheckUpdate` response of `POST /api/rpc` to construct the state — the interception only affects frontend observation and changes no product code.
