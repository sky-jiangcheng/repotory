# 贡献指南

Repotory（仓库与包标识 `repotory`）是本地优先的 Git 知识库桌面应用。欢迎 Issue 与 PR——动手前请花两分钟读完本文，尤其是「范围冻结」与「命名分层」两节，它们是本仓库最容易被好心 PR 违反的约定。

## 环境要求

| 依赖 | 版本 | 用途 |
|------|------|------|
| Go | 1.25+ | 后端（零 CGO，内嵌 SQLite） |
| Node.js | 20+ | 前端构建与测试 |
| Wails CLI | v2.13+（可选） | `wails dev` 开发模式 |

## 本地开发

```bash
# 前端依赖与构建（web/dist 被 go:embed 进二进制，改前端后需重新构建）
cd web && npm install && npm run build && cd ..

# 开发模式（前端热更新 + Wails 绑定注入）
wails dev

# 纯后端构建（桌面应用 + MCP server）
go build -ldflags="-s -w" -o repotory .
go build -o repotory-mcp ./cmd/mcp/
```

提交前请跑齐三件套：

```bash
go test ./...            # Go 全量测试（service/db/knowledge/scanner/diff…）
cd web && npm test       # vitest
cd web && npm run build  # tsc 严格检查（ESLint 现状见 TODO.md）
node scripts/check-docs-mirror.mjs  # 双语文档 1:1 镜像守卫（docs/** ↔ docs/en/**）
```

> 双语文档镜像守卫：`docs/**/*.md`（中文源）与 `docs/en/**/*.md`（英文源）必须互为 1:1。改一边、只改一边的「双语漂移」会被 `scripts/check-docs-mirror.mjs` 在 CI（`docs-mirror` job）拦下。有意只出中文的研究文档（`competitive-positioning.md`、`positioning-brief.md`、`product-review/*`）在该脚本的 `ZH_ONLY` 白名单里；新增此类文档时同步登记白名单，否则守卫会误报。

> **绑定面契约守卫**：`internal/app/api_contract_test.go` 会在 `go test ./...` 里核对 `docs/api/reference.md`（中英双份）与 `*App` 的绑定面——文档写到的绑定必须真实存在、已删除的绑定不得复活、两边文档的绑定集必须一致。改绑定面时**只改代码不同步文档会被这条门拦下**。

> **构建产物清理**：`web/dist` 被 `go:embed all:web/dist` 整个打进二进制，所以那里多一份文件就等于二进制大一份。`npm run build` 末尾会跑 `scripts/prune-web-dist.mjs`，按 Vite 的 `.vite/manifest.json` 精确删除 `assets/` 下的孤儿 chunk（历史包袱：曾累积 15 份 elk chunk，21MB 直接进了可执行文件）。清理范围严格限定在 `assets/`——`dist` 根下的 `index.html` / `favicon.*` 不在 manifest 里，按「未列入 manifest 即孤儿」删会连页面 HTML 一起删掉。

## 架构约定

- **业务逻辑只写在 `internal/service`**：Wails 桌面、headless HTTP（`cmd/server`）、MCP（`cmd/mcp`）三端共享同一实现；`internal/app` 是薄绑定层，每个方法 1-3 行委托，不放逻辑
- **改绑定面必须同步文档**：`internal/app` 的方法签名是对外契约，变更需同步 [docs/api/reference.md](docs/api/reference.md)
- **重大决策走 ADR**：在 [docs/adr/](docs/adr/index.md) 新增编号文件，说明背景、决策与代价；历史决策（分层、FTS5、块编辑器、范围冻结）见 ADR 索引

## 前端测试的异步落地（ADR-0026）

组件在 effect 里用 promise 填状态，所以「元素已挂载」不等于「数据已到位」：`findBy*` 等一个**无条件挂载**的锚点时会立刻 resolve，随后同步读 effect 状态就是拿时序赌绿红。

