# GitBuddy 产品深度审视：价值重估、范围收缩与保留功能完整规格

- 日期：2026-08-24
- 范围：以 Claude（Anthropic）与 DeepSeek Harness 的产品标准为基准，重估 GitBuddy 的价值与目标，砍除约一半功能，为保留功能输出无遗漏的实现规格，并提出优化项。
- 关联：[ADR-0006](../adr/0006-scope-freeze.md)、[定位简报](../positioning-brief.md)、[代码审查 2026-08-18](../code-review/2026-08-18-deep-review.md)

---

## 0. 摘要

**一句话结论**：GitBuddy 唯一不可替代的价值是「跨会话、跨项目、人工沉淀的本地项目上下文层」——这是 Claude Code / DeepSeek / Cursor 等编码代理天生缺失的环节（代理的上下文随会话消亡）。当前产品把一半资源花在「提交统计仪表盘」和「平台化基建」上，与这一核心价值无关，应当砍除。

**砍/留速览**（保留 15 项，砍除 20 项，约各半）：

| 保留（核心闭环） | 砍除（非核心） |
|---|---|
| 仓库自动发现 | 仪表盘 / 每日统计 / 目标环 / 趋势图 / 热力图 |
| 自动项目分组 | 仓库收藏 / 按需刷新历史 / 状态栏 / 工作日检查 |
| 项目理解（README/技术栈/LOC/依赖/活跃度/最近提交） | 独立待办系统（todos） |
| Markdown 笔记（CRUD/标签/置顶/迁移/草稿） | 块编辑器高级块（块面板/拖拽/模板插入） |
| 版本历史（快照/diff/恢复） | yaegi 插件平台 + 知识源注册表 |
| FTS5 全文搜索 | 手动项目级别调整（level_override） |
| 命令面板 / 全局搜索 | PWA / SEO / HTTP API spec |
| 富渲染（hljs/Mermaid/KaTeX/GFM） | agent-score 自检 |
| Claude 记忆导入（固定管线） | `daily_code_standard` 配置与判断 |
| MCP server（精简为 3 个锐利工具） | —— |
| llms.txt / 笔记导出 .md | —— |
| i18n / 主题 / 单文件跨平台（架构） | —— |

---

## 1. 以 Claude / DeepSeek Harness 产品标准审视价值与目标

### 1.1 两个基准产品标准的提炼

**Claude（Claude Code / Claude 产品线）标准**，可归纳为四条：

1. **交互优先，面板最后**。Claude Code 是一个终端会话，不是仪表盘。价值在「对话—行动」的循环里，任何「统计展示型」界面都不构成主叙事。
2. **单一清晰职责**。Claude Code 只做一件事：在代码库语境里帮你完成任务。平台化、插件化、多形态交付都在稀释它。
3. **零配置即得信任**。首次运行就是全部能力，不做播种、不做多步引导，结果是确定、可验证的。
4. **上下文即产品**。Claude 的全部魔法是把「相关上下文」装进窗口。它的天然缺口是**跨会话持久记忆**——每轮对话都会遗忘上次的结论。

**DeepSeek Harness 标准**，可归纳为四条：

1. **工具面小而锐**。Harness 的价值在于代理可调用的工具集：宁可少而准，不要多而滥。每个工具都有明确输入/输出契约。
2. **延迟与成本受控**。一切读取都应当是廉价的、有边界的（截断、缓存、超时），不做无界扫描。
3. **可观测与确定性**。运行状态可自检、可复现，失败有明确信号而不是静默吞掉。
4. **评估内建**。有可运行的自检/冒烟路径，保证「声称的」与「实际能跑」一致。

### 1.2 对 GitBuddy 的审视结论

**核心价值判定（成立的部分）**：GitBuddy 的「发现 → 理解 → 沉淀 → 检索 → 交给 AI」闭环本身是正确且稀缺的。市场已有提交统计（GitHub Insights、VS Code）、笔记工具（Obsidian、Notion）、代码搜索（rg、GitHub Code Search），但没有一个工具把「本地项目的持久上下文」结构化沉淀后交给代理复用。**这个位置，恰恰是 Claude 产品标准第 4 条（上下文即产品）和 DeepSeek 工具面标准（第 1 条）交汇处唯一空白的格子**。

**三处错位（需要修正的部分）**：

