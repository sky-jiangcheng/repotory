# ADR-0026: An async-readiness contract for frontend tests — which layer owns "wait for the data"

Status: **Proposed** (2026-10-18). Both the direction and the sub-decision are fixed by the user — A2 + A1 + C, B rejected, and the helper scoped to four files (see Decision). **A2 + A1 and the probe fixture are implemented (early 2026-10-19, past midnight from the day the direction was set)**; criteria 1, 2, 3, 5 and 6 are met. **Criterion 4 (C) is not done, which is why this ADR stays Proposed.** Implementation touched no production code.

## Background

On 2026-10-18 a CI-only flake in `web/src/pages/Review.test.tsx` was fixed (commit `8d81714`): the project `<option>`s of a controlled `<select>` come from `projects`, and `projects` only renders after the load effect's `getProjects()` promise lands. The test grabbed the combobox on the first paint and changed its value; when it won the race the change handler received an empty value, `Number('')` was 0, `projectFilter` stayed 0, the project-gated button never enabled, and the failure surfaced far from its cause as `AssertionError: expected true to be false`. The fix extracted `pickProject()` on the spot, with the judgement that "only `AiTab.test.tsx` still shares the pattern, and it is structurally safe".

**That judgement needs correcting — the scope is larger than selects.** Probe method: delay each of the three `beforeEach` promises (`getProjects` / `listPendingWikiPages` / `findMergeCandidates`) by 300 ms, simulating a loaded runner on which promises land late, then run the whole file:

- **3 of 12 tests go red, and none of them is a select case**: `renders each candidate as a directed pair, loser first` (`Review.test.tsx:149`, `toHaveLength(2)` receiving 0), `hides a dismissed pair locally without calling anything`, and `degrades a null candidate report to the empty state instead of throwing`.
- Under the same probe, the 3 tests that use `pickProject()` stay green.

So the actual race class is:

> **`findBy*` awaits an anchor that is mounted unconditionally, and the test then reads effect-resolved state synchronously.** The anchor was already there, so `findBy*` resolves immediately and waits for nothing.

Mechanism facts (each checked against the code, not inferred):

- The load effect at `Review.tsx:84-119` puts every `setState` inside `Promise.all(...).then()` (`setProjects` at `:102`); effect deps are `[projectFilter, reloadToken, t]`.
- The merge-suggestion `<section>` is **mounted unconditionally** — `Review.tsx:312-319`, whose comment states "always mounted" deliberately; the rows come from `mergeCandidates = merge?.candidates ?? []` (`:200-203`). So `review.mergeHeading` exists on the first paint while the `<li>`s wait on the promise.
- All 8 `<select>` sites were checked. One more shares Review's exact shape **and is already mounted inside the suite without being interacted with**: `pages/home/HomeKnowledgeAssistant.tsx:426-438` — a static `<option value={0}>` keeps the select alive on the first paint, the project options come from a `projects` prop, and `Home.tsx:40-42` lands it via `.then`. **The next person to write an interaction test for the home scope selector inherits this exact bug.**
- Four further sites share the async source but are structurally safe because the element is gated on the data: `AiTab.tsx:206` (`{models.length > 0 && …}`), `KnowledgeOrganize.tsx:167-172`, `NoteEditor.tsx:87`, `Search.tsx:97`.

