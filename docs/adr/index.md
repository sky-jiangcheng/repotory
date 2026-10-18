---
title: 架构决策（ADR）
order: 24
---

# 架构决策记录（ADR）

| 编号 | 标题 | 状态 |
|------|------|------|
| [0001](0001-plugin-platform.md) | 插件平台（M1-M4：HTTP server / RBAC / PG-ES / K8s） | Superseded（被 0002 取代） |
| [0002](0002-c-end-repositioning.md) | C 端重新定位：本地优先「代码项目第二大脑」+ 进程内插件 | Accepted |
| [0003](0003-fts5-search.md) | FTS5 trigram 全文搜索 | Accepted |
| [0004](0004-block-editor.md) | 块编辑器（产物保持纯 Markdown） | Accepted |
| [0005](0005-service-layer.md) | 服务层重构（service / app / domain 分层） | Accepted |
| [0006](0006-scope-freeze.md) | 范围冻结与功能分级（核心闭环优先） | Accepted |
| [0007](0007-session-memory-protocol.md) | 会话记忆协议（context / handoff 双工具） | Accepted |
| [0008](0008-pwa-removal.md) | PWA 移出桌面主构建（落实 ADR-0006 暂缓档） | Accepted |
| [0009](0009-ide-presence.md) | IDE 存在感——薄客户端分发策略（一键注册 → VS Code 扩展 → JetBrains 缓议） | Accepted |
| [0010](0010-session-auto-capture.md) | 会话自动捕捉——零人工参与的 Claude Code 会话交接（M1） | Accepted-in-principle（解析、按需捕获与 B 端 hook 已落地；默认关） |
| [0011](0011-multi-agent-memory-importers.md) | 多 agent 记忆源导入——可复用 importer 框架与各源可行性（M2） | Proposed |
| [0012](0012-semantic-search.md) | 语义检索评估——向量召回补 FTS5 盲区，守住零 CGO（M3） | Accepted-in-principle（真实标注 A/B 门未过，仍默认关） |
| [0013](0013-vector-database-selection.md) | 本地向量存储选型（sqlite-vec，纯 Go）与安装引导（vector-init） | Accepted |
| [0014](0014-llm-wiki-knowledge-compiler.md) | LLM Wiki 知识编译层——摄入时编译、消费时取证（M6） | Proposed（W1/W1b/W4 已落地、W2 核心与前端已落地；其晋升条件仍需真实标注 query 集，W3 见 0015） |
| [0015](0015-w3-minimal-compile-loop.md) | W3 最小编译闭环——LLM 只写 pending 页，人批准才进检索 | Accepted |
| [0016](0016-async-batch-jobs.md) | 长时批任务的异步化——提交即返回、进度可查、结果可取 | Accepted |
| [0017](0017-one-kernel-two-entry-points.md) | 一个内核、两个入口——产品分层而不分叉仓库 | **Accepted（2026-10-13）**；条件 3 措辞于晋升当日由「第一安装路径」修订为「首屏叙事里的一等入口」，安装排序仍归 ADR-0009 管 |
| [0018](0018-knowledge-graph-foundation.md) | 知识图谱底座——受控关系词表让图可查，图感知取证让图被读 | **lane 1 Accepted（2026-10-12 真库演练 PASS）**；lane 2 **已落码（schema v23，2026-10-14）：页面向量空间 + 图感知取证（`wiki_graph_search` 默认关、零回退）+ 纯 Go PPR**，晋升 Proposed 待 Phase 0 delta（唯一硬门） |
| [0019](0019-entity-resolution-merge.md) | 实体消歧与概念合并——治「概念分裂」，合并永远由人触发 | Accepted（**真库副本端到端演练 + 人审采纳已完成（2026-10-18）**。结构候选发现（四类信号 + blocking）、合并事务、模型二判→`[lint] merge` 待办、审核页「合并建议」区均有契约测试；晋升条件 1-5 全部满足——条件 5 在真库副本（VACUUM INTO 副本、不碰 live）上按序演练：候选发现 5 条（各 ≥2 独立信号）、人审否决全部假阳性并手动采纳一条真重复（墓碑 + 边重指向 + 保留页一字不变）。「向量相似度」那一路仍待 ADR-0018 lane 2 的 `page_embeddings`，缺席不阻塞其余。演练发现见末尾「实现修正」节） |
| [0020](0020-community-synthesis.md) | 社区摘要——用 Label Propagation 让 synthesis 层自己长出来 | Accepted（**真库副本端到端演练 + 人审已完成（2026-10-18）**。`internal/graph` 的同步 Label Propagation、白名单传播、synthesis 起草成 pending、`documents` 边与来源挂接、幂等 slug、预算与 `wiki_community_summary` 门都已实现并有测试；待决 4 按推荐落地（同步 + 硬预算，不给 `compile_jobs.kind` 加值，因此没有整表重建）。晋升条件 1、2、3、5 已满足——条件 4 在真库副本（VACUUM INTO 副本、不碰 live）上按序演练：门关时仅结构检测（1 社区，零外发、零写入，如实提示）；门开时产出 1 篇 pending synthesis 页（slug 决定性、3 条 documents 边、3 条 code-built note 附件），出口字节可审计；重跑更新同一 slug（未堆叠）。发现模型 slug 漂移（[[cbipay-branch-3.0.6]] 与实际 cbipay-branch-306 不符），人审可拦；另补演练所用模拟边（直接 SQL）形成 ≥3 人社区，验证门控逻辑。） |
| [0021](0021-temporal-graph-page-versions.md) | 时态图——`page_versions` 快照让「修订已批准结论」可以安全发生 | Accepted（**真库副本端到端演练 + 人审已完成（2026-10-18）**。`page_versions` 快照表、作为唯一写入者的 `AFTER UPDATE` 触发器、两条 append-only 守卫、逐页回填与 `DropWikiSchema` 可逆性均有测试；晋升条件 1、2 已满足；条件 4 已于 2026-10-13 改写为「真库落地后的回填对账」（真库当天在无演练前提下推进到 v22，原措辞失去对象，见该条修订记录），其完成需先存在 approved 页，而批准是人独有的动作；条件 3 随 `revise_page` 一起等待——决策 4 与待决 4 明确不在本 ADR 落地修订流。演练已在副本上完成：批准一张 pending 页得到首份快照；直接 `UPDATE wiki_pages SET content=… WHERE id=…`（模拟编辑器/导入器直写）得到第二份快照；尝试 `DELETE` 或 `UPDATE` `page_versions` 被触发器拒绝（错误 19：append‑only）。迁移实际取 v22 而非 v23，外键 CASCADE 同样触发行触发器，故快照表不能带级联外键。） |
| [0022](0022-agent-memory-discovery-sync.md) | 自动发现与定时同步 agent 记忆——来源类型用户可见（M8） | Proposed（方案待评审；CodeBuddy 接线可先行） |
| [0023](0023-note-ownership-knowledge-organize.md) | 笔记归属与知识库整理——导入不再静默丢知识，漂着的知识有落点、可归口 | Accepted（**真库副本端到端演练 + 人审已完成（2026-10-18）**。schema v24、导入落点、清理豁免、点笔记直达、知识库整理 UI + 3 个桌面专属 RPC 全部实现，`go test ./...` / `-race` / web build/test/lint / build-docs 全绿。晋升 Accepted 已达——条件 5 的真库副本演练（由用户亲自跑）在副本（VACUUM INTO 副本、不碰 live）上完成：opencode 导入产出 31 条笔记（全部会话文件解析），未匹配目录落于 import_placeholder 项目（如 CodeStat ×10），匹配目录更新现有项目；整理区可列出并执行 ReassignLandingNotes 迁移。演练发现并修复了一真实 bug：opencode 导入器的 Summary 字段类型漂移（旧版为字符串，新版为对象 {"additions":…, "deletions":…, "files":…}）导致 json.Unmarshal 整条记录失败，全部会话被静默拒绝（0 导入）——修改为 tolerant summaryField（接受 string 或任意非 string，视为空），补真实形态回归用例。另记 WalkDir 不跟随 symlink 的获悉：演练需先实体拷贝 session 目录到假 HOME。落码得到的与设计不同的事实见文末「实现修正」节） |
| [0024](0024-home-workbench-merge-search-page.md) | 首页工作台化——首页与仪表盘合并、全局搜索独立成页、热门推荐 | **Accepted（2026-10-16）**：`/` 单栏融合 Dashboard、`/dashboard` 重定向、导航以「搜索」替「仪表盘」、`/search` 空闲态展示热门项目/热门标签；修订 0017 §4 的两栏并排措辞，「仪表盘不移出首屏」原则不变 |
| [0025](0025-backup-recovery.md) | 备份与恢复——产品自带的每日本地快照，云端推送 opt-in | Proposed（**2026-10-18 L1 已落码**：每日 VACUUM INTO 快照（活连接含 WAL、日期即幂等键、启动即拍+每小时重试）+ 14 份轮转 + backup_enabled/backup_retain 门；纯本地零外发默认开；红线：活库永不进云盘同步文件夹（10-14 FUSE 嫌疑教训）；L2 云推送（litestream/S3）与 Docker 档定型未实现；Accepted 差真机恢复演练 + 三日连续快照 + 一次轮转观察） |

## 约定

- 每个重大不可逆决策一篇：背景 → 决策 → 后果
- 被 superseded 的 ADR 保留原文与横幅，不删除
- 新 ADR 从 `0025` 递增编号，文件名 `NNNN-kebab-title.md`