1. **统计面板喧宾夺主**。`daily_stats` 表、刷新管线、热力图、趋势图、目标环、状态栏、收藏回填——约等于半个产品的工程重量——全部服务于「昨天写了多少行」这一商品化叙事。用 Claude 标准看，这是把「面板」当「产品」；用 DeepSeek 标准看，这是把预算花在无界统计扫描上。
2. **功能面过宽**。待办（todos）与笔记职责重叠（GFM 任务列表已覆盖）；块编辑器把纯 Markdown 产物复杂化为块面板/拖拽/模板；yaegi 插件平台是已被 ADR-0002/0006 否决的平台叙事的残留基建；PWA/SEO/HTTP spec 是被冻结能力的死重。这些都在稀释「单一清晰职责」。
3. **AI 出口弱于入口**。入口（发现/理解/笔记）很重，出口（MCP 6 个工具、llms.txt、导出）偏散。MCP 工具面超过 DeepSeek 标准的「锐利」要求；没有一次性 onboarding 把用户带进闭环；llms.txt 是「全部笔记的 20 条截断」，而非「按项目组织的高信噪比上下文」。

### 1.3 重述后的目标

> **一句话定位**：GitBuddy 是编码代理的本地持久上下文层——自动理解你的项目，让你沉淀跨会话知识，并以最少、最锐利的接口交给任何代理使用。

**三件事（全部资源只投入这三件）**：

1. 让「理解项目」零成本发生（自动发现 + 自动挖掘 + 缓存，全程后台）。
2. 让「沉淀知识」快且安全（Markdown 笔记 + 自动版本历史 + 一键导入 Claude 记忆）。
3. 让「交给 AI」成为一等公民（精简 MCP 工具面 + llms.txt + 导出，与桌面端共享同一实现）。

---

## 2. 功能总账

以下按领域列出当前全部功能单元，标注决策（**保留** / **砍除**）与理由。对应代码位置一并给出，供执行砍除时对照。

