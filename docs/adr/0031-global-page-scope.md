# ADR-0031: 全局页作用域——给跨项目画像层一个能被人填实的入口

- 状态：Accepted（**2026-10-26 落码 + 真库副本演练通过**。db 层 `SetWikiPageScope`；service 层 `PromoteWikiPageToGlobal` / `AssignWikiPageProject` / `ListApprovedWikiPages`；审核页新增「页面作用域」区；三个绑定登记进 `bindingSurfaces` 并全部 desktop-only）
- 日期：2026-10-26
- 关联：[ADR-0014](0014-llm-wiki-knowledge-compiler.md)（知识编译层——页面从哪来）、[ADR-0015](0015-w3-minimal-compile-loop.md)（**本 ADR 的红线来源**：人批准才进检索）、[ADR-0019](0019-entity-resolution-merge.md)（同族形态：合并永远由人触发）、[ADR-0006](0006-scope-freeze.md)（范围冻结——本 ADR 不扩产品边界）、[ADR-0030](0030-ai-call-audit.md)（同期「信任面」论证风格）
- 起点 schema：v28（**本 ADR 无 schema 变更**——全局页复用 `wiki_pages.project_id` 已有的 NULL 语义）

## 背景

### 事实一：L3 结构性恒空

`repotory_context` 的记忆栈分四层：L3 跨项目画像 / L2 项目场景 / L1 精选笔记 / L0 原始记录。L3 的取页条件在 `internal/service/context_layers.go:216`：

```go
if p.ProjectID != 0 || p.Status != db.WikiStatusApproved {
    continue
}
```

而**所有建页入口都强制带 projectID**：编译器（`wiki_compile.go`）、社区摘要（`wiki_community.go`）、答案归档（`FileAnswerAsPage`）、手写页（`CreateWikiPage`）。没有任何一条路径能造出 `project_id = 0` 的页。

live 库实测（2026-10-26，只读查询）：45 张 wiki 页，**全局页 0 张**（approved 27 / rejected 18）。也就是说 L3 从写下来那天起就一直空着——**不是「数据不够」，是「结构上不可能有」**。这一层写的是"这个人跨项目是什么样的"，却永远只能回答"没有"。

### 事实二：schema 本来就预留了全局页

`internal/db/wiki.go` 的设计注释第 1 条写着 *"project_id is nullable (a page may span projects)"*；`CreateWikiPageAs` 的写入形态本来就是 `var pid any; if projectID > 0 { pid = projectID }`——传 0 时落的是 SQL **NULL**。`internal/db/wiki_merge.go:103-105` 更进一步写着 *"A global page (project_id 0) may take either role"*：**跨项目合并本就把全局页当作可接受的一方**，缺的只是创建入口。

### 事实三：取证路径早就把全局页当作「对所有项目可见」

`internal/service/wiki_evidence.go:300`：

```go
if projectID > 0 && p.ProjectID != 0 && p.ProjectID != projectID {
    continue // another project's page: correct to skip, not to hide
}
```

`p.ProjectID != 0` 这一支说明：**`project_id = 0` 的页对每个项目都可见**。所以"提升为全局页"是**扩权**（一个项目独占的页 → 所有项目可见），不是搬家。这让收益与风险同时清晰：收益是 L3 终于有内容、跨项目画像成立；风险是**一页错判的知识从此影响所有项目的回答**——所以它必须是人点的。

## 决策

**1. L3 不做自动兜底——只给人类一个「提升为全局页」的动作。**

被否的方案是"每次编译顺带产出一张跨项目摘要"。它违反 ADR-0015 的原文（`context_layers.go:29-33` 引的那句）：

> Producing L3 automatically is exactly the "model writes into the store with no gate" ADR-0015 refuses.

自动产出的 L3 = 模型直接写进记忆层且无人审，与 ADR-0015 拒绝的是同一件事。**本 ADR 明确不做它，也不为它预留任何代码路径。**

**2. 全局页 = 已批准页把 `project_id` 置空；只有已批准的页能改作用域。**

