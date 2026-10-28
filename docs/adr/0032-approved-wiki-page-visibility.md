# ADR-0032: 已批准知识页可见化——让「人批过的东西」重新被人看见

- 状态：Accepted（**2026-10-28 落稿 + 落码，同日经用户批准晋升**。实施与验证结果见文末「实现修正」与「验证记录」两节）
- 日期：2026-10-28
- 关联：[ADR-0014](0014-llm-wiki-knowledge-compiler.md)（知识编译层——页面从哪来）、[ADR-0015](0015-w3-minimal-compile-loop.md)（**闸门在写侧**：人批准才进检索）、[ADR-0021](0021-temporal-graph-page-versions.md)（页面修订流——本 ADR 只读，不碰修订）、[ADR-0031](0031-global-page-scope.md)（全局页作用域——**它把浏览页明确留给本 ADR**）、[ADR-0009](0009-ide-presence.md)（薄客户端分发纪律）、[ADR-0027](0027-jetbrains-plugin.md)（第二个 IDE 分发面）、[ADR-0006](0006-scope-freeze.md)（范围冻结——本 ADR 不扩产品边界）
- 起点 schema：v28（**本 ADR 无 schema 变更**）

## 背景

### 事实一：27 张已批准页，对人完全不可见

live 库只读实测（2026-10-28）：

```
status counts:      approved 27 / rejected 18
global pages:       0        （project_id IS NULL）
approved kinds:     concept 16 / synthesis 10 / entity 1
page_links:         55
approved 且 access_count > 0:  6
```

而 `web/src` 里渲染页面正文的地方只有两处，都在审核页：`web/src/pages/Review.tsx:721`（待审队列的正文）与 `:720`（错误页墓碑的一行摘要）。**已批准页的正文，没有任何一处渲染它。** 路由表（`web/src/App.tsx`）没有 wiki 条目，主导航没有入口，`/knowledge` 与 `/review` 不接受页面参数。

### 事实二：批准闸门的收益，只落到了「答案的脚料」上

ADR-0015 的闸门是**写侧**的：编译产物先落 pending，人批准后才进检索。27 张 approved 页就是这道闸门的产物——它们已经过了闸，是「人说过可以」的知识。

但过闸之后，它们唯一的去处是 AI 取证：`access_count` / `last_accessed_at`（schema v26）的**唯一写入点**是 `internal/service/wiki_evidence.go:204` 的 `db.TouchWikiPages`，即「这一页被塞进了某次回答的证据块」。27 张里只有 6 张 `access_count > 0`，因为只有 6 张被 AI 取证碰到过。

于是形成了一个闭环：**人花力气批准 → 页进入检索 → 页只作为 LLM 的脚料被消耗 → 人自己永远读不到它。** 闸门本身是对的（ADR-0015 的论证仍然成立），但它把「发布」定义成了「可以被引用」，而**没有被定义成「可以被读」**。本 ADR 补的是后一半。

### 事实三：db 层早就能搜，service/app 层从未暴露

`internal/db/wiki_fts.go:91` 的 `SearchWikiPages` 早就写好了：approved-only（`p.status = 'approved'`）、bm25 排序（title 权重 3.0 / content 1.0）、CJK 多词 OR 松弛回退。ADR-0014 W2 的注释里那句「**W2 is that consumer**」指的就是这个函数——而消费者一直没来。

全仓非测试调用点只有一处：`internal/service/wiki_evidence.go:271`，在取证路径内部。`SearchAll` 只覆盖 notes + todos，所以 `repotory_notes_search`、`/api/search?all=1`、桌面端知识库搜索、VS Code 侧边栏、JetBrains 工具窗——**五个产品入口，一个都搜不到知识页**。

### 事实四：ADR-0031 把浏览页明确留给本 ADR

[ADR-0031](0031-global-page-scope.md) 的「不做」清单里写着：「不给全局页单独的浏览页/路由——属 TODO Sprint 1.1 的 `/wiki` 浏览面（另一次决策）」。全局页是「人挑的、跨项目说话的知识」；没有浏览页，它就只能在 L3 层里当脚料。

## 决策

**1. 已批准页对人可读：新增 `/wiki` 浏览面 + `/wiki/:id` 详情路由。**

- 浏览面 = 已批准页的列表 + 检索（空检索词时按更新时间倒序列出，有检索词时按 bm25 排）。
- 详情路由渲染该页正文（Markdown，走既有消毒链）、元信息（kind / slug / 作用域 / 更新时间）与来源笔记。
- **只列 approved。** pending 与 rejected 仍然只在审核页出现——那才是闸门所在的位置；把它们复制到第二个界面只会让人分不清「该审的」和「已发布的」。