| # | 功能 | 领域 | 决策 | 理由 | 代码位置 |
|---|---|---|---|---|---|
| 1 | 仓库自动发现 | 发现 | **保留** | 闭环起点，零配置 | `internal/scanner` |
| 2 | 自动项目分组（Monorepo/嵌套） | 发现 | **保留** | 决定上下文边界，保自动策略 | `internal/grouper` |
| 3 | 手动向上合并/向下拆分 | 发现 | **砍除** | 自动分组覆盖 90%，手动是长尾复杂度 | `db.SplitProjectDown/MergeProjectUp`、ProjectDetail 按钮 |
| 4 | README 摘要 | 理解 | **保留** | 项目现状的入口 | `knowledge.Mine` |
| 5 | 技术栈识别 | 理解 | **保留** | 高信噪比上下文 | `knowledge` |
| 6 | 语言 LOC 占比 | 理解 | **保留** | 理解项目构成 | `knowledge` |
| 7 | 依赖清单 | 理解 | **保留** | 理解项目构成 | `knowledge` |
| 8 | Top 贡献者 | 理解 | **保留** | 理解活跃人群 | `knowledge` |
| 9 | 活跃度统计 | 理解 | **保留** | 「项目是否还活着」信号 | `knowledge` |
| 10 | 最近提交流 | 理解 | **保留** | 「现在发生了什么」 | `stats.GetRecentCommits` |
| 11 | repo_meta 缓存 | 理解 | **保留** | 避免重复走树，性能关键 | `internal/db/repo_meta.go` |
| 12 | Markdown 笔记 CRUD | 沉淀 | **保留** | 核心资产 | `db/notes.go`、`service/note.go` |
| 13 | 笔记元数据（标题/标签/分类/置顶/迁移） | 沉淀 | **保留** | 结构化沉淀的基础 | `db/notes.go` |
| 14 | 草稿自动保存 | 沉淀 | **保留** | 零成本信任 | `NoteEditor` |
| 15 | 块编辑器高级块（Callout/Tabs/拖拽/模板） | 沉淀 | **砍除** | 复杂度远超纯 Markdown 收益，见 ADR-0004 边界 | `BlockEditor.tsx` 面板部分 |
| 16 | 富渲染（hljs/Mermaid/KaTeX/GFM/任务列表） | 理解 | **保留** | 让笔记可读，含任务列表渲染 | `utils/markdown.ts` |
| 17 | 版本历史（快照/diff/恢复） | 沉淀 | **保留** | 安全沉淀的差异化卖点 | `db/note_versions.go`、`internal/diff` |
| 18 | 独立待办（todos CRUD/排序） | 沉淀 | **砍除** | 与 GFM 任务列表重叠；代理原生维护任务列表；独立域 + FTS + UI 是死重 | `db/todos.go`、`TodoSection.tsx` |
| 19 | FTS5 全文搜索（笔记+待办） | 检索 | **保留**（去 todos） | 检索核心；todos 移除后仅索引笔记 | `db/search.go` |
| 20 | 命令面板 / 全局搜索（⌘K） | 检索 | **保留** | 交互入口（Claude 式交互优先） | `CommandPalette.tsx` |
| 21 | 仪表盘联合搜索 | 检索 | **砍除** | 随仪表盘整体移除 | Dashboard |
| 22 | 每日代码量统计 | 统计 | **砍除** | 商品化叙事，见 1.2 | `db/daily_stats.go`、`stats` |
| 23 | 目标进度环 | 统计 | **砍除** | 同上 | `GoalRing.tsx` |
| 24 | 趋势折线图 | 统计 | **砍除** | 同上 | `TrendChart.tsx` |
| 25 | 提交热力图 | 统计 | **砍除** | 同上 | `Heatmap.tsx`、`db/daily_stats.go` |
| 26 | 仓库收藏 | 统计 | **砍除** | 为按需回填统计而生 | `ToggleStar`、`collected` 字段 |
| 27 | 按需刷新历史 | 统计 | **砍除** | 同上 | `RefreshProjectHistory` |
| 28 | 工作日检查 | 统计 | **砍除** | 同上 | `dailyCodeStandard`、`BelowStandard` |
| 29 | 状态栏（最近提交） | 统计 | **砍除** | 低价值常驻组件 | `StatusBar.tsx` |
| 30 | SummaryBar / 日期选择器 | 统计 | **砍除** | 随仪表盘整体移除 | `SummaryBar.tsx`、`DatePicker.tsx` |
| 31 | MCP server（6 工具） | AI 出口 | **保留**（精简为 3） | 见第 4 节规格 | `cmd/mcp` |
| 32 | llms.txt 生成 | AI 出口 | **保留**（重做） | 见第 4 节规格 | `service/llm.go` |
| 33 | 笔记导出 .md | AI 出口 | **保留** | 最小且有用 | `service/llm.go` |
| 34 | agent-score 自检 | 平台 | **砍除** | 开发期自检，非产品价值；MCP 冒烟脚本可替代 | `tools/agent-score` |
| 35 | yaegi 插件平台 | 平台 | **砍除** | ADR-0006 已冻结，整段移除 | `internal/core/plugin`、`service/plugin.go` |
| 36 | 知识源注册表 + 脚本导入器 | 平台 | **砍除** | 仅保留固定 Claude 导入管线 | `runtime.go` sources |
| 37 | Claude 记忆导入 | 沉淀 | **保留** | 闭环喂养的关键入口 | `internal/importers/claude` |
| 38 | i18n（zh/en） | 支持 | **保留** | 已实现，成本低 | `web/src/i18n` |
| 39 | 主题 / 设计系统 | 支持 | **保留** | 已实现 | `web/src/styles/design-system` |
| 40 | PWA / SEO 产物 | 平台 | **砍除** | 已冻结的死重 | `utils/install.ts`、`utils/seo.ts` |
| 41 | OpenAPI / HTTP API spec | 平台 | **砍除** | 绑定面契约文档，无真实 HTTP server | `docs/api/` |
| 42 | 单文件跨平台 / 安全头 | 架构 | **保留** | 架构资产 | `main.go` |

---

## 3. 砍除清单的连带影响与执行范围

> 本节用于指导实际动手砍除时「改到哪里、删哪些文件、动哪些迁移」。**数据保留原则**：砍除功能对应的存量数据（如 `daily_stats`、`project_todos` 表）在 v-next 迁移中**保留但停止写入**，不 DROP——避免破坏用户已有数据；代码层全部移除。

### 3.1 统计领域（砍除 #22–#30）

