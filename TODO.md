# TODO — 待办清单

> 本文件只保留**未完成**事项与现状速查。查阅顺序：完成明细见 [CHANGELOG.md](CHANGELOG.md)；设计决策见 [docs/adr/index.md](docs/adr/index.md)；过程报告见 [outputs/](outputs/)；本文件的历史全文（含每项实施细节与教训）见压缩前快照：`git show 167c062:TODO.md`。
> 惯例：事项完成后从本清单移除并写入 CHANGELOG；设计类工作先落 ADR。

## 现状速查（新会话从这里开始）

- 品牌 **Repotory**（原 RepoNest），版本 **v2.9.1**（2026-10-20），SSOT 在 `wails.json`。
- schema **v26**（v26：wiki 页访问强化信号 `access_count` / `last_accessed_at` 底座，随 v2.9.1 发布；ADR-0023 笔记归属 `project_kind` 已随 v2.3.0 发布；`page_embeddings` 页面向量空间 + `page_embed_dirty` 增量队列，ADR-0018 lane 2 已落码；`evidencePages` 图感知取证 `wiki_graph_search` 默认关、零回退）；ADR-0018 lane 1（关系词表八型）已 **Accepted**（真库演练 PASS，产物 `v21-rehearse/`）。
- 近期大项均已落地：插件脚本运行时（yaegi）已移除（C11-B）、全局 CSS Modules 迁移收口（全局 1,227 行）、D25 首屏经 **ADR-0024** 演进为**首页工作台**——单栏融合仪表盘 + 记忆环条（`web/src/pages/Home.tsx`），全局搜索独立为 `/search` 顶级页（空闲态含热门项目 / 热门标签推荐，`web/src/pages/Search.tsx`），`/dashboard` 重定向到 `/`，导航以「搜索」取代「仪表盘」。
- **真库事故（2026-10-14）已完全恢复并归档**：恢复过程、48 条笔记重导找回与 TM/快照双点验证见归档 [outputs/process-logs/2026-10-14-事故恢复与备份验证归档.md](outputs/process-logs/2026-10-14-事故恢复与备份验证归档.md)。内置每日本地快照（ADR-0025 L1）与 S3 远端推送（L2）均已落码。

---

## 当前待办

### M7 Lane 2：页面向量空间 + 图感知取证（schema v23）→ [ADR-0018](docs/adr/0018-knowledge-graph-foundation.md) 第二半 —— **代码已全部落码（2026-10-14）；Phase 0 两门已于 2026-10-15 过门，lane 2 晋升现挂 [ADR-0018](docs/adr/0018-knowledge-graph-foundation.md) 条件 10 的强化门槛**

