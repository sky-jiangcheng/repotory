# ADR-0027: JetBrains 插件立项——薄客户端纪律下的第二个 IDE 分发面

状态：**Accepted（2026-10-22）**——落稿当日 4 项开放问题经项目所有者委托拍板（见「开放问题拍板」），同日晋升；排期另议
日期：2026-10-22
关联：[ADR-0009](0009-ide-presence.md)（本 ADR 修订其决策 4：JetBrains 由「缓议」转「立项」）、[ADR-0007](0007-session-memory-protocol.md)（MCP 唯一执行接口）、[ADR-0006](0006-scope-freeze.md)（分发面不是平台化）、[ADR-0017](0017-one-kernel-two-entry-points.md)（headless API 是插件消费面）、VS Code 扩展（`ide/vscode`，第一个 IDE 分发面）

## 背景

[ADR-0009](0009-ide-presence.md) 决策 4 将 JetBrains 插件定为缓议：「独立 Kotlin/Gradle 代码库，双倍维护面；在收到真实需求信号（issue/star）并补写 ADR 论证前不立项、不写代码」。该门槛里的「issue/star 数量级」是**公开分发场景下的代理指标**——用陌生用户的声量估计真实需求，避免为还不存在的用户群维护第二个技术栈。

2026-10-22 项目所有者本人直接给出需求信号并拍板立项。代理指标在此失去意义：所有者本人即 JetBrains IDE 的日常用户，需求信号以最直接的形态（本人明确指示）给出，不存在「为不存在的用户维护代码」的风险——维护者与用户是同一人。ADR-0009 缓议的实质理由（双倍维护面）依然成立，但它成立的前提（需求不确定）已经消失；本 ADR 即其遗留条款「收到真实需求信号后补写 ADR 论证」的执行。

能力侧事实（逐条核实过）：

- headless server（`cmd/server`，默认 `127.0.0.1:18765`，loopback-only）经 `/api/rpc` 通用桥暴露与桌面 Wails 端**完全一致**的绑定面，另有 REST 端点供 dsh 插件 / agent 使用——插件需要的全部能力（检索、笔记、wiki、证据取证）现成可用，且 `/api/rpc` 已被 Web 前端日常负载验证。
- MCP server（`repotory-mcp`）可注册进 JetBrains AI Assistant / 内置 MCP 客户端（ADR-0009 背景已确认 JetBrains 原生支持），但那只服务 agent 流；「人」在 IDE 里依然零原生 UI——命令面板、工具窗、状态栏上 Repotory 不存在，这正是 ADR-0009 要解决的可见性盲区在第二大家族上的延续。
- VS Code 扩展（`ide/vscode`）已落地并验证了薄壳范式：命令面板命令、状态栏、侧边栏检索，全部经共享服务层零逻辑复制。JetBrains 插件是该范式的第二次复用，不是新模式探索——设计风险已被第一个 IDE 分发面消化过一轮。

## 决策

1. **立项，承接薄客户端纪律**：插件是薄壳——经 headless HTTP（`/api/rpc` 为主）调共享服务层，零逻辑复制；不新增执行接口（MCP 保持唯一执行接口，ADR-0007）；插件只随对外 API 演进，不随内部实现演进。违反此纪律的子方案一律不入 MVP。
2. **MVP 范围（平移 VS Code 扩展范式）**：
   - ① 知识库检索工具窗：笔记 + wiki 页的 FTS/hybrid 搜索（走既有检索绑定；语义与图感知随 `semantic_search` / `wiki_graph_search` 门控自然生效，插件不自带门控逻辑、不重复实现排序）；
   - ② 结果跳转：在系统浏览器打开 Repotory SPA 定位到该结果（同源 server 地址；深链路由以前端现状为准，不足处随 MVP 补最小路由参数，不在插件内嵌完整 UI）；
   - ③ 设置页：server 地址（默认 `http://127.0.0.1:18765`）+ 连接健康检查；
   - ④ MCP 一键注册（复用 `repotory-init` 的注册思路，写 JetBrains 侧的 MCP 客户端配置）——若实现时发现 IDE 配置面过于不稳定，降级为文档指引，不阻塞 MVP。
3. **技术形态**：Kotlin + Gradle（IntelliJ Platform Plugin）；独立代码库。与 ADR-0009 预判一致的双倍维护面由此**明知接受**，其边界由薄客户端纪律压在 API 层。

## 开放问题拍板（2026-10-22，所有者委托统一裁定）

1. **目标 IDE 家族与版本基线 → IntelliJ IDEA CE 先行，平台级兼容，基线 242（2024.2+）**。本机实测所有者的 JetBrains 日常 IDE 为 IntelliJ IDEA CE（`/Applications/IntelliJ IDEA CE.app` = 2025.2.6.1，支持目录 `IdeaIC2025.2`，另有 `IntelliJIdea2024.3-backup`；全机无 GoLand——原问题「如 GoLand」的预设不成立）。插件声明 `com.intellij.modules.platform`：MVP 所需 API（工具窗 / 设置页 / 浏览器跳转 / HTTP）均为纯平台 API，同一构建即可装入全部 IntelliJ 家族（含本机 PyCharm CE），不按产品分叉。`sinceBuild=242` 覆盖所有者近期的 2024.3 与当前 2025.2 并留余量；开发与验收以 IDEA CE 2025.2 为准；公开分发前复核基线。
2. **分发方式 → 私有分发先行**（磁盘安装 / 私有更新源，无签名与审核摩擦）；Marketplace 待插件稳定后另议（采纳原建议）。
3. **会话捕捉 → 不入 MVP**：严格对齐 VS Code 扩展已验证的能力面，终端/捕捉集成留待真实痛点（采纳原建议）。
4. **server 生命周期 → 仅连接**：连接既有实例（用户自启 / 开机自启），薄壳零托管（采纳原建议）；托管自启待真实痛点再议，届时沿用 dsh 插件实践落文档。ADR-0009 遗留的生命周期托管问题在 JetBrains 侧按此落定。

## 后果

- 正面：JetBrains 家族获得 IDE 内可见存在（工具窗 / 设置页），传播货架补齐第二块；薄客户端纪律使维护面限于 API 层演进；检索后端直接受益于 lane 2 生产管线（`semantic_search` + 图感知取证已开启，2026-10-22），插件零额外成本继承全管线口径。
- 负面：+1 个 Kotlin/Gradle 独立代码库（双倍维护面——0009 缓议的原始理由，由所有者在需求信号明确的前提下明知接受）；一份构建只覆盖 JetBrains 一家，无 VSIX 式 fork 家族摊薄。
- 中性：不触碰范围冻结（`repotory` 二进制名 / 数据目录 / MCP 前缀 `repotory_*` 不变；插件是分发面不是平台化，ADR-0006 的调和条款继续适用）。
- 遗留：Marketplace 上架材料（截图 / 描述 / 图标）与签名事宜——分发方式已拍板私有分发先行，此项推迟至插件稳定、转入 Marketplace 上架议程时处理；`sinceBuild` 基线届时一并复核。