- **Go**：删 `internal/db/daily_stats.go`、`internal/stats`（保留 `stats.RecentCommit` 所需的最小解析——`GetRecentCommits` 仍用于「理解」；将 `GetRecentCommits` 与其依赖迁出 stats 包）。删 `service/refresh.go`、`service/summary.go` 中统计相关函数；删 `enrichProjects`/`dailyCodeStandard`/`BelowStandard`/`IsWorkday` 逻辑；`ProjectResponse` 缩减字段。
- **迁移**：新增 v11 迁移仅调整 `insertDefaults`（移除 `daily_code_standard` 播种）与 `daily_stats`/`project_todos` 停止触达；不 DROP 表。
- **绑定面**：删 `GetProjects(date, starredOnly)` 的 date/starred 语义（简化签名）、`GetSummary`、`GetHeatmapData`、`GetStatusBar`、`GetTodoCounts`、`RefreshProjectHistory`、`ToggleStar`、`UpdateProjectLevel`。
- **前端**：删 `Dashboard.tsx` 及其子组件（`SummaryBar/GoalRing/Heatmap/StatusBar/DatePicker/ProjectCard/ProjectSearchDropdown`、`dashboard/` 目录）；`App.tsx` 路由移除 `/dashboard`；导航回到 知识库 / 设置 两栏。
- **DB 查询**：删 `db.GetStatsByProject/GetStatsByRepositoryAndDate/GetStarredProjects/GetCollectedProjectIDs` 等；`projects.is_starred/collected` 列保留但不再使用。

### 3.2 待办域（砍除 #18）

- 删 `internal/db/todos.go`、`service/todo.go`、前端 `TodoSection.tsx`；FTS 虚拟表 `project_todos_fts` 及触发器从 `ftsSchemaStatements` 移除（存量库已建，不主动 DROP，迁移中跳过重建即可）；搜索逻辑仅保留 notes。
- 笔记内 GFM `- [ ]` 任务列表继续渲染（#16 保留），用户既有待办可在迁移脚本里转为笔记内任务列表（可选）。

### 3.3 块编辑器高级块（砍除 #15）

- `BlockEditor.tsx` 降级为「纯 Markdown textarea + 实时预览 + 草稿自动保存」，删除 `/` 块面板、`buildPaletteItems`、拖拽排序、插入模板逻辑；`detectType/joinBlocks` 启发式逻辑可整体移除。

### 3.4 插件平台（砍除 #35–#36）

- 删 `internal/core/plugin/`、`internal/core/plugin/runtime/`、`service/plugin.go`、`examples/plugins/`、`docs/plugins/`。
- `importers/claude` 保留，改由 `service` 直接调用（`service.importClaudeMemory()`），去掉 runtime 注册表/事件总线/ImportRun 统计层，直接返回 `{created, updated, skipped}`。
- 依赖 `traefik/yaegi` 从 `go.mod` 移除。
- 前端 `PluginsTab.tsx`、`GetPluginStatuses/GetKnowledgeSources/TriggerKnowledgeImport/ReloadPlugins` 绑定全删。
- 启动 `Startup()` 中的 auto-import 改为直接执行一次 Claude 导入（保留 `auto_import` 开关语义）。

### 3.5 平台死重（砍除 #34、#40、#41、#3）

- 删 `tools/agent-score/`、`docs/api/`、`utils/install.ts` 的 PWA 逻辑与 `utils/seo.ts` 的 OG 产物（`usePageMeta` 保留最小 title 语义）、`level_override`/`SplitProjectDown`/`MergeProjectUp`。
- `docs/sidebar.json`、README 功能表、`CHANGELOG` 同步更新分级口径。

---

## 4. 保留功能：无遗漏实现规格

> 规格格式：**目标** → **现状** → **保留边界** → **实现细节（验收标准）**。每一节都可直接作为开发任务的验收清单。

### 4.1 仓库自动发现

- **目标**：零配置发现本地所有 Git 仓库，全程后台，不阻塞 UI。
- **现状**：`scanner.ScanRepositories` 递归 `filepath.WalkDir` 找 `.git`；扫描根默认播种；`useScanPolling` 轮询进度。
- **保留边界**：扫描根管理（设置页）保留；扫描触发保留（手动按钮 + 启动后自动）。
- **实现细节**：
  1. 首次启动播种默认扫描根后，自动触发一次后台扫描（无界面阻塞）。
  2. 扫描进度通过 `GetScanStatus` + 轮询保留；扫描完成发送 `project.scanned` 事件（前端 toast）。
  3. 扫描过程中跳过不可访问目录（已实现）并设置整体条目上限 `MaxEntries=10000`（已实现）。
  4. 扫描完成后同步 `projects/repositories` 表（`SyncProjectTx/UpsertRepositoryTx/CleanupStaleDataTx`），移除本次未发现的仓库（保留其笔记，置 `project_id` 为空而非删除）。
  5. **验收**：`go test ./internal/scanner ./internal/service` 通过；新增扫描根后触发扫描能在无头环境看到 `repositories` 表增量。