- db 层 `SetWikiPageScope(db, id, projectID)`：`projectID == 0` → `project_id = NULL`。
- **为什么是 NULL 而不是字面量 0**：`wiki_pages.project_id` 带 `FOREIGN KEY ... REFERENCES projects(id)`，而库以 `PRAGMA foreign_keys=ON` 打开（`internal/db/db.go:37`），`projects` 表里没有 id = 0 的行 → 写 0 会被外键直接拒绝。`CreateWikiPageAs` 早就是用 NULL 表达全局页的，本 ADR 沿用同一写法，并由一条测试钉死这个事实（`TestSetWikiPageScope_LiteralZeroIsRejectedByTheForeignKey`：若哪天外键不再生效，这条测试会红）。
- **只有 approved 能改**：pending 页若被提升，它在**所有项目范围的审核队列里都不可见**（待审/错误页的查询按 `project_id` 过滤），于是变成一张没人能批准的孤儿页；rejected 页是墓碑，更不该说话。所以作用域变更的前置条件是"已发布"。

**3. 作用域变更不碰 status / content / source，也不碰 `updated_at`。**

- 不碰 status/content/source：作用域说的是"这一页可以在哪里说话"，不是"这一页说了什么"。批准仍是 ADR-0015 那一次独立的、不可被顺带撤销的人工作业。
- 不碰 `updated_at`：lint 的过期检查把 `updated_at` 当作"两个冲突页里哪个是较新的论断"。改一次作用域让陈旧知识看起来新鲜，是用可见性操作污染了新鲜度语义。
- 连带事实：`page_versions` 的快照触发器只在 status/title/content/kind 变化时触发（`internal/db/wiki_versions.go:118-126`），所以**作用域变更不产生版本快照**——历史里留的是"人批过什么内容"，不是"这页归谁"。

**4. 提升是可逆的：反向动作必须显式指定目标项目。**

页一旦提升，原项目在行里就不可知了（`project_id` 已是 NULL），所以"移回项目"由人点名项目：`AssignWikiPageProject(pageID, projectID)`。**单向棘轮不是功能。**

**5. 作用域不改变取证的项目过滤语义；项目级清单仍按项目过滤。**

已批准页一旦进入全局层，就不再出现在原项目的 lint / export / 编译词表 / 合并候选里（这些查询都是 `project_id = ?`）。这是"归属"的语义：全局页不属于任何项目。**取证路径相反**——它本来就对所有项目可见（事实三）。这个不对称是既有代码的事实，本 ADR 不改（改它要动 8 个调用点，属于另一次决策）。

**6. 审核页新增「页面作用域」区；提升用两击确认。**

- 位置：审核页——人和模型产物打交道的唯一界面，与待审/错误页同页。
- 形态：**不是审核卡片**。作用域变更不是判决，所以没有正文、没有来源笔记、没有版本历史，只有"这一页是谁、在哪里说话、从这里能做什么"。
- 提升按钮**两击**（与同页"采纳合并"同一形态）：它改变的是此后**所有项目**每一次回答的方向，一次误点不该算数。
- 移回需要在下拉里点名项目；未选时按钮禁用并说明原因。
- 全局页只在"全部项目"视图里出现（它不属于任何项目），与既有过滤语义一致。

**7. 三个绑定都是 desktop-only，没有 MCP 孪生。**

`ListApprovedWikiPages` / `PromoteWikiPageToGlobal` / `AssignWikiPageProject` 全部登记进 `internal/app/surface.go` 的 `bindingSurfaces` 并标 `SurfaceDesktopOnly` + 理由；后两个同时进 `surface_test.go` 的人闸门清单（`TestBindingSurfaceHumanGateHolds`）。理由与 ADR-0019 的合并同源：**一个能替用户决定"这页替我说话"的能力，不该由 agent 调用。**

## 候选矩阵（这个空层怎么填）

| 方案 | 价值 | 主要风险 | 判定 |
|---|---|---|---|
| **人点一次「提升为全局页」**（本决策） | L3 有内容；跨项目画像成立；改动面最小（无 schema 变更） | 依赖人愿意去点；L3 内容质量取决于人 | **采纳** |
| 改成跨项目自动摘要 | 零维护，L3 永远有内容 | 直接违反 ADR-0015 红线（模型无人审写入记忆层） | 否决 |
| 加 `is_global` 列，两层并存 | 项目内仍能看见这页 | schema v29 + 迁移 + 两套过滤语义；把"归属"变成两个互相矛盾的维度 | 否决（范围外） |
| 让编译器/社区摘要顺手产出全局页 | 自动 | 同第二条，且模型在替人决定"这页代表我" | 否决 |
| 什么都不做 | 零风险 | L3 继续恒空；跨项目画像这条产品线没有落点 | 否决 |

