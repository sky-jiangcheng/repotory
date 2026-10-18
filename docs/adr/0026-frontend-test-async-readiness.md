# ADR-0026: 前端测试的异步落地契约——「等数据」这件事写在哪一层

状态：**Proposed**（2026-10-18）。方向已由用户拍定（A2 + A1 + C，B 否掉，见「决策」），**尚未落码**；剩余一处 ⚑ 见「代价」的「未决子问题」条与晋升条件 6。落笔本 ADR 未改动任何生产代码。

## 背景

2026-10-18 修掉 `web/src/pages/Review.test.tsx` 的一处 CI-only flake（提交 `8d81714`）：受控 `<select>` 的项目 option 来自 `projects`，而 `projects` 要等加载 effect 的 `getProjects()` promise 落地才渲染。测试在首帧就取到 combobox 并改值，错过窗口时 change 处理器拿到空值、`Number('')` 为 0、`projectFilter` 停在 0，项目门控按钮永不 enable，失败漂成远离根因的 `AssertionError: expected true to be false`。当时就地抽了 `pickProject()`，并判断「同类模式只剩 `AiTab.test.tsx` 一处，且结构安全」。

**这个判断要修正——范围比 select 大。** 探针方法：把 `beforeEach` 里 `getProjects` / `listPendingWikiPages` / `findMergeCandidates` 三条 promise 各延迟 300ms（模拟高负载 runner 上 promise 晚落地），跑整个文件：

- **12 个用例红 3 个，红的都不是 select 类**：`renders each candidate as a directed pair, loser first`（`Review.test.tsx:149` 的 `toHaveLength(2)` 拿到 0）、`hides a dismissed pair locally without calling anything`、`degrades a null candidate report to the empty state instead of throwing`。
- 同一探针下，改用 `pickProject()` 的 3 个用例全绿。

所以真正的竞态类是：

> **`findBy*` 等的是一个无条件挂载的锚点，随后同步读取 effect 落地的状态。** 锚点本来就在，`findBy*` 立刻 resolve，起不到任何等待作用。

机制事实（逐条对过代码，非推测）：

- `Review.tsx:84-119` 的加载 effect 把全部 setState 放在 `Promise.all(...).then()` 内（`setProjects` 在 `:102`），effect deps 为 `[projectFilter, reloadToken, t]`。
- 合并建议 `<section>` **无条件挂载**——`Review.tsx:312-319`，注释明确写着「always mounted」是刻意的；行数据 `mergeCandidates = merge?.candidates ?? []`（`:200-203`）。故 `review.mergeHeading` 首帧即存在，而 `li` 要等 promise。
- 已核查全部 8 个 `<select>` 站点。与 Review 同形、且**已在测试里挂载但尚未被交互**的还有一处：`pages/home/HomeKnowledgeAssistant.tsx:426-438`——静态 `<option value={0}>` 让 select 首帧即存在，项目 option 来自 `projects` prop，而 `Home.tsx:40-42` 用 `.then` 落地。**下一个给首页检索范围下拉写交互测试的人，会原样继承这个 bug。**
- 另 4 处同形但结构安全，因为元素被数据 gate 住：`AiTab.tsx:206`（`{models.length > 0 && …}`）、`KnowledgeOrganize.tsx:167-172`、`NoteEditor.tsx:87`、`Search.tsx:97`。

现有基建事实（它决定两个方案各自的地板在哪里）：

- 无 `setupFiles`；无独立 `vitest.config.ts`（配置内联在 `web/vite.config.ts:50-61`）；`globals` 未开——于是 `Review`/`Home`/`Dashboard`/`Search` 四个文件各自手写 `afterEach(cleanup)`。
- 无共享 test-utils 模块；`@testing-library/jest-dom` 不在依赖里。
- 渲染包裹**并不统一**：`Review`/`Home`/`Dashboard`/`Search` 同属 `<MemoryRouter><X /></MemoryRouter>` 形状（`Review`、`Home` 已有本地 `renderX()`，`Dashboard` 没有）；`AiTab` 不带 router 且有必传 props；`NotFound` 与 `App.smoke` 用**真实 i18n**，其余六个 mock 掉它。`App.smoke.test.tsx:34-62` 另用 `beforeAll` + Proxy 拦截 Wails 绑定，是第三种 seeding 机制。
- `web/eslint.config.js` 只挂 `react-hooks` 一个插件。
- 范围冻结不牵连：本 ADR 是测试基础设施约定，不触碰 ADR-0006 的产品范围与冻结标识。

## 方案对比

### 方案 A：共享 `renderReady` helper——把「等数据」收进渲染这一步

拆得开是因为它有两种实现，代价与保证力差别很大。