### 4.2 自动项目分组

- **目标**：Monorepo / 单仓库 / 嵌套仓库被自动归入正确项目边界，AI 拿到的是「项目级」而非「仓库级」上下文。
- **现状**：`grouper.GroupRepositories` 按父目录规则分组；`is_auto_grouped` 标记；手动 split/merge 移除后为纯自动。
- **保留边界**：纯自动分组；去掉手动级别调整 UI 与 `level_override`。
- **实现细节**：
  1. 保留三类规则：父目录唯一仓库→父目录为项目；父目录多仓库→合并为项目；嵌套仓库→独立项目。
  2. 删除 `UpdateProjectLevel`/`SplitProjectDown`/`MergeProjectUp` 及其绑定，`level_override` 列不再读写。
  3. 笔记迁移语义保留在项目合并路径中：同一项目下多仓库的笔记天然归属该项目。
  4. **验收**：`go test ./internal/grouper` 通过；`grouper_test.go` 三场景用例保留。

### 4.3 项目理解（知识挖掘 + repo_meta 缓存）

- **目标**：项目详情页与 AI 出口拿到高信噪比的项目现状（README/技术栈/LOC/依赖/贡献者/活跃度/最近提交），且不重复走树。
- **现状**：`knowledge.Mine` 一次产出全部字段，`mineAndCache` 后台执行并缓存到 `repo_meta`；`GetProjectOverview` 命中缓存即时返回。
- **保留边界**：挖掘字段全保留；缓存策略保留；最近提交流保留（`GetRecentCommits`）。
- **实现细节**：
  1. **缓存有效性**：`repo_meta.updated_at` 距今 >7 天时视为过期，后台重新挖掘；git HEAD 变更（以 `repositories.last_scanned_at` 为代理）时重新挖掘。
  2. **并发安全**：`mineAndCache` 保留 `miningInFlight` 去重；补 `defer recover()`（TODO.md 低优先级项，必做，防止单仓库解析 panic 拖垮进程）。
  3. **健壮性**：`DetectContributors` 保持 30s 上下文超时；`git config user.name` 推断同样 30s 超时（已实现，保留）。
  4. **语言统计**：扫描保留 `maxScanFiles=20000` 上限与 `skipDirs`，缓冲 16MB（已实现）。
  5. **验收**：`go test ./internal/knowledge ./internal/db` 通过；`knowledge_test.go` 覆盖 go.mod 块状 require 解析；无缓存时 `GetProjectOverview` 返回 `mining=true` 且不阻塞，二次调用返回 `cached=true`。

### 4.4 Markdown 笔记系统

- **目标**：沉淀跨项目知识的核心载体，数据永远是可读 Markdown，编辑零摩擦。
- **现状**：`project_notes` 表（title/tags/kind/pinned/source/sort_order）+ CRUD 绑定 + 元数据更新 + 置顶 + 跨项目迁移 + 草稿自动保存。
- **保留边界**：全部笔记能力保留；块编辑器降级为纯 textarea（见 3.3），富渲染保留（见 4.8）。
- **实现细节**：
  1. **分类**：`kind` 保留 `knowledge / journal / idea / other` 四档，知识库首页筛选保留（`all/knowledge/other` 三态 + 标签筛选 + 置顶筛选）。
  2. **置顶**：`pinned` 排序在 `ListAllNotes` 中置顶优先（已实现）。
  3. **迁移**：`MoveNote` 保留，项目详情/编辑器内「关联项目」下拉保留。
  4. **草稿自动保存**：`NoteEditor` 保留「内容变化后防抖保存 + 保存失败离线暂存（localStorage）」语义；离开页面或切换笔记时 flush。
  5. **一致性**：`UpdateNoteFull` 单事务更新 content+meta（已实现）保持，保证版本快照一致。
  6. **空值规范**：所有列表接口空返回 `[]` 而非 `null`（已实现，保留）。
  7. **验收**：笔记 CRUD / 置顶 / 迁移 / 草稿保存全链路可用；`go test ./internal/db ./internal/service ./internal/app` 通过。

