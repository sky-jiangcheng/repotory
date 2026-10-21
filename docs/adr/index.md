---
title: 架构决策（ADR）
order: 26
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
| [0011](0011-multi-agent-memory-importers.md) | 多 agent 记忆源导入——可复用 importer 框架与各源可行性（M2） | Accepted（2026-10-19） |
| [0012](0012-semantic-search.md) | 语义检索评估——向量召回补 FTS5 盲区，守住零 CGO（M3） | Accepted-in-principle（**真实标注 A/B 门已过（2026-10-15 Phase 0：k=10 lexical 0.608 / hybrid 0.735 / delta +0.127，过「recall@10 >= 0.05」上线门；但 +0.127 才是真实增益，修 CJK 前的 +0.338 约六成是假信号**）；**2026-10-18 拍板仍保持默认关**——默认开等于替用户决定把笔记文本发给 embedding 端点，属须显式给出的隐私授权，此决策零改码零 CHANGELOG；前向约束：将来若切换只翻转新装/未配置库，存量不静默变。索引与状态行原写「A/B 门未过」，2026-10-19 按实况修订，详见该 ADR 末尾「门过、默认值与修订」节） |
| [0013](0013-vector-database-selection.md) | 本地向量存储选型（sqlite-vec，纯 Go）与安装引导（vector-init） | Accepted |
| [0014](0014-llm-wiki-knowledge-compiler.md) | LLM Wiki 知识编译层——摄入时编译、消费时取证（M6） | Accepted（2026-10-19 晋升：四条晋升条件均已核验；W1/W1b/W4/W2 已落地，W3 见 0015） |
| [0015](0015-w3-minimal-compile-loop.md) | W3 最小编译闭环——LLM 只写 pending 页，人批准才进检索 | Accepted |
| [0016](0016-async-batch-jobs.md) | 长时批任务的异步化——提交即返回、进度可查、结果可取 | Accepted |
| [0017](0017-one-kernel-two-entry-points.md) | 一个内核、两个入口——产品分层而不分叉仓库 | **Accepted（2026-10-13）**；条件 3 措辞于晋升当日由「第一安装路径」修订为「首屏叙事里的一等入口」，安装排序仍归 ADR-0009 管 |
| [0018](0018-knowledge-graph-foundation.md) | 知识图谱底座——受控关系词表让图可查，图感知取证让图被读 | **lane 1 与 lane 2 均 Accepted**（lane 1：2026-10-12 真库演练 PASS；lane 2：**2026-10-21 条件 10 三门全过**——密度 27 approved / 55 边，evidence 门 delta recall@10 **+0.205**、k=2..20 全区间为正、22 案例零回退，逐案诊断增益形如「命中种子页→沿白名单边带出邻接页」；`wiki_graph_search` 同日开启。种子召回定型为**分阶加性**：FTS 前缀原样保留、向量仅零命中时救场（`pageVectorRecall` k=8）、邻接只追加（纯 Go PPR 定序），结构性零回退；两种融合种子形态实测被否（等权 -0.182 / RRF 加权 +0.136 但 k<7 为负且 1 例回退），负结果见正文晋升记录。落地为 schema v23 页面向量空间 + `page_embed_dirty` 增量队列，Phase 0 门 2026-10-15 已过。live 未配 embedding 端点时生产口径为 FTS-only 分阶 +0.023） |
| [0019](0019-entity-resolution-merge.md) | 实体消歧与概念合并——治「概念分裂」，合并永远由人触发 | Accepted（**真库副本端到端演练 + 人审采纳已完成（2026-10-18）**。结构候选发现（四类信号 + blocking）、合并事务、模型二判→`[lint] merge` 待办、审核页「合并建议」区均有契约测试；晋升条件 1-5 全部满足——条件 5 在真库副本（VACUUM INTO 副本、不碰 live）上按序演练：候选发现 5 条（各 ≥2 独立信号）、人审否决全部假阳性并手动采纳一条真重复（墓碑 + 边重指向 + 保留页一字不变）。「向量相似度」那一路仍待 ADR-0018 lane 2 的 `page_embeddings`，缺席不阻塞其余。演练发现见末尾「实现修正」节） |
| [0020](0020-community-synthesis.md) | 社区摘要——用 Label Propagation 让 synthesis 层自己长出来 | Accepted（**真库副本端到端演练 + 人审已完成（2026-10-18）**。`internal/graph` 的同步 Label Propagation、白名单传播、synthesis 起草成 pending、`documents` 边与来源挂接、幂等 slug、预算与 `wiki_community_summary` 门都已实现并有测试；待决 4 按推荐落地（同步 + 硬预算，不给 `compile_jobs.kind` 加值，因此没有整表重建）。晋升条件 1、2、3、5 已满足——条件 4 在真库副本（VACUUM INTO 副本、不碰 live）上按序演练：门关时仅结构检测（1 社区，零外发、零写入，如实提示）；门开时产出 1 篇 pending synthesis 页（slug 决定性、3 条 documents 边、3 条 code-built note 附件），出口字节可审计；重跑更新同一 slug（未堆叠）。发现模型 slug 漂移（[[cbipay-branch-3.0.6]] 与实际 cbipay-branch-306 不符），人审可拦；另补演练所用模拟边（直接 SQL）形成 ≥3 人社区，验证门控逻辑。） |
| [0021](0021-temporal-graph-page-versions.md) | 时态图——`page_versions` 快照让「修订已批准结论」可以安全发生 | Accepted（**真库副本端到端演练 + 人审已完成（2026-10-18）**。`page_versions` 快照表、作为唯一写入者的 `AFTER UPDATE` 触发器、两条 append-only 守卫、逐页回填与 `DropWikiSchema` 可逆性均有测试；晋升条件 1、2 已满足；条件 4 已于 2026-10-13 改写为「真库落地后的回填对账」（真库当天在无演练前提下推进到 v22，原措辞失去对象，见该条修订记录），其完成需先存在 approved 页，而批准是人独有的动作；条件 3 随 `revise_page` 一起等待——决策 4 与待决 4 明确不在本 ADR 落地修订流。演练已在副本上完成：批准一张 pending 页得到首份快照；直接 `UPDATE wiki_pages SET content=… WHERE id=…`（模拟编辑器/导入器直写）得到第二份快照；尝试 `DELETE` 或 `UPDATE` `page_versions` 被触发器拒绝（错误 19：append‑only）。迁移实际取 v22 而非 v23，外键 CASCADE 同样触发行触发器，故快照表不能带级联外键。） |
| [0022](0022-agent-memory-discovery-sync.md) | 自动发现与定时同步 agent 记忆——来源类型用户可见（M8） | Proposed（方案待评审；逐阶段核验 2026-10-21：P1 CodeBuddy 双源接线 + P3 定时同步（ticker / 240 分钟 / 七源 `sync_source_*` opt-in）已落码，P2 发现探活（`Probe` 契约）/ P4 来源类型 UI / P5 收口未开工） |
| [0023](0023-note-ownership-knowledge-organize.md) | 笔记归属与知识库整理——导入不再静默丢知识，漂着的知识有落点、可归口 | Accepted（**真库副本端到端演练 + 人审已完成（2026-10-18）**。schema v24、导入落点、清理豁免、点笔记直达、知识库整理 UI + 3 个桌面专属 RPC 全部实现，`go test ./...` / `-race` / web build/test/lint / build-docs 全绿。晋升 Accepted 已达——条件 5 的真库副本演练（由用户亲自跑）在副本（VACUUM INTO 副本、不碰 live）上完成：opencode 导入产出 31 条笔记（全部会话文件解析），未匹配目录落于 import_placeholder 项目（如 CodeStat ×10），匹配目录更新现有项目；整理区可列出并执行 ReassignLandingNotes 迁移。演练发现并修复了一真实 bug：opencode 导入器的 Summary 字段类型漂移（旧版为字符串，新版为对象 {"additions":…, "deletions":…, "files":…}）导致 json.Unmarshal 整条记录失败，全部会话被静默拒绝（0 导入）——修改为 tolerant summaryField（接受 string 或任意非 string，视为空），补真实形态回归用例。另记 WalkDir 不跟随 symlink 的获悉：演练需先实体拷贝 session 目录到假 HOME。落码得到的与设计不同的事实见文末「实现修正」节） |
| [0024](0024-home-workbench-merge-search-page.md) | 首页工作台化——首页与仪表盘合并、全局搜索独立成页、热门推荐 | **Accepted（2026-10-16）**：`/` 单栏融合 Dashboard、`/dashboard` 重定向、导航以「搜索」替「仪表盘」、`/search` 空闲态展示热门项目/热门标签；修订 0017 §4 的两栏并排措辞，「仪表盘不移出首屏」原则不变 |
| [0025](0025-backup-recovery.md) | 备份与恢复——产品自带的每日本地快照，云端推送 opt-in | Proposed（**L1 已落码 2026-10-18**：每日 VACUUM INTO 快照（活连接含 WAL、日期即幂等键、启动即拍+每小时重试）+ 14 份轮转 + backup_enabled/backup_retain 门；纯本地零外发默认开；红线：活库永不进云盘同步文件夹（10-14 FUSE 嫌疑教训）；**L2 云推送已落码 2026-10-19**（minio-go 进程内上传快照副本，六键 backup_remote_* 默认全空 = 零外发）+ Dockerfile/compose 部署档；**晋升条件 1 真机恢复演练 10-18 完成、2 连续三日快照 10-21 达成（10-18/19/20 各一份）**，差条件 3 一次轮转观察（retain=14，需第 15 份；10-21 实测仅 3 份）） |
| [0026](0026-frontend-test-async-readiness.md) | 前端测试的异步落地契约——「等数据」写在哪一层 | **Accepted（2026-10-19 经用户批准晋升）**（方向与子决策 2026-10-18 拍定；A2 + A1 于 2026-10-19 落码：三层 A2+A1+C、B 否掉、helper 只覆盖 4 个同形状文件。`web/src/test/renderReady.tsx`（`renderReady`/`settle()`/探针 `lagged()`）+ `Review`/`Home`/`Dashboard`/`Search` 接入 + `Review.test.tsx` 三处列表断言改等数据；晋升条件 1/2/3/5/6 达成后，**C（`eslint-plugin-testing-library`）亦于 2026-10-19 接入并逐条处置完 69 条既有违例——条件 1-6 逐条核验均成立，故经用户批准晋升 Accepted**）。触发事实：`8d81714` 就地修掉 `Review.test.tsx` 的 select flake 后复核发现范围更大——三条加载 promise 各延迟 300ms 的探针下，该文件 12 用例红 3 个且**均非 select 类**（真竞态类是「`findBy*` 等无条件挂载的锚点 + 随后同步读 effect 状态」），`pickProject` 那 3 个用例同探针下全绿。方案 A（共享 helper：A1 per-test 谓词 / A2 通用 `settle()`）与方案 B（默认非空 mock）对比，**B 被测量直接否证**（红掉的用例本就喂了非空数据；且破 3 个空态用例），另记方案 C（`eslint-plugin-testing-library`，抓不到本类、仅互补）。未测项已明写：CI 真实滞后量级未测，「A2 足以消灭真实 flake」是推断 → 晋升条件 1。选定后补记两条：A2 的 blanket-wait 风险经核查在现有组件测试**零暴露**（`loading` 断言全在 4 个 `renderHook` 测试里、且断言的是已落地态），但它带一个会死锁的前提——`settle()` 靠真实 `setTimeout(0)`，在 `vi.useFakeTimers()` 下永不 resolve。子决策已定：helper **只覆盖 4 个同形状文件**，`AiTab`/`NotFound`/`App.smoke` 显式排除（不把「真实 vs mock」两种 i18n 口径塞进同一个 helper），且这条边界须同时写进 `CONTRIBUTING.md` 与 helper 注释两处。**落码实测**：探针 `REPO_TEST_LAG_MS=300` 与 `700` 两档 145 例全绿（修复前同一探针红 3 例），6 轮顺序 + 8 路并发（带延迟且争抢 CPU）全 exit 0；把新增的首页下拉测试退回「等 combobox」得到 `expected '0' to be '7'`，与 Review 同一签名——条件 2 为实测。两条落码期新事实进「实现修正」：`lagged()` 须配 `mockImplementation`（`mockResolvedValue` 处 tsc 报 7 处 TS2345）、探针必须打进 per-test 覆盖值否则被测用例绕开它 |

## 约定

- 每个重大不可逆决策一篇：背景 → 决策 → 后果
- 被 superseded 的 ADR 保留原文与横幅，不删除
- 新 ADR 从 `0027` 递增编号，文件名 `NNNN-kebab-title.md`
