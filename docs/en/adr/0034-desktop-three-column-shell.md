# ADR-0034: Three-column desktop shell — left rail, right context rail, and a hidden macOS title bar

- Status: Accepted (**proposed and settled by the user on 2026-10-29; coded and visually verified end to end in the browser the same day, and re-checked on a real macOS window with an isolated `HOME`**)
- Date: 2026-10-29
- Related: [ADR-0024](0024-home-workbench-merge-search-page.md) (home workbench — this ADR does not change the home page's internal narrative, only the shell it lives in), [ADR-0015](0015-w3-minimal-compile-loop.md) (source of the pending-review queue), [ADR-0032](0032-approved-wiki-page-visibility.md) (source of the recently-changed pages), [ADR-0006](0006-scope-freeze.md) (scope freeze — the binary name `repotory` does not move, only the bundle directory does), [ADR-0029](0029-in-app-update-download.md) (the update badge moves from the navbar into the left rail; the verdict and its storage remain the same single source)
- Starting schema: v28 (**this ADR changes no schema**)

## Background

### Fact one: what the user pointed at first — the top-level layout is not how a desktop app should look

User feedback (2026-10-29): "The desktop app's layout needs adjusting… most desktop apps use a left/center/right top-level layout; the leftmost one can be narrower and wrap the close/maximize/minimize buttons." Before the change the shell was **a navbar running across the top** (brand mark + seven top-level entries + theme/language + update badge) plus one centred content column:

- The navbar ate roughly 60px of an 860px-tall window, and what it bought was seven links — it is a **web navbar**, not a desktop app's navigation;
- The brand mark occupied a large block on the navbar's left while the nav entries were pushed to the right, so the eye had to cross the whole bar;
- More than 300px of screen space on the right stayed permanently empty, with no resident surface answering "what is waiting for me".

### Fact two: on macOS this shell was broken, and the breakage was platform-shaped

Even with the title bar hidden, Wails' macOS window keeps `NSWindowStyleMaskTitled`, so the traffic lights (close/minimise/full-screen) are drawn by the system at the **top-left of the webview's content area**. The old navbar was full width, so on the macOS build its leftmost end — exactly where the brand mark sits — was pressed under the traffic lights. Windows and Linux keep their native frame, and the same navbar looked perfectly fine there.

**The defect appears only on macOS and is only visible on macOS**, which is why it survived until someone opened the app by hand. The fix cannot be "tune the padding a bit more" — that would be patching a layout that should be replaced.

### Fact three: the app name was still all lowercase

User feedback, item five: "The desktop app's name is still all lowercase, which is not the convention." The root cause sat in `wails.json`: `name` was `repotory`, and `outputfilename` was `repotory` too — the former decides the bundle directory name (`build/bin/repotory.app`) and the DMG volume name, the latter decides the executable inside the bundle. `productName` was `Repotory`, but it reaches neither of those, so the artifact showed up lowercase in Finder, in Launchpad, and in `/Applications`.

### Fact four: the right rail needs no new backend

The data behind "what is waiting for me" was already there: the pending-review queue is the ADR-0015 gate's product (`listPendingWikiPages`), and the recently-changed pages are the approved pages ADR-0032 opened up (`browseWikiPages`, ordered by `updated_at DESC`). **The right rail needs no new binding** — it only has to put two existing queries somewhere within reach.

## Decision

**1. The shell becomes three columns: a 72px left rail / centre content / a 288px right context rail.**

- Left rail (`SideRail`): brand mark + seven top-level entries (home/dashboard/search/knowledge/wiki pages/review/settings) + theme and language switchers at the bottom. **Icon-only**; the names live in `aria-label` and in the hover label — 72px cannot hold text entries.
- Centre: scrolls on its own, `max-width: 1280px`, centred. When width runs short the centre column narrows first; the right rail is not sacrificed first.
- Right rail (`ContextRail`): a global search entry (Enter jumps to `/search?q=`), **pending review**, **recently updated**. Collapsible into a 30px handle; the collapsed state lives in `localStorage` (`repotory:context-rail-collapsed`), and **a collapsed rail does not pop back on its own** — what is remembered is the last choice this person made on this machine.

**2. macOS hides its title bar, and the left rail "wraps" the traffic lights.**

`main.go` uses `mac.TitleBarHidden()` (`TitlebarAppearsTransparent` + `HideTitle` + `FullSizeContent`): the title bar is gone, the traffic lights remain, and content starts at the very top of the window. The top of the left rail steps aside by 28px (the native title bar's height) plus the rail's own 12px of breathing room, so the traffic lights fall inside the rail and the brand mark sits below them.

**3. Having given up the title bar, window dragging is taken over by a drag band at the top of the centre column.**

Wails' drag test reads `getComputedStyle(e.target).getPropertyValue('--wails-draggable')`, and that property **inherits**, so the drag surface declares `--wails-draggable: drag` while **every interactive descendant must explicitly declare `none`** — otherwise a link such as the brand mark becomes a drag handle: pressing it neither drags the window nor activates it.

The drag band **does not live in the left rail**; it lives at the top of the centre column: the rail is only 72px wide and the traffic lights already take the horizontal range 9..68px, so a band laid over them leaves a 9px sliver that cannot be dragged. The centre column's top is a full-width band, which is the grip a normal window has.

**All three columns step aside for that same band** (`--window-controls-inset: 28px`, in effect only in the macOS desktop build): those 28px are the native title bar's height, and the webview receives no clicks inside them — laying content there means laying it in a region that cannot be clicked. Half of the right rail's collapse button was falling inside it; the whole rail moves down so the button is fully clickable.

**4. The brand mark exists in exactly one place: the left rail.**

The old navbar is gone and `BrandMark`'s render sites collapse to the single rail slot. `BrandMark.test.tsx` pins two rules: `.brandMark` in the rail **must not have a `border-radius`** (the brand master is a square card whose hairline frame sits ~1.3px from the edge, so any visible radius swallows the frame's four corners and the mark reads as a torn sticker), and the home assistant header **must not render `BrandMark` again** (a logo appearing three times on one home page reads as three products).

**5. The floating quick-capture button anchors to the centre column's right edge, not to the viewport's.**

The button is `position: fixed; right: 22px`, so with the right rail open it floated on top of that rail. It now uses `right: calc(var(--context-rail-offset) + 22px)`, where `App` publishes `--context-rail-offset` as either `--context-rail-width` or `--context-rail-collapsed-width` depending on the collapsed state (CSS Modules do not rewrite custom property names, so the value crosses component boundaries).

**6. The artifact directory becomes `Repotory.app`; the executable name does not move.**

`wails.json`'s `name` becomes `Repotory` (`outputfilename` stays `repotory`), the Homebrew Cask's `app` stanza and the tap's `tests.yml` assertion change to `Repotory.app`, and the DMG volume is named `Repotory`. **The binary name `repotory` is a frozen identifier under ADR-0006** (it is bound to the data directory and the `repotory_*` MCP prefix migration history), so only the bundle directory layer changes.

Renaming that layer **does not move the user's data**: the data directory in `internal/platform` is the hard-coded constant `dirName = "repotory"` (`~/Library/Application Support/repotory/repotory.db`, same basename for the log) and is **independent of the bundle name** — so before and after the rename the app opens the same library, the same plugins, and the same log path. **The bundle identifier does not change either**: Wails' `CFBundleIdentifier` is `com.wails.{{safeBundleID .Name}}`, and `safeBundleID` **lowercases** the name (`Repotory` → `repotory`), so the identifier stays `com.wails.repotory` and macOS LaunchServices does not treat it as a different application. The display name (`CFBundleName`) comes from `info.productName`, which has been `Repotory` all along — **the lowercase the user saw was always the bundle's directory name** (`repotory.app`), not the display name; changing `name` is what actually addressed it.

**7. The right rail disappears on narrow screens (≤1024px), and the centre column tightens its padding at ≤768px.**

The right rail is an enhancement surface, not the main surface; when the screen is too small it goes first.

## Rationale

- **Left/centre/right is the consensus shape of desktop applications**, because it puts "where can I go", "what am I doing" and "what else is waiting for me" in the field of view at the same time. The old top bar answered only the first, and paid for it with a horizontal band. The new left rail answers the first in 72px, and the horizontal and vertical space it frees goes to the third.
- **Hiding the title bar is not about looks — it is about pulling the traffic lights into the structure.** That the system draws them over the content's top-left corner is not negotiable, but **how the content arranges itself underneath them is**. Leaving room at the top of the left rail turns "the navbar is squashed by three dots" into "the left rail wraps close/minimise/full-screen".
- **The right rail reuses existing bindings** and adds no backend surface: `listPendingWikiPages(0)` for pending review (`projectID=0` means "do not narrow by project"), and `browseWikiPages(0, 6)` for recently-updated approved pages (the backend already orders by `updated_at DESC` and returns summary rows, not bodies). **`listAllNotes()` and `listApprovedWikiPages()` are deliberately not used** — those ship every note body and every approved page body into the browser, and the rail should not pay that price on every mount.
- **The collapsed state must be remembered.** The right rail is a resident surface; folding it away is an explicit "don't take up space", and popping it back on the next launch means the request was never heard.

## Consequences

- Positive: horizontal space goes back to the content and the right rail; the macOS build's top-left corner no longer has an element pressed under the traffic lights; "pending review" and "recently updated" are reachable within one screen (each previously cost a navigation); the application presents itself as `Repotory` in Finder, Launchpad, and `/Applications`.
- Negative: Windows and Linux keep their native frame, so on those platforms the window gains a system title bar at the top — **a shell that spans three platforms cannot be pixel-identical**, and this ADR chooses "the same left rail plus each platform's own window decoration"; an existing `/Applications/repotory.app` left in place coexists with a newly installed `Repotory.app` (macOS's default file system is case-insensitive, so the same path resolves to the same bundle, but the packaging directories and the CI assertion must be written with the new spelling or the tap's case-sensitive runner goes red); the right rail is a **second** navigation surface, so adding or removing a navigation item means also deciding whether an entry for it belongs there too.
- Boundaries: **every block in the right rail must have an equivalent full-page destination** (search → `/search`, pending review → `/review`, recently updated → `/wiki`), otherwise the rail becomes the only way in and violates ADR-0024's "top-level pages need stable anchors"; **the left rail carries no state other than the update badge** — it is navigation, not a dashboard.
- Known limitation: the rail's "pending review" and "recently updated" issue one request each, with no consistency guarantee between them (a page may appear in both or in neither) — the practical impact is tiny (both sets change rarely), but **it is not a snapshot**, so both the docs and the UI wording describe a *list*, not "the exact set as of this moment".

## Implementation corrections

**1. `transport.call()` is not async — a missing binding throws synchronously.** The rail calls `listPendingWikiPages(0)` inside a `useEffect`, and the Wails transport **throws synchronously** when the binding is missing (an older desktop binary running a newer frontend, or a test mock that does not carry the method). `await` does not catch a synchronous throw — the whole effect would take the shell down. The rail therefore wraps calls in a local `load()` helper: `try { run().then(...) } catch { onFailure() }`, degrading to empty lists on failure. **The rail is decoration; it is not worth crashing the whole shell for.**

**2. The i18n gate's allowlist moved with the code.** The left rail's language switcher has to display the language names themselves (`中文` / `English`), which is the only hardcoded Chinese allowed in source. The `ALLOW_CJK_IN_SRC` entry in `scripts/check-i18n-keys.mjs` therefore moved from `App.tsx` to `components/SideRail.tsx` — **moved, not added**, because every extra file on that list is an extra hole in the gate.

**3. The brand mark's corner radius nearly came back while the shell was being rebuilt.** The new `.brandMark` rule was written with a `border-radius: 4px` (muscle memory from the old navbar era) and was caught by `BrandMark.test.tsx`'s CSS-reading assertion — that assertion reads the stylesheet source because **a radius is a crop, not a style, and a DOM assertion cannot see it**.

**4. The drag band's height copies the native title bar's 28px so that nothing has to be guessed about hit-testing.** With the title bar hidden, this machine cannot answer by experiment who owns the strip at the top of the window: synthetic mouse events (`CGEventPost`) do reach the webview (the hover label appears), but AppKit does not honour the drag that comes with a synthetic event — neither `performWindowDragWithEvent:` nor the native title bar drag moves the window — and this terminal has no Accessibility permission, so a real drag cannot be scripted. **Both possibilities are real**: the strip is either handled by AppKit's title bar (the webview never sees the events) or by the webview (`--wails-draggable: drag` takes effect).

So nothing is guessed: the band is 28px tall (= the native title bar's height), and **the user's action is identical in both cases** — drag the window from that strip at the top of the window. Whoever owns the band, the interface the user sees and the place they grab stay the same; and all three columns move down by 28px, so everything stays clickable in both cases. **This is a design that collapses two unverified possibilities into the same observable behaviour, rather than a guess.**