### 4.5 版本历史

- **目标**：任何一次修改都可回溯、对比、恢复——「沉淀知识」的信任底座。
- **现状**：`note_versions` 表 + `note_versions_snap` 触发器（UPDATE 时快照）+ 每笔记保留 50 版清理触发器 + `internal/diff` LCS 行级 diff + 恢复。
- **保留边界**：全保留。
- **实现细节**：
  1. **快照触发**：确认快照触发于 content 或 meta 变化（`UpdateNoteFull` 单事务触发一次）；`note_versions` 快照列含 title/tags/kind（已实现）。
  2. **diff**：`DiffNoteVersions` 保留行级 LCS diff，前端版本面板展示「与当前版 diff」。
  3. **恢复**：`RestoreNoteVersion` 恢复 content+meta 并触发新快照（当前版先入历史），保证恢复本身可回退。
  4. **容量**：每笔记 50 版上限保留；清理触发器按 `created_at DESC` 裁剪（已实现）。
  5. **验收**：`go test ./internal/diff ./internal/db` 通过；`diff_test.go` 覆盖增删改三态；创建→修改→恢复→再修改链路上版本数单调且不丢数据。

### 4.6 FTS5 全文搜索（去 todos）

- **目标**：跨项目笔记的即时、相关、可高亮的中文友好全文搜索。
- **现状**：`project_notes_fts` + `project_todos_fts` trigram 虚拟表 + 同步触发器 + `bm25` 排序 + snippet `<mark>` + 短 CJK 降级 LIKE + 出错回退 LIKE。
- **保留边界**：仅索引笔记；待办 FTS 移除（3.2）；`SearchAll` 退化为 `SearchNotes` 语义。
- **实现细节**：
  1. **索引收敛**：`SearchAll` 改为只查 notes（迁移后 `project_todos_fts` 不再由新库创建；存量库保留不删）。
  2. **排序**：`bm25` 排序取前 20，`snippet` 窗口 + `<mark>` 高亮保留。
  3. **CJK**：任意查询词 <3 字符自动降级 LIKE（已转义 `%/_`）保留。
  4. **健壮性**：FTS 查询出错回退 LIKE 保留；搜索永不因索引缺失而挂（已实现）。
  5. **验收**：`go test ./internal/db/search_test.go` 通过；中文 2 字词、英文子串、`%`/`_`/引号输入均不抛错。

### 4.7 命令面板 / 全局搜索（⌘K）

- **目标**：键盘优先的项目/笔记跳转入口（Claude 式交互优先）。
- **现状**：`CommandPalette`（⌘/Ctrl+K）+ 项目/笔记搜索；focus trap + ARIA 已实现。
- **保留边界**：全保留；搜索语义随 FTS 收敛（待办项移除）。
- **实现细节**：
  1. 快捷键注册在 App 层（已实现）；Esc 关闭 + focus trap 保留。
  2. 面板搜索走 `SearchAll`（现为 notes-only），条目点击跳转 `/project/:id`。
  3. 空态引导「无项目 → 去设置扫描根」。
  4. **验收**：`npm test` 通过；手动验证 ⌘K 打开、tab 循环焦点、Esc 关闭。

### 4.8 富渲染