## 后果

**正面**：

- L3 从"结构上恒空"变成"人点一下就有内容"：`repotory_context` 的跨项目画像第一次可能说话。
- 全局页对所有项目的取证可见——一条通用约定不必在每个项目里各写一遍。
- 提升可逆，且每次动作留日志行（`wiki: page N (slug) promoted from project M to the global tier`）。
- 无 schema 变更：不加列、不改版本、不动迁移链，ADR-0021 的可逆性契约不受影响。

**负面（不粉饰）**：

- **L3 的质量取决于人。** 全局层不是模型总结，是人挑的页。没人提升，L3 仍然是空的——这是本 ADR 接受的结果（自动填实被 ADR-0015 否决）。
- **提升是"扩权"。** 一页错判的知识从此影响所有项目的回答。两击确认 + 只允许 approved 页进入，是这里仅有的两道闸；**没有第三道自动闸**。
- **页面离开原项目的项目级清单**（lint / export / 编译词表 / 合并候选）。取证不受影响（事实三），但"这个项目里有哪些页"会少一张；移回即可恢复。
- **不产生版本快照**（决策 3），所以"这页曾经是全局页"在 `page_versions` 里查不到——历史只记内容。要审计作用域变更，查 Git 与日志行。
- 审核页的已批准列表**没有分页**：前端截到 100 行并如实写明总数（`review.scopeTruncated`）。

## 实现修正（落码与设计不同的事实）

1. **全局页在库里是 NULL，Go 侧读到的是 0。** `pageColumns` 用 `COALESCE(project_id, 0)` 投影，所以前端拿到的 `project_id = 0` 即"全局"。这与 TODO 里"把 `project_id` 置 0"的措辞一致，但**底层存的是 NULL**——写 0 会被外键拒绝。
2. **反向动作需要人点名项目，不是"回到原项目"。** 原项目在提升后已不可知（`project_id` 是 NULL），所以 UI 给一个项目下拉；这也顺带回答了"提升错了，该归到哪个项目"。
3. **作用域区只在有已批准页时出现。** 没有已批准页就没有可提升的东西，一节关于无人能做的动作的界面是噪音。
4. **提升按钮用两击确认，移回不用。** 提升改变所有项目此后每一次回答的方向；移回是恢复，两者不同量级。

## 验证

- **真库副本演练（2026-10-26）**：对 live 库的 `.backup` 副本跑真实 service 路径（live 文件全程只读、未被写入）。演练页 `id=1 slug=cbipay project=25`（approved）：**L3 条目 0 → 1**，原始列 `project_id IS NULL` = 1，**按 slug 检索仍命中该页**（3 个命中中含它），**移回项目后 L3 回到 0**。演练脚本已删除，副本已清理。
- **Go 回归**：`internal/db/wiki_scope_test.go` 5 例（NULL 存储 / 外键拒绝字面量 0 / 往返 / 未知项目 / 缺页）、`internal/service/wiki_scope_test.go` 8 例（L3 填实 / 仍可检索 / 跨项目可见性 / 拒绝未批准 / 幂等 / 可逆 / 坏目标 / 缺页）。`go test ./...` 37 包全绿。
- **前端回归**：`Review.test.tsx` 新增 4 例（作用域标签 / 两击确认 / 移回点名项目 / 无内容不渲染）。`npm test` 34 文件 246 例全绿；`npx tsc --noEmit` 与 `npm run lint` 均通过。

## 不做什么（明确留白）

- 不做自动全局摘要（ADR-0015 红线，决策 1）。
- 不给全局页单独的浏览页/路由——属 TODO Sprint 1.1 的 `/wiki` 浏览面（另一次决策）。
- 不改项目级清单的过滤语义（决策 5）。
- 不做 MCP 工具（决策 7）。
- 不把作用域变更写进 `page_versions`（决策 3）。