- [x] `page_embeddings`（vec0，仅 approved 页）：物理独立于 `note_embeddings` + `page_embed_dirty` 触发器队列 + `memsrc` 无关的专用 `db.Page*` 助手；门控挂既有 `semantic_search` 之后；`vectorStore()` memo 失效路径对页面配置同样生效。回归：`pagevec_test.go` / `page_embed_dirty_test.go` / `page_embed_drain_test.go`
- [x] `evidencePages` 读图：`WITH RECURSIVE` 沿白名单（`ref`/`part-of`/`documents`，不沿 `contradicts`）1 跳扩召回 + 纯 Go PPR 替 bm25 定序；notes 与 pages 按类型分列交织；新门 `wiki_graph_search` 默认关，关时零行为回退（`TestEvidencePages_GraphOffIsFTSPure` 钉住逐条一致）
- [x] **Phase 0（当时的唯一硬门）—— 两门均已 GATE PASS（2026-10-15，随 v2.2.0 发布）**：真实标注 query 集 + `abeval` delta 全部量出。脚手架：`cmd/queryset`（`-seed` 导出带行号工作表 / `-emit` 解析回 `queries.jsonl`）。**M3 门**：`.annotation-prep/notes.labeled.tsv`（51 条人工 query，覆盖 51 个 note id）→ k=3/5/10/20/50 全区间 PASS，k=10 时 lexical 0.608 / hybrid 0.735 / delta **+0.127**。**M7 lane 2 evidence 门**：`.annotation-prep/evidence-cases.jsonl`（16 条人工 query，标注 `page` 类型 id）→ k=2..20 全区间为正，k=10 时 FTS 0.719 / graph 0.812 / delta **+0.094**，逐案诊断确认 4 例增益全部形如「命中 page6 → 沿边带出 page7」、无一例回退。embedding 走 LM Studio `localhost:1234`（`text-embedding-nomic-embed-text-v1.5`, dim=768），跑门脚本 `.annotation-prep/run-gate.sh` / `run-evidence-gate.sh`（复制真库注入配置，不动 live、不改用户 `semantic_search`），逐案诊断 `cmd/abevaldiag`（两模式）。过程中修了 `internal/db/search.go` 的 CJK 词法不可达（`escapeFTSOR` 单段中文整句零召回 + LIKE 整句单子串匹配）与 `updated_at=''` 触发 `julianday` NULL 导致整条查询归零——修前 delta +0.338 里约六成是「CJK 词法坏了」的假信号，修后 +0.127 才是语义检索的真实增益。另修 `abevaldiag` 两臂开关时序（写在闭包外致两臂同值、delta 恒 0）。**两门的强度限定**：M3 的 delta 真实但幅度小；evidence 门的 delta 是在稀疏图（7 页 2 边）上的下限，不能外推为「图感知普遍优于 FTS」——要真正兑现 lane 2，需先让编译产出更多页与边再复跑。**门已过**；当时悬着的两项决策也都有了结论——M3 默认值经 2026-10-18 拍板**保持默认关**（授权面理由与前向约束见 [ADR-0012](docs/adr/0012-semantic-search.md) 末节），lane 2 晋升门槛同日**强化为条件 10**（[ADR-0018](docs/adr/0018-knowledge-graph-foundation.md)）。所以现在欠的不是决策而是**密度兑现**，见「用户动作」的图密度欠账条


### 后续路线（草案已成文，按序触发，各自待批准）

- 实施计划总览：[outputs/process-logs/Repotory-知识图谱实施计划-2026-10-09.md](outputs/process-logs/Repotory-知识图谱实施计划-2026-10-09.md)（Phase 1-4）

### 用户动作 / 外部依赖