- **目标**：笔记的可读性——代码高亮、图表、公式、告示、任务列表。
- **现状**：`utils/markdown.ts` 组合 highlight.js / Mermaid / KaTeX / GFM callout / 任务列表；含 XSS 风险点（审查报告 M8）。
- **保留边界**：渲染保留；任务列表渲染保留（承接砍掉的独立待办）。
- **实现细节**（重点：M8 修复必须落地）：
  1. **安全**：Mermaid `securityLevel: 'strict'`（禁 loose）；KaTeX/hljs 输出在 `DOMPurify.sanitize` 之后再次净化；`hljs.highlight` 包裹 try/catch 并校验语言名，未知语言回退纯文本。
  2. **异步渲染**：Mermaid/KaTeX 异步渲染完成后再挂载，避免闪烁；组件卸载时清理。
  3. **任务列表**：GFM `- [ ] / - [x]` 渲染为可点击复选框（本地态切换，不写回 DB）。
  4. **验收**：含 ` ```unknowngolang `、恶意 `<script>`、畸形 Mermaid 的笔记渲染不崩溃、不执行。

### 4.9 Claude 记忆导入（固定管线）

- **目标**：把 `~/.claude/projects/*/memory/*.md` 一键、幂等地变成可检索笔记——「跨会话记忆」的核心供给。
- **现状**：`importers/claude` 内置导入器，经 plugin runtime 注册为 `claude` 知识源，`Startup` auto-import + 知识库页手动触发。
- **保留边界**：导入能力保留；**去掉 runtime 中间层**，改由 service 直接调用（见 3.4）。
- **实现细节**：
  1. **幂等**：以 `(project_id, source='claude', title)` 为键 upsert（`GetNoteBySourceTitle` + `UpdateNoteFull`/`CreateNoteEx`），内容未变则跳过计数为 `skipped`。
  2. **归属**：Claude 记忆按「目录所在项目」归入对应 project；无对应项目时归入「未分组/全部项目」占位项目（`project_id` 需 >0，否则计入 `skipped`）。
  3. **触发**：启动 auto-import（`auto_import` 开关保留，设置页保留该开关）＋知识库页手动按钮。
  4. **结果**：返回 `{created, updated, skipped}`，经 `import.completed` 事件 toast 展示（已实现，保留）。
  5. **验收**：`go test ./internal/importers/claude` 通过；同一目录二次导入 `skipped` 占比 100%；记忆文件变更后导入 `updated` 正确。

### 4.10 MCP server（精简为 3 个锐利工具）

- **目标**：给代理一个最小、可组合的只读接口，一次调用即拿到「该项目的上下文」。
- **现状**：6 个工具（notes_list / notes_search / notes_read / projects_list / projects_stats / ask），均复用 service，stdio 单次开库。
- **保留边界**：MCP 是唯一 AI 执行接口；**工具面收敛为 3 个**。
- **实现细节**（删除以下 3 个，重构为 3 个）：
  1. **`gitboard_search(query, limit=10)`**：替代 `notes_search` + `ask`——统一 FTS 检索，返回标题/项目/摘要/snippet，`limit` 生效（修复审查 L13）。
  2. **`gitboard_note(id)`**：读单条笔记全文（替代 `notes_read`）。
  3. **`gitboard_project(id)`**：返回项目聚合上下文——项目名/路径/技术栈/README 摘要/最近提交/该项目的笔记清单（替代 `projects_list` + `projects_stats`，真正满足「一次调用即上下文」）。
  4. **实现**：新增 `service.GetProjectContext(projectID)` 聚合端点（MCP 与未来 CLI 复用）；删除 `projects_stats` 对每日统计的依赖（已随统计砍除）。
  5. 版本号沿用 `internal/version`（已统一）；文档 `docs/features/ai-integration.md` 同步新工具表与接入命令。
  6. **验收**：`go build ./cmd/mcp` 通过；用 MCP Inspector 或 `echo` JSON-RPC 冒烟三个工具返回合法 JSON；无项目/无笔记时返回空数组而非错误。

### 4.11 llms.txt 生成

- **目标**：一页可喂给 LLM 的知识库总览，信噪比优先。
- **现状**：`GenerateLLMsTxt` 输出项目目录（技术栈/README 截断 400）+ 最近 20 条知识笔记（内容截断 1000）。
- **保留边界**：保留为导出格式（不随仓库分发）；**重做内容结构**。
- **实现细节**：
  1. **按项目分节**：`## Project: <name>`（路径/技术栈/README 摘要/最近提交 5 条）→ 每项目下 `### Notes`（置顶 + 最近更新优先，每项目 ≤10 条）。
  2. **截断规则**：README 400 字符、笔记 800 字符、统一 `\n\n...` 结尾；总量设上限（约 40KB）防超窗口。
  3. **排序**：项目按活跃度（最近提交时间）降序，活跃项目在前。
  4. **验收**：`go build ./...` 通过；生成结果可解析为合法 Markdown 且不含空节；对空库输出明确的空态说明。

### 4.12 笔记导出 .md

- **目标**：任意笔记可带 YAML frontmatter 导出为独立 `.md`。
- **现状**：`ExportNoteAsMarkdown` 输出 `title/tags/kind/project/source/updated_at` frontmatter + content。
- **保留边界**：全保留。
- **实现细节**：
  1. frontmatter 字段用 `%q` 转义（已实现），内容原样输出。
  2. 前端「复制为 Markdown」按钮保留（`navigator.clipboard.writeText` + toast）。
  3. **验收**：导出文本可直接被 Obsidian/任意 Markdown 工具读取；含引号/换行的标题不破坏 YAML。

### 4.13 i18n / 主题 / 单文件跨平台（架构保留项）

- **目标**：zh/en 双语与深浅主题不回归；单二进制零依赖。
- **实现细节**：
  1. i18n：砍除功能对应的 locale key 同步删除（dashboard/todos/plugins 相关）；`docs` 生成脚本仍用 `web/node_modules` 的 marked（记录到 TODO，不阻断）。
  2. 主题：`data-theme` CSS 变量 + 系统跟随保留。
  3. 安全头与 `spaFallback`（main.go）保留；CSP 中 `script-src 'unsafe-inline'` 的 PWA 注释更新为无 PWA。
  4. **验收**：`cd web && npm run build && npm test` 通过；`go build ./...` 通过。

---

## 5. 优化项

### 5.1 产品优化（最小新增集）

1. **一次性 onboarding（首启闭环）**：首启播种扫描根后：自动扫描 → 自动挖掘第一个项目 → 提示「导入 Claude 记忆 or 写第一条笔记」→ 一次点击完成闭环。这是「零配置信任」标准的直接落地。
2. **MCP 可发现性**：设置页显示 MCP 接入状态（二进制路径 + 一行 `claude mcp add` 命令 + 复制按钮）；MCP 工具返回 `schema_version` 便于客户端校验。
3. **llms.txt 自动维护**：每次笔记变更后台重生成并缓存，AI 出口永远新鲜（配合 4.11）。
4. **项目上下文预热**：扫描完成后在后台批量挖掘新仓库 `repo_meta`（替代「首次打开才挖」），首个详情页即 `cached=true`。

### 5.2 工程优化

5. **接入 `useApiData`**：知识库/项目详情/命令面板统一走 TTL 缓存 + 请求去重（TODO.md 中优先项），消除三处重复拉取。
6. **移除死代码**：砍除落地后执行 `go vet` + `grep` 清点残留引用（`ToggleStar`、`GetStatusBar`、todos 绑定、`seo.ts` OG 函数）；删除 `docs/api/`、`docs/plugins/`、`examples/plugins/`。
7. **错误恢复收尾**：Knowledge 页搜索失败静默（`catch` 置 `[]`）改为 ErrorBanner 可重试；扫描失败已有 toast，补「重试」动作。
8. **测试补强**：`hooks/useApiData`、`useDebouncedCallback`、`api/endpoints` vitest（TODO.md）；MCP 三工具加 JSON-RPC 冒烟脚本（`scripts/legacy` 之外新建 `scripts/smoke-mcp.sh`）。
9. **FTS 运维**：记录 `project_notes_fts` 体积随笔记增长（trigram 索引约 2–3× 正文），在设置页显示知识库体积与「重建索引」动作。

### 5.3 治理优化

10. **门禁强化**：ADR-0006 的五环节门禁从「原则」升级为「PR 检查项」——新功能 PR 描述必须标注归属环节，无归属的合并不通过；在 `.github/PULL_REQUEST_TEMPLATE` 中落地。
11. **README/文档口径**：README 功能表、`docs/index.md`、`docs/getting-started.md` 按本文件 0 节速览表重排；`positioning-brief.md` 的「统一对外口径」加入本文件的定位句。

---

## 6. 执行顺序建议

1. **Phase 1（后端砍除）**：统计/待办/插件/agent-score/手动分组 的 Go 代码与绑定移除，迁移 v11 冻结数据，`go build ./...` + `go test ./...` 全绿。
2. **Phase 2（前端砍除）**：Dashboard 与相关组件/路由/locale 移除，块编辑器降级，`npm run build` + `npm test` 全绿。
3. **Phase 3（AI 出口重做）**：MCP 3 工具 + `GetProjectContext` + llms.txt 重做 + 冒烟脚本。
4. **Phase 4（优化项）**：5.1/5.2 按依赖顺序落地。
5. **Phase 5（文档与治理）**：README / docs / 模板 / PR 门禁同步。