**A1 · per-test readiness 谓词**：helper 接收「什么算好了」，例如 `renderReady(<ReviewPage/>, () => screen.findAllByRole('listitem'))`。

- 合理性：它表达的是真正的不变量——**你即将读的东西已经在了**。`pickProject` 之所以扛住探针，正是因为它等的那个元素本身就是数据。
- 代价：判断量并没有消失，只是从「写在断言前」挪到「写在渲染时」；锚点选错（例如仍选 `review.mergeHeading`）helper 救不回来。它承载的是约定，不是保证。且因渲染包裹不统一，一个 helper 覆盖不了 8 个文件，必须先决定 i18n 策略归谁。

**A2 · 通用队列排空 `settle()`**：`render` 后 `await act(async () => { await new Promise(r => setTimeout(r, 0)) })`，然后测试体照常写。

- 合理性：微任务队列会在下一个宏任务之前**全部排空**，而当前所有 mock 都是立即 resolve 的 promise，故一次宏任务边界即可让所有 effect 状态落地——不需要逐测试判断，也不需要动任何 mock 默认值。
- 代价与边界（不可当万能卖）：**不能**排空真等计时器的链路（防抖、`useScanPolling` 的 interval、AI 等待计时器），那些仍需显式等待；它是一道 blanket wait，会让「首帧无数据」在测试里不可观测——这一条起初只是推知，后已核查为现有组件测试零暴露，证据与长期约束记在「决策」末，不在这里重复下结论。

### 方案 B：`beforeEach` 默认给非空 mock 列表

- 合理性：听起来能让「数据」早早存在，且 `Dashboard.test.tsx` 三个用例本来就全部 per-test 覆盖 `getProjects`、那里的 `[]` 默认已是死重；`AiTab.test.tsx` 根本没有数据默认。
- **被本 ADR 的测量直接否证**：探针下红掉的那 3 个用例**本来就喂了非空数据**（用例自己 seed 了 2 条候选）。它们红，只因数据**何时**落地，与**是否存在**无关。B 改的是后者，不动前者。
- 硬代价（逐个读过代码确认）：至少 3 个用例直接破——`Home.test.tsx:127-130`（「还没有 handoff」空态，无 per-test 覆盖）、`Search.test.tsx:131-138`（`没有匹配的结果`，靠 `searchAll` 的 `[]` 默认）、`useKnowledgePage.test.tsx:97-102`（断言 `projectNames` `toEqual([])`）。B 还把空态变成「必须特意覆盖才能得到」的那一面，与产品在空库上的真实路径相反。
- 结构性不一致：`App.smoke` 走 Proxy seeding，B 触不到它 → 同一个 `Home` 组件在两个文件里被两套默认值播种，比现状更糟。
- 另需注意：`pickProject` 用 `findByRole('option', { name })`，**多匹配即抛**；若默认列表里出现同名项目，会连带打破已经自己 seed 过数据的用例。

### 方案 C（研究过程中浮出，非用户所问，但必须记录）：机械化守卫

`eslint-plugin-testing-library`：本机可达 npm registry（已实测 HTTP 200），当前未安装；新增 devDependency 依 CONTRIBUTING 须给明确理由。

- **诚实边界**：它擅长的是未 await 的 `findBy*`、`getBy` 与 `waitFor` 的误用等**形态**问题；它**抓不到**本次真正踩中的那一类（await 静态锚点后同步读状态）。把它当成本问题的解法是虚假承诺。
- 它能做的互补价值：把 A1 所要求的形状钉成规则；若同时引入 `setupFiles`，可顺带收掉 4 处手写 `cleanup` 与 13 处冗余的 `// @vitest-environment jsdom`。

### 结论性排序（2026-10-18 用户按此拍板，正式记录见「决策」）

A2 作为地板（一次性、不改 mock 默认、不破空态），A1 作为涉及真计时器时的显式补充，C 作后置守卫；**B 予以否掉**，理由不是风格而是测量。

## 决策

**2026-10-18 由用户拍板：A2 + A1 + C 三层，B 否掉。**

- **A2（通用 `settle()`）作地板**：`render` 后跨过一次宏任务边界，令所有立即 resolve 的 mock 链路落地。它不动任何 mock 默认值，因此不破空态用例——这是它相对 B 的决定性优势。
- **A1（per-test readiness 谓词）作补充**：用在 `settle()` 排不到的地方，即真等计时器的链路，以及「锚点首帧就在、必须等数据那一帧」的情形。已落地的 `pickProject` 属后者，保留原位不回改。
- **C（`eslint-plugin-testing-library`）作后置守卫**：排在 A 落地之后单独引入。其边界在本 ADR 里写死——它只管**形态**（未 await 的 `findBy*`、`getBy`/`waitFor` 误用），**不承诺**拦住本 ADR 这一类。把这句话写死，是为了阻止后来者误信「lint 已经兜住了」。
- **B 的否决依据是测量，不是偏好**：探针下红掉的 3 个用例本就喂了非空数据，B 改的是「数据是否存在」而非「数据何时落地」；它还够不到 `App.smoke` 的 Proxy seeding，并会直接破 3 个空态用例。