**2. 只读。本 ADR 不提供编辑已批准页的入口。**

改已批准内容会立刻撞上 ADR-0021 的修订语义（`page_versions` 快照、谁改的、改了什么）。那条流要单独决策，本 ADR 明确不碰——**一个只读的可见化不会稀释审批的分量**：人批准的是「这句话是对的」，不是「这句话以后不许改」。

**3. 检索复用 `db.SearchWikiPages` 的既有语义，只加一层作用域过滤。**

- approved-only + bm25 + CJK 松弛回退：**不改**，避免出现第二套「页的检索」语义。
- 作用域语义与取证路径**完全一致**（`wiki_evidence.go:300`）：选项目 = 「该项目的页 + 全局页（`project_id IS NULL`）」；不选 = 全部。
- 实现上把过滤下推到 SQL（`project_id = ? OR project_id IS NULL`），**不在 Go 侧过滤**——Go 侧过滤会让别的项目的页先占掉 limit，本项目的页反而被挤掉。

**4. 人浏览不写 `access_count`。**

schema v26 的注释写死了这个字段的含义：「how often a page has been **USED (surfaced into an answer's evidence)**」。人打开一页是另一种访问；混进去会让这个信号同时表示「被答案用过」和「被人读过」，而未来若有排序/衰减策略依赖它，两种含义会被当成一种。**保持信号单一，代价是浏览不产生强化。**

**5. MCP 孪生：`repotory_wiki_search` + `repotory_wiki_read`。**

两个都是 `SurfaceMCPBacked`。理由与 `repotory_notes_read` 同源：**读一张已经过闸的页是纯读操作，闸门在写侧。**（与 ADR-0031 的三个作用域绑定不同——那三个是「替用户决定这页替我说话」的人工作业，性质完全不同。）

**6. 两个 IDE 分发面都消费它。**

VS Code 侧边栏与 JetBrains 工具窗都能检索并打开已批准页。**薄客户端纪律不变**：插件自己写 FTS 查询就是复制检索逻辑（ADR-0009 / ADR-0027 反复写过这条），所以两边都只调绑定——VS Code 走 MCP 工具，JetBrains 走 `/api/rpc` 桥。

**7. `/wiki` 进入主导航。**

不可见的知识等于没有知识。27 张页已经躺在库里两年（编译链从 2026-10-14 第一次出页算起），再塞进一个没人找得到的角落没有意义。

## 候选矩阵（已批准页怎么给人看）

| 方案 | 价值 | 主要代价 | 判定 |
|---|---|---|---|
| **独立 `/wiki` 浏览面 + 详情路由**（本决策） | 页有地址、可深链、可被 IDE 打开；与审核页职责分开 | 多一个顶级页面 | **采纳** |
| 并进 `/knowledge` 知识库页 | 不多一个导航项 | 知识库页的主语是「笔记」，页是另一个物种；两者筛选维度不同（kind vs 标签/主题），塞在一起两边都变难用 | 否决 |
| 只在审核页加一个「已批准」标签页 | 改动最小 | 把「读」放在「审」的界面里，等于暗示读之前要先审；且已批准页会被待审队列的数量感淹没 | 否决 |
| 让 `SearchAll` 把页并进笔记搜索结果 | 一个搜索框解决所有 | 页与笔记的 id 空间都自增（id 1 两边都有），混排会撞 id——本仓已经为笔记/待办踩过一次这个坑（`TestSearchAllKeepsNoteAndTodoIDSpacesApart`）；且页与笔记的「命中」不是一回事 | 否决 |
| 人审完自动发布到某个外部 wiki | 传播更广 | 突破「本地私有」承诺（ADR-0030 的硬约束），且超出范围冻结 | 否决 |

## 后果

**正面**：

- 27 张已批准页第一次对人可见，闸门的收益不再只有 LLM 一头。
- 页有了稳定地址（`/wiki/:id`），可以深链、可以写进 handoff、可以被 IDE 打开。
- IDE 分发面（VS Code / JetBrains）与桌面端共用同一套检索语义，不会各说各话。
- 无 schema 变更：不加列、不改版本、不动迁移链。

**负面（不粉饰）**：

- **浏览不产生强化**（决策 4），所以 `access_count` 仍然只反映「被答案用过」。
- **只读**（决策 2）：人看到页里有错字，改不了。要改得走 ADR-0021 的修订流——这是本 ADR 接受的后续欠账，不假装它不存在。
- **多一个顶级页面**。导航栏已有 6 项，再加一项是真实的注意力成本；这是采纳独立浏览面的代价，靠「页不可见」这个更坏的代价抵消。
- **项目作用域是语义上的，不是物理隔离**：选了项目 A，`/wiki` 里仍会出现全局页（ADR-0031 的扩权结果）。界面上必须写清「全局」标签，否则「项目内检索」看起来像漏了过滤。

## 实现修正（落码与设计不同的事实）

1. **`db.SearchWikiPages` 加了 `projectID` 参数，而不是新增一个并列函数。** 原来的签名是 `(db, query, limit)`；作用域过滤若另起一个函数，approved-only / bm25 权重 / CJK 松弛回退这套语义就要复制一遍——复制即漂移。改签名让「页的检索」在本仓只剩一个实现。（代价：6 处测试调用点要跟着改。）
2. **`SearchWikiPagesMatch` 同样加了作用域**，因为它是严格匹配失败后的松弛回退路径——两条路径的可见集必须一致，否则「搜得到但搜不出来」的差异会随词数变化而漂移。
3. **浏览列表的空检索分支不复用 FTS**。空检索词时走的是一条独立的 approved-only 列表查询（按 `updated_at` 倒序），因为 `SearchWikiPages` 对空查询**故意返回空**（它的注释写明：调用方拿它当检索阶段，「全部」会淹掉证据预算）。
4. **补了笔记路径早就有、页检索却缺的那条 LIKE 回退。** trigram 索引存的是 3 字窗口，所以 2 字的中文检索词（「时态」）在 FTS 里**结构性地匹配不到**——页面在库里，索引里却没有那么宽的窗口。笔记路径早有 `searchNotesLike` 兜底（`internal/db/search.go:100`），页检索没有，于是真库实测：`SearchWikiPages(0, "时态")` 返回 0 条，而 `时态图` 返回 1 条——**明明存在的一页，在界面上被回答成「没有匹配的知识页」**。这是本地知识库最不该给的一种回答。补法与笔记路径同形：检索词不可用 FTS 时走 LIKE（title 命中优先于正文命中，再按 `updated_at` 倒序），多词时先整串、再按词 OR 重试。
   - **落在共享的 `db.SearchWikiPages` 里，不是浏览面的私有分支**：取证路径、浏览面、MCP 工具、两个 IDE 分发面共用同一处实现——这正是决策 3「页的检索在本仓只有一个实现」的理由。副作用是取证路径的 2 字检索词也从「零结果」变成「有结果」。
   - **回退不放宽可见性**：approved-only 与作用域过滤两条谓词在 LIKE 分支上原样保留，只有「怎么找到」变了，没有「谁能看见」的变化。测试钉住这一点。
5. **标点切段后逐段判 CJK，而不是整句判一次。** 落码后的验证撞出第二个缺口（详见文末「验证记录」第 4 节）：一句带问号的中文问句在页检索上**零命中**。根因在共享的 `expandForFTS`——它用 `isCJKRun` 判「这是不是一个 CJK 串」，而**标点不是 CJK**，于是整句被当成一个不可匹配的短语 emitting 出去，放宽路径只有一个词可 OR，索性放弃。**中文问句里标点本来就多**，这恰恰是最常见的输入形状。
   - 修法：`expandForFTS` 先按标点切段（双引号除外——它是 FTS5 的短语定界符，调用方靠双写转义），逐段再判 CJK，CJK 段展开成三元组，其余段保持原样（混合字种仍不猜边界）。
   - **落在共享的 `internal/db/search.go`，不是浏览面的私有分支**：笔记路径与页路径一起好——实测 `SearchAll` 对同一句带标点的问句也从 0 条变成有命中。
   - 严格 AND 路径没动：放宽只在严格路径零命中时才触发，所以「能用的答案不会被更宽松的结果挤掉」这条不变式保持。

## 验证

见文末「验证记录」。

## 不做什么（明确留白）

- 不做已批准页的编辑（决策 2；属 ADR-0021 的修订流）。
- 不做 pending 页的公开预览（审核页已经能看到，且那才是闸门的位置）。
- 不改 ADR-0015 的批准闸门，不改 ADR-0031 的作用域语义。
- 不给页做反向链接图 / 关系可视化（db 层有 55 条边，但可视化是另一次决策）。
- 不做跨设备同步页（范围冻结，ADR-0006）。

## 验证记录

2026-10-28 落码后的实测记录。**每一项都是跑出来的，不是推断的。**

### 1. 自动化测试

| 位置 | 用例 | 结果 |
|---|---|---|
| `internal/db`（`wiki_browse_test.go`） | 7 例：作用域只见自己与全局页 / 列表同作用域 / 作用域先于 LIMIT 生效 / 2 字中文走 LIKE 回退 / 回退不放宽可见性 / 带标点的中文问句仍命中 / 多词 OR 重试 | 全绿 |
| `internal/service`（`wiki_browse_test.go`） | 5 例：只列已批准页 / 项目作用域保留全局页 / 拒读未批准页 / **人浏览不写 `access_count`** / 详情带边与来源笔记 | 全绿 |
| `web/src/pages/Wiki.test.tsx` + `wiki/WikiDetail.test.tsx` | 13 例（8 + 5）：列表带作用域 / 输入才检索 / 项目下拉写进 URL / 深链采纳查询词 / 空库与「无匹配」分开说 / 失败不假装空 / 详情渲染 Markdown 元信息来源 / `[[wikilink]]` 变成可点链接 / 后端没批准的页拒绝渲染 | 全绿 |
| `go test ./...` | 全仓 | 通过 |

### 2. live 库只读实测（`/api/rpc`）

```
BrowseWikiPages(0, 200)        → 27 页   （= 库里 approved 的全部 27 张，一页不多一页不少）
SearchWikiPages(0, "时态", 20) →  1 命中 → id 45「ADR-0021: 时态图——page_versions快照…」
GetWikiPage(45)                → 正文 204 字；out_links 6 条；in_links 0 条；source_note_ids [202]
```

`BrowseWikiPages` 返回的 27 张与库里的 approved 数一致，说明**浏览面没有把 pending 或 rejected 漏出来**。

### 3. 分发面

- **MCP**：`tools/list` 实测 18 个工具，含 `repotory_wiki_search` / `repotory_wiki_read`；`repotory_wiki_read(45)` 返回的正文与 `/api/rpc` 的 `GetWikiPage(45)` 一致。
- **VS Code**：`tsc --noEmit` 通过（EXIT=0）。插件只调 MCP 工具，不自己写检索（薄客户端纪律）。
- **JetBrains**：本机无 Gradle，用缓存的 Kotlin 2.2.0 编译器对着缓存的 IDEA CE 2025.2 平台独立编译，**EXIT=0 / 0 error**（9 条 deprecation warning 均为既有）。CI 的 `jetbrains-plugin-test`（`gradle buildPlugin`）仍是打包门。

### 4. 验证中发现并修掉的第二个缺口：带标点的中文问句

验证 `repotory_ask` 时撞上的（详见 [ADR-0033](0033-mcp-ask-evidence-answer.md)）：一句带问号的中文问句在页检索上**零命中**。

```
SearchWikiPages(0, "时态图是什么？为什么需要它？")  → 修复前 0 条
SearchWikiPages(0, "时态图是什么")                  → 1 条
```

原因在共享层：`expandForFTS` 判「这是不是一个 CJK 串」用的是 `isCJKRun`，而**标点不是 CJK**——于是整句被当成一个不可匹配的短语 emitting 出去，放宽路径只有一个词可 OR，索性放弃。**中文问句里标点本来就多**，所以这恰恰是最常见的输入形状。修法落在共享的 `expandForFTS`（先按标点切段，逐段再判 CJK），**笔记路径与页路径一起好**：

```
SearchWikiPages(0, "时态图是什么？为什么需要它？")  → 修复后 1 条（id 45）
```

修复后重跑：`internal/db` 与 `internal/service` 全绿，`go test ./...` 通过。

### 5. 浏览器实测（headless server + 真实浏览器）

| 走查项 | 结果 |
|---|---|
| 主导航 | 新增「知识页」项，指向 `/wiki` |
| 列表页 | 渲染「27 张已批准的知识页」，每条带 kind 徽章 / 所属项目 / slug / 摘要 / 更新日期，链接到 `/wiki/:id` |
| 作用域下拉 | 选中 CBiPay 后列表从 **27 张收窄到 6 张**（与库里 CBiPay 的 6 张已批准页逐条对应），URL 同步为 `?project=25` |
| 检索 | 输入带问号的中文问句「时态图是什么？」→ 命中 **1 张**（ADR-0021），URL 同步为 `?q=…` |
| 详情页 `/wiki/45` | 渲染 kind / 项目 / slug / 标题 / 更新时间 / 来源（wiki-compile）/ 正文；「来源笔记」链到 `笔记 202`；「出链」列出 6 条指向其它页的链接 |
| 浏览器控制台 | 无报错 |

### 6. 没验证到的部分（如实记下）

- **JetBrains 插件没有真机安装**：只到「编译通过」这一级，没在 IDEA 里跑起来。图标遮罩那类问题（TODO 4.7）正是要真机才能验的。
- **`access_count` 不被浏览抬高**，这条只有单元测试守着（`TestBrowsingDoesNotCountAsAccess`），没有 live 库的长时间对照。
- **全局页的「全局」标签没在 live 上验过**：库里目前 0 张全局页（ADR-0031 的提升动作还没在 live 上用过），所以那条渲染分支只有单元测试覆盖。