Baseline infrastructure facts (they set each option's floor):

- There is no `setupFiles`; there is no standalone `vitest.config.ts` (the config is inline at `web/vite.config.ts:50-61`); `globals` is off — which is why `Review`/`Home`/`Dashboard`/`Search` each hand-write `afterEach(cleanup)`.
- There is no shared test-utils module; `@testing-library/jest-dom` is not a dependency.
- Render wrapping is **not uniform**: `Review`/`Home`/`Dashboard`/`Search` share the `<MemoryRouter><X /></MemoryRouter>` shape (`Review` and `Home` already wrap it in a local `renderX()`, `Dashboard` does not); `AiTab` has no router and takes required props; `NotFound` and `App.smoke` use the **real i18n** instance while the other six mock it. `App.smoke.test.tsx:34-62` seeds through `beforeAll` + a `Proxy` over the Wails bindings — a third seeding mechanism entirely.
- `web/eslint.config.js` registers exactly one plugin, `react-hooks`.
- Scope freeze is not implicated: this is a test-infrastructure convention and touches neither ADR-0006's product scope nor any frozen identifier.

## Options

### Option A: a shared `renderReady` helper — move "wait for the data" into the render step

It splits in two, and the two differ a lot in cost and in what they actually guarantee.

**A1 · a per-test readiness predicate**: the helper is told what counts as ready, e.g. `renderReady(<ReviewPage/>, () => screen.findAllByRole('listitem'))`.

- Merit: it expresses the real invariant — **the thing you are about to read is present**. `pickProject` survived the probe precisely because the element it awaits *is* the data.
- Cost: the judgement does not disappear, it only moves from "before the assertion" to "at the render call". Pick the wrong anchor (e.g. still `review.mergeHeading`) and the helper cannot save the test. It carries a convention, not a guarantee. And because render wrapping is not uniform, one helper cannot cover all 8 files until someone decides which i18n strategy wins.

**A2 · a generic queue drain `settle()`**: after `render`, `await act(async () => { await new Promise(r => setTimeout(r, 0)) })`, then write the test body unchanged.

- Merit: the microtask queue is drained **completely** before the next macrotask, and every current mock is an immediately-resolved promise, so one macrotask boundary lands all effect state — with no per-test judgement and without touching a single mock default.
- Cost and boundary (it must not be sold as universal): it **cannot** drain chains that wait on real timers (debounce, `useScanPolling`'s interval, the AI wait timer) — those still need explicit waits. It is a blanket wait, which makes "first paint with no data" unobservable in tests. That last point began as an inference and has since been checked as zero exposure in today's component tests; the evidence and the standing constraint are recorded at the end of Decision rather than re-concluded here.

### Option B: make `beforeEach` default mocks return non-empty lists

- Merit as argued: data would simply exist earlier; and `Dashboard.test.tsx` already overrides `getProjects` in all three of its tests, so its `[]` default is dead weight, while `AiTab.test.tsx` has no data defaults at all.
- **Refuted by this ADR's own measurement**: the three tests that went red under the probe **already fed non-empty data** — each seeds its own two candidates. They failed because of *when* the data lands, not *whether* it exists. B changes the latter and leaves the former untouched.
- Hard cost (each confirmed by reading the code): at least three tests break outright — `Home.test.tsx:127-130` (the "no handoff yet" empty state, with no per-test override), `Search.test.tsx:131-138` (`没有匹配的结果`, riding the `[]` default of `searchAll`), and `useKnowledgePage.test.tsx:97-102` (asserting `projectNames` `toEqual([])`). B also inverts the product's real path by making the empty state the thing you must deliberately override.
- Structural inconsistency: `App.smoke` seeds through the `Proxy`, which B cannot reach, so the same `Home` component ends up seeded by two different defaults in two files — worse than today.
- Also: `pickProject` uses `findByRole('option', { name })`, which **throws on multiple matches**; a default list containing a same-named project would break even the tests that override it themselves.

### Option C (surfaced during research, not asked for, recorded anyway): a mechanical guard

`eslint-plugin-testing-library`: the npm registry is reachable from this machine (verified HTTP 200) and the plugin is not currently installed; a new devDependency needs an explicit reason per CONTRIBUTING.

- **Honest boundary**: it is good at *shape* problems — un-awaited `findBy*`, `getBy`/`waitFor` misuse — and it **cannot** catch the class that actually broke here (awaiting a statically-mounted anchor, then reading synchronously). Presenting C as the fix for this problem would be a false promise.
- Genuine complementary value: it enforces the shape A1 relies on; and if a `setupFiles` entry is added anyway, it can absorb the 4 hand-written `cleanup` calls and 13 redundant `// @vitest-environment jsdom` docblocks.

### Indicative ranking (the user ratified exactly this on 2026-10-18; the formal record is under Decision)

A2 as the floor (one change, no mock defaults touched, no empty-state test broken), A1 as the explicit supplement wherever real timers are involved, C as a later guard. **B is rejected** — on measurement, not on style.

## Decision

**On 2026-10-18 the user settled it: A2 + A1 + C, in three layers; B rejected.**

- **A2 (generic `settle()`) as the floor**: after `render`, cross one macrotask boundary so every immediately-resolved mock chain lands. It touches no mock default, which is exactly why it does not break the empty-state tests — A2's decisive advantage over B.
- **A1 (per-test readiness predicate) as the supplement**: for what `settle()` cannot drain, i.e. chains that wait on real timers, and for anchors that exist on the first paint and must be replaced by waiting for the data frame itself. The already-shipped `pickProject` is of this second kind and stays where it is.
- **C (`eslint-plugin-testing-library`) as a later guard**, introduced after A lands. Its boundary is pinned in this ADR: it covers **shape** (un-awaited `findBy*`, `getBy`/`waitFor` misuse) and **does not promise** to catch the class documented here. That sentence is pinned deliberately, so nobody later concludes "lint already covers it".
- **Scope of the shared helper (fixed by the user on 2026-10-18)**: `renderReady` / `settle()` serves **only the four identically-shaped files** (`Review`/`Home`/`Dashboard`/`Search`, all `MemoryRouter` + mocked i18n); `AiTab`, `NotFound` and `App.smoke` are explicitly out of scope. The reason is not convenience: `AiTab`'s dropdown is already gated by `{models.length > 0 && …}` and structurally safe, while `NotFound` and `App.smoke` use the real i18n instance and only exercise the shell. Forcing both i18n conventions through one helper would bake a silent "assert the key or assert the translation" mismatch into the API. The boundary has to be written into `CONTRIBUTING.md`, otherwise whoever later writes an interaction test for `NotFound`/`AiTab` will assume a floor that is not there.
- **B is rejected on measurement, not preference**: the three tests that went red under the probe already fed non-empty data; B changes whether data exists, not when it lands, cannot reach `App.smoke`'s Proxy seeding, and breaks three empty-state tests outright.

Rationale for C's new dependency (promotion criterion 4 requires it in writing, so it answers CONTRIBUTING's "new dependencies need an explicit reason" here): correctness of this repo's frontend tests currently rests entirely on a person remembering whether an async query needs awaiting, while `web/eslint.config.js:18-20` registers exactly one guard, `react-hooks`; the probe shows that memory lapses (three sites in one file, and after fixing one the rest remained). The plugin is a devDependency: it never enters the product runtime, does not touch the zero-CGO boundary, and does not change the product dependency surface.

**One originally-open risk closed by measurement**: A2 is a blanket wait, so the concern is that "first paint without data" becomes untestable. The check found **zero exposure in today's component tests** — every `loading` assertion lives in one of the four `renderHook` tests (`useApiData.test.tsx:27-28,100`, `useKnowledgePage.test.tsx:93,129`) and asserts `loading === false`, i.e. the settled state; no component test asserts a skeleton or a loading state, and `settle()` does not apply to `renderHook` anyway. The risk is therefore nil today, but the constraint is permanent: **any future test of first-paint-without-data must explicitly bypass `settle()`** — it must not be recovered by changing mock defaults, which is the rejected B.

## Consequences

- **Implementation surface**: a new shared test module to host `settle()`, plus edits to the four component test files (`Review`/`Home`/`Dashboard`/`Search`); zero lines of production code.
- **Coverage is 4 of the 8 component test files** (settled on 2026-10-18, see Decision): `AiTab`/`NotFound`/`App.smoke` are excluded because their render wrapping differs (no router, real i18n). This is a deliberate boundary rather than a leftover gap — but **an undocumented boundary is the same as promising those three files a floor that does not exist**, hence promotion criterion 6.
- **`settle()` carries a deadlock precondition**: it crosses the macrotask boundary with a real `setTimeout(0)`, so under `vi.useFakeTimers()` it **never resolves** and the test hangs until a `waitFor` timeout. Today that is safe — fake timers appear only in the four `renderHook` tests (`useDebouncedCallback`, `useConfirmClick`, `useScanPolling`, `useApiData`), none of which goes through `render`. But the precondition must be written into the helper's comment, or the first person to bring `settle()` into a fake-timer scenario gets an inexplicable hang.
- "First paint without data" stops being directly observable in component tests: a future skeleton test must explicitly bypass `settle()` (verified that no such assertion exists today).
- **C will surface an outstanding balance**: once the plugin is registered it may report pre-existing shape violations across the suite. "Zero new errors" is not "zero existing errors" — either those get fixed alongside, or they are registered as explicit overrides; silently switching the rule off is not an option.
- What this ADR itself did **not** measure: the real magnitude of CI's lag. The 300 ms probe is an artificial amplification, and the original flake only appeared under runner load. Therefore "A2 is sufficient to eliminate the real CI flake" is an **inference, not a measurement** — it is promoted to acceptance criterion 1 so it gets verified instead of staying in this text as established fact.

## Promotion criteria (Proposed → Accepted)

1. The probe becomes a re-runnable acceptance fixture (delaying those three promises); after the chosen option lands, `Review.test.tsx` must be **12/12 green** (today it is 9/12 under the probe). This is also where "A2 eliminates the real flake" turns from inference into measurement.
2. Add the first interaction test for the `HomeKnowledgeAssistant` scope selector and make it pass **after** the option lands — as evidence that the next inheritor is actually blocked, not by analogy.
3. Add a frontend-testing convention entry to `CONTRIBUTING.md`: `settle()` is the default floor, `settle()` is unusable under fake timers, and **the measurement that rules out B**. That last part must be kept, or the same B proposal resurfaces at the next flake. Mirror `docs/**` ↔ `docs/en/**` and keep `node scripts/check-docs-mirror.mjs` and `node scripts/build-docs.mjs` green.
4. The devDependency rationale for C is recorded above under Decision; what remains is the empirical half — `npm run lint` producing **zero new errors** across the existing 21 test files, with any pre-existing violation either fixed or explicitly registered.
5. `cd web && npm test` green, plus the stress gate used for the original fix (sequential full-suite rounds and concurrent runs contending for CPU).
6. The "helper covers only four files" boundary must be written in **two** places — `CONTRIBUTING.md` and the helper's own comment — naming what is not covered and why: `AiTab`/`NotFound`/`App.smoke` are unprotected, and anyone writing an interaction test for them must not assume `settle()` is there.

## Implementation corrections (facts obtained while implementing, 2026-10-19)

- **The probe has an intensity ceiling**: `findBy*` defaults to a 1000 ms timeout, so `REPO_TEST_LAG_MS` can only go to roughly 900 ms (measured green at both 300 ms and 700 ms, 145 tests). The fixture therefore *re-opens the window*; it is not arbitrary-stress pressure. Green here is not a claim of unbounded timing robustness.
- **`lagged()` must be paired with `mockImplementation`**: `mockResolvedValue(lagged(x))` runs, because thenable unwrapping happens at runtime, but `tsconfig.json` puts all of `src` behind the tsc gate and reported 7 `TS2345` errors — that position is typed for the resolved value, not a promise. Not anticipated when the ADR was written.
- **The probe has to reach the per-test overrides too**: lagging only the `beforeEach` defaults let the three exposed tests bypass the probe entirely, because they `mockResolvedValue` their own non-empty data. Wrapping the overrides as well is what makes the probe actually cover them — and it confirms the B rejection once more: whether the data exists was never the variable.
- **Promotion criterion 2 is measured, not analogical**: reverting the new home scope-selector test to "await the combobox" produces `expected '0' to be '7'` under `REPO_TEST_LAG_MS=300` — the same failure signature Review had, reproduced on a second page.
- **Coverage matches the decision**: `Review`/`Home`/`Dashboard`/`Search` now go through `renderReady`; `AiTab`/`NotFound`/`App.smoke` stay out as decided. The boundary is recorded in both places required by criteria 3 and 6 — the frontend-testing section of `CONTRIBUTING.md` and the helper's comment.
- **Criterion 4 remains open**: C (`eslint-plugin-testing-library`) should arrive as its own change and has not been introduced. That is the only reason this ADR stays Proposed.