C 的新增依赖理由（晋升条件 4 要求写实，此处即回答 CONTRIBUTING 的「新增依赖有明确理由」）：本仓库前端测试的正确性目前完全依赖人记住「异步查询要不要等」，而 `web/eslint.config.js:18-20` 只挂了 `react-hooks` 一条守卫；探针证明这种记忆会漏（同一文件 3 处，修掉 1 处后其余仍在）。插件是 devDependency，不进产品运行时、不触零 CGO 边界、不改产品依赖面。

**实测消掉的一条原开放风险**：A2 是 blanket wait，代价面是「首帧无数据」可能变得不可测。核查结论是**现有组件测试零暴露**——`loading` 断言只出现在 4 个 `renderHook` 测试中（`useApiData.test.tsx:27-28,100`、`useKnowledgePage.test.tsx:93,129`），且断言的都是 `loading === false` 这一已落地态；没有任何组件测试断言骨架或加载中。`settle()` 也不作用于 `renderHook`。所以该风险当前为 0，但它是一条长期约束：**今后若要测首帧无数据，必须显式绕开 `settle()`**，不能靠改 mock 默认值找回（那正是被否掉的 B）。

## 代价

- **落地面**：需要新增一个共享测试模块承载 `settle()`，并改动 4 个组件测试文件（`Review`/`Home`/`Dashboard`/`Search`）；生产代码 0 行。
- **本次决策带出的未决子问题 ⚑**：共享 helper 覆盖不到全部 8 个组件测试文件，因为渲染包裹本就不统一——`NotFound` 与 `App.smoke` 用真实 i18n，其余六个 mock 掉它，`AiTab` 还根本不带 router。要么 helper 接受 provider 策略作参数，要么只覆盖那 4 个同形状文件、其余显式不纳。这个岔路本 ADR 未定，落地前须先拍。
- **`settle()` 有一个会死锁的前提**：它靠真实 `setTimeout(0)` 跨宏任务边界，因此在 `vi.useFakeTimers()` 下**永不 resolve**，测试会挂到 `waitFor` 超时。现状安全——fake timers 只出现在 4 个 `renderHook` 测试（`useDebouncedCallback`、`useConfirmClick`、`useScanPolling`、`useApiData`），不经过 `render`。但这条前提必须写进 helper 的注释，否则第一个把它带进假计时器场景的人得到的是一场无法理解的挂死。
- 「首帧无数据」自此在组件测试里不可直接观测：将来要测骨架屏必须显式绕开 `settle()`（当前无此类断言，已核）。
- **C 落地时会翻出既有账**：插件一旦挂上，可能一次性报出现存测试里的形态违例。「零新增 error」不等于「零既有 error」，届时要么连带修完，要么显式登记 override，不允许静默关掉规则。
- 本 ADR 自身的未测项：CI 真实滞后量级**没有测过**。探针用 300ms 是人为放大，原始 flake 需 runner 负载才现形。因此「A2 足以消灭真实 CI flake」是**推断而非实测**——列为晋升条件 1 去验，不许它作为已证事实留在正文里。

## 晋升条件（Proposed → Accepted）

1. 探针固化为可重跑的验收夹具（延迟这三条 promise），选定方案后 `Review.test.tsx` 须 **12/12 绿**（现状 9/12）。这一条同时是把「A2 足以消灭真实 flake」从推断转成实测的地方。
2. `HomeKnowledgeAssistant` 的检索范围下拉补第一例交互测试，在方案落地后跑通——作为「下一个继承者已被拦住」的实证，而非类比推定。
3. `CONTRIBUTING.md` 增补一条前端测试约定：`settle()` 是默认地板、`settle()` 在 fake timers 下不可用、以及**为何不用 B 的测量结论**（这段必须留，否则同一个 B 方案会在下一次 flake 时又被提出来）。`docs/**` 与 `docs/en/**` 同步，`node scripts/check-docs-mirror.mjs` 与 `node scripts/build-docs.mjs` 全绿。
4. C 的新增 devDependency 理由见「决策」节，已写实；尚缺的是实测半边——`npm run lint` 在现存 21 个测试文件上**零新增 error**，既有违例须逐个处置或显式登记。
5. `cd web && npm test`（含多轮与并发争抢）+ `npm run build` 绿。
6. ⚑ 上文「未决子问题」的 i18n/provider 策略由用户拍定后方可落码。