- [x] **真库事故收尾（2026-10-14）**：已完全闭环并归档至 [outputs/process-logs/2026-10-14-事故恢复与备份验证归档.md](outputs/process-logs/2026-10-14-事故恢复与备份验证归档.md)。源重导找回 48 条（笔记总数 107）、本地每日本地快照（L1）与 S3 远端推送（L2）均已交付。
- [ ] **桌面 GUI 真机冒烟**：扫描→收藏→刷新历史→笔记 CRUD→版本恢复→知识库搜索→MCP 问答，并覆盖本轮新增的合并建议区 / 社区摘要 / 页面版本历史三块界面。（D25 的 ≤1080px 断点已实测修复——记忆环塌陷、搜索框与 handoff 列表被仪表盘遮盖；ADR-0017 已据此晋升 Accepted）（**进展 2026-10-19**：v2.7.0 wails build 通过、新包已真机启动——schema v25 真机迁移完成、污染 repo_meta 清零；交互清单待用户按序核验，新增「向上合并确认弹窗」「按仓库拆分」两项）
- [ ] **Hermes sessions 真机核验 — state.db 链路已跑通（2026-10-20），剩设置页点源一眼**：Hermes Agent v0.22.2 已按官方 install.sh 装上本机（HTTPS 克隆超时 → `HERMES_REPO_URL` 走 SSH 源），配 LM Studio（`model.provider=lmstudio`，bonsai-27b）跑通 `hermes chat --oneshot` 产出真 `~/.hermes/state.db`（WAL、274KB，`source='oneshot'`）；官方 `session-storage.md` 与导入器读取列逐一致（schema 证据由 Tencent 侧证升级为官方文档 + 真机数据）。沙箱库 + 真数据实测：探活 detected ✓（state.db 单独判活）、首导 created=1、复跑幂等 updated=1、memories/ 缺失优雅 no-op、笔记落「未分类」（hermes_project 未设的既定语义）。**剩**：设置页点源验证（v2.8.0 桌面包重启后点一下）；curated memories 半边仍空（`~/.hermes/memories/` 待真实使用产生 MEMORY.md/USER.md）
- [ ] **OMP 导入向**（等 OMP v1 稳定）；Bleve（是否替代 FTS5：**先离线 A/B 度量再决策**，abeval 同标注集加 Bleve 臂，recall@10 ≥ +0.05 才立项）、Pinecone/Milvus（`vectordb` registry 纯加法，Milvus 自托管先于 Pinecone 云端；**触发条件未满足，暂不写适配器**）——三项的完整评估与触发后做法见 [检索与向量后端架构评估 2026-10-19](outputs/process-logs/Repotory-检索与向量后端架构评估-2026-10-19.md)：结论 = 「可选配置代替替换」在向量层成立且已是既成架构，在文本检索层先度量再定，OMP 是协议版本问题非后端选择
- [ ] **图密度欠账（lane 2 兑现前置，即 [ADR-0018](docs/adr/0018-knowledge-graph-foundation.md) 条件 10 的门槛 ①）**：目标 **approved 页 ≥ 15、边 ≥ 20**（当前 **7 approved / 18 边（approved↔approved 3 条）/ 11 pending / 8 rejected**）；达标后才谈得上复跑 evidence 门（`cmd/abeval -mode evidence`）。
  - **进展 2026-10-18**：两轮限时编译 + 人审（批 2 拒 1）4→6 页、1→5 边；结构性瓶颈——日志类笔记出页率 ~0.2 页/条（BookStore 50 / investment-dashboard 5 全为 log），knowledge 类 1→2 页 + 3 边。
  - **进展 2026-10-20（路线①执行完毕 + 人审完成）**：BookStore **50/50 条全部编译覆盖**（7 个有效轮次 × 8 条，job 6–12，全程零错误；LM Studio bonsai-27b）；产出率实测 ~0.27 页/条（48 条 → 13 页）。**人审 12 张 pending（用户授权代审，逐页对照来源笔记）**：批准 2（20 书单筛选比例化规则、22 结构探索——全库仅有的实质 concept），拒绝 10（16/19 Gemini 会话日志复述对、18/21/27 CodeBuddy 导入包装、17/24/25 source 纯出处包装、23 无发现的事件页、26 通用定义填充——与 10-19 拒 13/14 同一标准，不注水凑门槛）。密度实测：**9 approved / 19 边（approved↔approved 4）/ 0 pending / 18 rejected——未达门槛（15/20），evidence 门复跑继续悬置**。
  - **结构性结论（诚实记录）**：会话日志类笔记的诚实产出率撑不起门槛——48 条日志编译出 13 页，其中经得起人审的实质页只有 ~2-4 张。门槛的兑现路径只剩**内容富集**：真实使用产生 knowledge 类笔记（历史实测 1→2 页 + 3 边），或编译其他项目的 knowledge 类存量（如有）。
  - **策略（2026-10-18 用户拍板路线①）**：BookStore 50 条日志挂机分轮编译（每轮 8 条、后台循环），跑完后人审 pending 页再复测密度；内容富集型笔记随使用积累是长期主路径。**路线①已按此闭环。**
- [ ] **JetBrains 插件**：缓议，待真实需求信号（issue/star）+ 补 ADR 后立项

---

## 已完成

Sprint 1-14 与 M1-M7 Lane 1 全部落地（D1-D24、C1-C15、P3-P38、M6 W0-W5、品牌更名 v2.0.0、D25 首屏）。2026-10-13 另落地：M7 后续三份 ADR（0019/0020/0021）、D25 三项残留收口、工作区路径四阶解析与消费面契约统一、扩展版本跟随应用版本、分析类工具改走一次性副本。2026-10-14：Phase 0 前半（批页 7/7、integrity 复验通过、标注工作表导出）与真库损坏恢复（`.recover` 重建换入，见现状速查事故条目）。
明细与结论按版本见 [CHANGELOG.md](CHANGELOG.md)；单项实施细节、踩坑与教训见压缩前快照 `git show 167c062:TODO.md`；架构决策见 [docs/adr/index.md](docs/adr/index.md)。