- **默认地板**：`web/src/test/renderReady.tsx` 的 `renderReady()`（内部 `settle()` 跨一次宏任务边界，微任务会先全部排空）。`Review` / `Home` / `Dashboard` / `Search` 四个组件测试文件已接入。
- **边界（不覆盖哪些）**：`AiTab`（无 router、必传 props）、`NotFound` 与 `App.smoke`（用真实 i18n 实例）**不接 `settle()`**——真实 i18n 返回译文、mock 的 `t` 返回 key 或 `defaultValue`，两种断言口径不塞进同一个 helper。在这三个文件里写交互测试，必须自己等「就是数据的那个元素」。
- **`settle()` 在 `vi.useFakeTimers()` 下会死锁**：它靠真实 `setTimeout(0)`，假计时器里永不 resolve，测试会挂到 `waitFor` 超时。用假计时器的都是 `renderHook` 测试、不经 `renderReady`——别把两者混用。
- **等数据要等对东西**：锚点选错（仍然等静态标题）helper 救不回来。参照 `Review.test.tsx` 的 `pickProject()`，以及「先 `await` 目标 `option` 再改值」的写法。
- **验收探针**：`cd web && REPO_TEST_LAG_MS=300 npx vitest run` 会让 `Review`/`Home` 的加载 promise 延后落地、把竞态窗口重开，必须全绿；不设该变量时 `lagged()` 是 no-op。
- **别用「`beforeEach` 默认给非空 mock 列表」治这个病**——2026-10-18 已实测否证：踩中的用例本就喂了非空数据（问题在**何时**落地，不是**是否**存在），且该法直接破 `Home`/`Search`/`useKnowledgePage` 三处空态用例。详见 [ADR-0026](docs/adr/0026-frontend-test-async-readiness.md)。
- **不要再手写 `afterEach(cleanup)`**：vitest 的 `test.globals` 已置 `true`，testing-library 的自动卸载随之注册（此前 7 处手写 cleanup 是 globals 关着时的复制品，2026-10-19 已清空）。
- **`eslint-plugin-testing-library` 是形态守卫，不是时序保证**：它接在 `web/eslint.config.js`（v7 已无 `flat/recommended`，取 `flat/dom` + `flat/react`），只作用于**真正用 testing-library 的文件**——清单是显式的 `testingLibraryFiles`，因为默认 glob 会把纯逻辑测试里的 `const result = renderMarkdown(...)` 误判成 RTL 的 `render`。**新增一个非 `hooks/` 目录的 `.test.ts` 若引入 RTL，要把它登记进那份清单**，否则规则对它完全不生效。实测过：同一句 `heading.closest('section')` 写在使用例里被报 `no-node-access`，挪进 helper 函数后不报——规则看上下文，别把它当成上面那类竞态的兜底。
- **有一条规则是有意不采的**：`render-result-naming-convention` 显式设为 `off`，理由（纯命名、不承载正确性、已证会误报）写在配置注释里。**不要「顺手把它打开」**——那 12 处 `a`/`b`/`c`/`d` 表达的是共享同一 cacheKey 的多个消费者。

## 范围冻结（重要）

[ADR-0006](docs/adr/0006-scope-freeze.md) 冻结了产品范围：**核心是「发现 → 理解 → 记录 → 检索 → 交给 AI」闭环**，仪表盘与统计是支持能力；插件平台基础设施与 PWA 不再默认扩展。新增大功能前请先开 Issue 讨论，避免与范围声明冲突的投入。

## 命名分层（重要）

品牌展示层与机器标识**有意不一致**，完整规约见 [README 命名分层](README.md#命名分层)。速记：

- 品牌文案写 `Repotory`，完整展示名 `Repotory: Local Git Knowledge Base`，仓库/包标识写 `repotory`
- **不要「顺手统一」冻结标识**：二进制/命令名 `repotory`、数据目录 `repotory`（`internal/platform` 的 `dirName`）、MCP server 名 `repotory-mcp` 与工具前缀 `repotory_*`。它们绑定用户数据迁移史与 AI 客户端对外契约，改名是破坏性变更

## 默认值变更须先过评测门

把一个功能从「默认关」改为「默认开」（或收紧/放宽任何面向用户的默认值），必须先在对应评测设施上跑出达标数据并在 PR 里贴结果（检索类用 `internal/search/abeval` + 标注集，编译类用审核留存率，备份类用恢复演练）。理由：默认值是产品行为，「感觉更好」不是证据——2026-10 起 M3（语义检索默认关）与 M7 lane 2（图检索强化门槛）两次拍板均以 delta 数据为准，此惯例成文以防回退。

## 提交与版本

- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)（`feat:` / `fix:` / `docs:` / `refactor:` …），scope 用受影响的域（如 `feat(server):`、`fix(kb):`）
- 版本号 SSOT 是 `wails.json` 的 `info.productVersion`，用 `scripts/bump-version.sh` 同步到 `web/package.json`、`internal/version` 与文档站徽章，不要手改散点
- 面向用户的变更请同步更新 [CHANGELOG.md](CHANGELOG.md) 的 `[Unreleased]` 条目与对应手册页（`docs/**/*.md` 是唯一内容源，`docs/**/*.html` 是构建产物，**不要手改**）

## PR 检查清单

- [ ] `go test ./...`、`npm test`、`npm run build` 全绿；`node scripts/check-docs-mirror.mjs`（双语文档 1:1 镜像守卫，CI `docs-mirror` job）通过
- [ ] 不触碰范围冻结与冻结标识（或已在 Issue/ADR 中说明理由）
- [ ] 绑定面变更已同步 API 参考；用户可见变更已更新手册与 CHANGELOG
- [ ] 新增依赖有明确理由（本项目依赖极简：wails、mcp-go、minio-go、chromem-go、modernc sqlite）

## 报告问题

Bug 与功能建议走 [GitHub Issues](https://github.com/sky-jiangcheng/repotory/issues)，请附版本号、平台与日志片段（日志位置见[故障排查](docs/troubleshooting.md)）。**安全漏洞不要开公开 Issue**，走[私密安全报告](SECURITY.md)。
