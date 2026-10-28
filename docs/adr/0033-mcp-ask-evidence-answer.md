# ADR-0033: MCP `repotory_ask` 接上证据问答——让 agent 与桌面端拿到同一个答案

- 状态：Accepted（**2026-10-28 落稿 + 落码，同日经用户批准晋升**。实施与验证结果见文末「实现修正」与「验证记录」两节）
- 日期：2026-10-28
- 关联：[ADR-0014](0014-llm-wiki-knowledge-compiler.md)（知识编译层——取证与证据块的出处）、[ADR-0015](0015-w3-minimal-compile-loop.md)（审批闸门在写侧）、[ADR-0027](0027-jetbrains-plugin.md)（薄客户端纪律——同一能力只有一份实现）、[ADR-0030](0030-ai-call-audit.md)（MCP 进程即 agent 面，调用要留痕）、[ADR-0032](0032-approved-wiki-page-visibility.md)（同批：已批准页对 agent 也可读）、[ADR-0006](0006-scope-freeze.md)（范围冻结——本 ADR 不扩产品边界）
- 起点 schema：v28（**本 ADR 无 schema 变更**）

## 背景

### 事实一：叫「ask」的工具，做的是 grep

`repotory_ask` 是 MCP 面上唯一带「问」字语义的工具。它原来的实现（`cmd/mcp/main.go`，本轮改动前）是：

```go
hits := svc.SearchAll(query)
if len(hits) == 0 {
    return makeTextResult("No results found for: " + query), nil
}
return makeTextResult(strings.Join(service.FormatSearchAnswer(hits, 5), "\n---\n")), nil
```

`FormatSearchAnswer` 产出的是 `[type] title\nsnippet` 的文本块。这是 FTS 命中列表，不是答案——工具自己的描述里写着「Ask a question against the local knowledge base (**notes + todos search**)」，它连自己在做什么都承认了。

于是 agent 问「为什么这里要重试三次？」，拿回五个标题，然后自己把答案编出来。**提问的活儿被推回给了 agent，而它没有检索权、没有上下文、也不知道这些笔记在库里各自意味着什么。**

### 事实二：桌面端早就有带出处的答案

`internal/service/wiki_evidence.go` 的 `AskAIWithEvidence` 是完整的一条链：`GatherEvidence` 取证（页 + 笔记，带预算与出处编号 P1/N3）→ `evidenceMessages` 装配提示（L3 跨项目画像 + L2 项目场景 + 证据块 + 问题）→ `chatWithAudit` 调用模型（**审计留痕**）→ 返回 `EvidenceAnswer{Reply, Evidence, Truncated}`。桌面端的问答面板用的就是它。

同一个产品、同一份本地知识库，**桌面端给带出处的答案，MCP 给标题列表**。这个分叉正是本仓反复写 ADR 的那类问题——ADR-0027 为 IDE 插件写过一遍（薄客户端：同一能力只有一份实现），这里轮到桌面端与 MCP 之间。

### 事实三：TODO 的验收标准要的是「同一个答案」

TODO Sprint 1.5 的验收写得很直接：「**桌面端与 MCP 对同一问题给出带出处的答案**」。若 MCP 另写一套问答逻辑，两边会各答各的；要「同一个答案」，就不能是两份实现。

## 决策

**1. MCP 的 `repotory_ask` 走 `service.AskAIWithEvidence`，与桌面端同一份实现。**

不是「在 MCP 里也调个模型」，而是**同一个函数**：同一套取证、同一套提示装配、同一套预算（`DefaultEvidenceBudget`：12 项 / 4000 字符 / 3 秒）。差别只有传输与渲染。

- 出处随答案一起返回：`Evidence` 里的 P1/N3 编号就是模型引用的编号，来源清单把它们还原成「类型 / 标题 / id / slug / 所属项目」。
- 审计留痕：MCP 进程里 `svc.SetAuditSurface(service.AISurfaceMCP)`（ADR-0030），模型调用照旧进 `ai_call_log`。

**2. 没有配 AI 端点 → 关键词回退，但必须标明「这不是答案」。**

回退本身不是新东西：原来那个工具做的正是这件事，删掉它会让没配端点的用户从「有东西看」变成「什么都没有」。**但回退的措辞必须变**：

```
No AI endpoint is configured, so this is a keyword match list, NOT an answer:
```

原来返回的就是同一批文本，且没有任何标注——agent 会把五个标题当成结论。**标注是这条决策的核心，不是礼貌用语**：一个叫 `ask` 的工具返回未标注的 grep 结果，等于在替 agent 编造结论。

**3. 配了端点但调用失败 → 报错，不回退。**

「没配端点」和「端点挂了」是两件不同的事：前者要用户去设置里填，后者值得重试。把两者都变成同一段 grep 输出，agent 就永远学不到「这个环境现在能不能问」。所以只有 `ErrAIChatNotConfigured` 这一个哨兵错误走回退，其余一律 `error: …`。

**4. 新增 `project_id` / `path` 作用域参数。**

桌面端的面板有项目上下文，MCP 以前没有，于是 MCP 的答案永远是跨项目的。加上两个参数后：`project_id` 优先，`path` 由服务端解析（与 `repotory_context` 同一个匹配器），都不给就是跨项目问答。

**5. 答案必须带出处清单。**

模型回答里的 `[P2]` 对读者毫无意义，除非读者能看到 P2 是什么。所以输出固定是「答案正文 + Sources 清单」，清单每行给出 ref、类型、标题、id、slug、所属项目。

**6. 输出契约变了，这是有意的。**

旧形状是 `[type] title\nsnippet` 文本块，新形状是散文答案 + Sources 段。**依赖旧形状的客户端会读到不同的东西。** 这是本 ADR 接受的代价：工具名承诺的是答案，`repotory_ask` 返回标题列表这件事本身就是缺陷。回退路径保留旧形状（`FormatSearchAnswer` 的块状格式），所以**未配端点的客户端解析形状不变**——变的只有配了端点的那条路。

## 候选矩阵（MCP 怎么回答）

| 方案 | 价值 | 主要代价 | 判定 |
|---|---|---|---|
| **复用 `AskAIWithEvidence`，无端点时标注回退**（本决策） | 桌面端与 MCP 同一份实现；出处随答案走 | 输出契约变了（决策 6） | **采纳** |
| MCP 里另写一套问答 | 不碰桌面端 | 两份检索 + 两份提示 = 两份答案；TODO 的验收标准直接不成立 | 否决 |
| 保留 grep，另加一个 `repotory_answer` 工具 | 旧契约不动 | 两个语义重叠的工具，agent 不知道选哪个；「ask」继续名不副实 | 否决 |
| 不做回退，没端点就报错 | 语义最干净 | 绝大多数没配端点的安装直接失去这个工具 | 否决 |
| 回退但不标注 | 兼容旧形状 | agent 把标题当结论——本 ADR 要修的正是这件事 | 否决 |

## 后果

**正面**：

- MCP 从「帮 agent 找东西」变成「帮 agent 得到答案」，且答案带出处。
- 桌面端与 MCP 的答案由同一段代码产生，**不可能各说各话**——这是 TODO 1.5 验收标准的字面达成。
- 没配端点的安装仍有输出，且输出**说清了自己是什么**。
- 模型调用沿用 MCP 的审计面（ADR-0030），不新增留痕缺口。

**负面（不粉饰）**：

- **输出契约变了**（决策 6）。写了「解析 `[type] title` 文本块」的 agent 客户端要改。
- **MCP 面的问答从此依赖模型可用性**。端点不可用时 `repotory_ask` 变成错误而不是结果——这比"安静地给一堆标题"诚实，但确实让这个工具变得不那么「总是能用」。
- **问答变慢**。一个本地模型可能跑几十秒到几分钟，stdio 上表现为一次长调用。取证本身有 3 秒预算，模型调用没有更短的默认值（`aiAskTimeout` 是 5 分钟，与桌面端一致）。
- **回退路径的措辞是英文**，与本仓其它 agent 面的文案一致（`repotory_ask` 的其它返回值本来就是英文）。

## 实现修正（落码与设计不同的事实）

1. **`repotory_ask` 从 `main.go` 挪到 `cmd/mcp/tools_ask.go`。** 它是本文件里唯一有「模型调用 + 回退策略 + 作用域解析」三段逻辑的工具，留在 `registerTools` 里会让那个函数继续长下去；同批新增的 wiki 工具同理，独立成 `cmd/mcp/tools_wiki.go`。
2. **「没配端点」需要一个可判定的错误，于是加了哨兵 `service.ErrAIChatNotConfigured`。** 原来 `aiChatConfig` 返回的是一句带指引的普通错误字符串，调用方只能靠字符串匹配来区分两种失败——那是最脆的一种判定。现在它是 `errors.Is` 能认的哨兵，而**错误文案一字未改**（`AI chat is not configured — set the endpoint and model in Settings → AI`），前端那条既有提示不受影响。
3. **工具描述改写，并写明了两条边界**：空 `query` 走浏览清单（不是失败的检索），未配端点返回的是关键词匹配（不是答案）。agent 靠描述选工具，描述里少一句就多一次误用。
4. **工具数从 16 变 18**（`repotory_wiki_search` / `repotory_wiki_read`），`TestToolsRegistered` 的清单同步更新——那个清单是钉死的，工具数漂移会被测试挡住。
5. **落码后的验证撞出并修掉了一个检索缺口：带标点的中文问句取不到任何证据。** 实跑 `repotory_ask` 时，答案是模型的通识（末尾标注「the reply above is the model's own」），而不是本地那一页——尽管 `SearchWikiPages(0, "时态图")` 明明命中。根因在共享的 `expandForFTS`：`isCJKRun` 把含标点的整句判成非 CJK，于是整句被当成一个不可匹配的短语 emitting 出去，放宽路径只有一个词可 OR，索性放弃。**中文问句里标点本来就多**，这正是 `ask` 最该处理的形状。修法落在 `internal/db/search.go`（先按标点切段，逐段再判 CJK），笔记路径与页路径一起好。详见 [ADR-0032](0032-approved-wiki-page-visibility.md) 的实现修正第 5 条。
   - **这个缺口让决策 2 的兜底成了常客而不是例外**：标注「这是模型自己的回答」诚实地救了语义，但一个叫 `ask` 的工具长期给不出本地出处，就等于没接上证据问答。修完之后，实测 MCP 与桌面端都拿到 12 条出处的证据答案。

## 验证

见文末「验证记录」。

## 不做什么（明确留白）

- 不在 MCP 侧做流式回答（桌面端有 `AskAIWithEvidenceStream`，但它走 Wails 事件，stdio 的 MCP 没有事件通道）。
- 不让 `repotory_ask` 写回任何东西（存为页面是桌面端的人工动作，见 `FileAnswerAsPage`）。
- 不给 MCP 暴露模型的原始配置（端点与密钥不外泄给 agent）。
- 不动 `repotory_notes_search`（笔记/待办的检索仍是 grep，它的语义就是检索）。

## 验证记录

2026-10-28 落码后的实测记录。

### 1. 自动化测试

| 位置 | 用例 | 结果 |
|---|---|---|
| `cmd/mcp`（`tools_ask_test.go`） | 4 例：空 query 被拒 / **未配端点时回退被明确标注「不是答案」** / 未配端点且无命中时的文案 / query 仍必填 | 全绿 |
| `cmd/mcp`（`tools_wiki_test.go`） | 4 例：wiki 检索命中已批准页 / 空 query 列已批准页 / **工具绝不暴露未批准页** / wiki 读取返回正文 | 全绿 |
| `cmd/mcp`（`main_test.go`） | `TestToolsRegistered` 钉住 **18 个**工具的清单——工具数漂移即测试红 | 全绿 |
| `go test ./...` | 全仓 | 通过 |

### 2. live 实测：桌面端与 MCP 给出同一个带出处的答案

TODO 1.5 的验收标准是「桌面端与 MCP 对同一问题给出带出处的答案」。两条路径都打同一个问题：

```
MCP  repotory_ask(query="时态图是什么？为什么需要它？")
     → 答案正文 + Sources 清单：[N2] note … [P3] page "ADR-0014…" [P4] note "ADR-0021:" …
       … [P12] page "ADR-0020: 社区摘要…"，并注明「(2 further match(es) omitted by the context budget)」

桌面端 AskAIWithEvidence(0, "时态图是什么？为什么需要它？")
     → 证据条数 12，答案开头同为「时态图是 **在 wiki_pages 表旁构建的 append-only 版本快照表…」
```

**证据条数一致（12 = `DefaultEvidenceBudget` 的上限），首个来源同为 ADR-0021 那张页。** 这不是「两边看起来像」，而是同一段代码产出的同一份证据——MCP 与桌面端只差传输与渲染。

### 3. 验证时发现并修掉的检索缺口（与 ADR-0032 同一处）

第一次实跑 `repotory_ask` 时，答案是模型的**通识**（讲的是时态图的通用概念，不是本库的那一页），末尾标注：

```
_(no local knowledge matched this question; the reply above is the model's own)_
```

那个标注是本 ADR 决策 2 的兜底在起作用——它诚实地说明了「这不是从本地知识库来的」。但**本地知识库里明明有那一张页**（`SearchWikiPages(0, "时态图")` 命中）。根因在共享层：`expandForFTS` 用 `isCJKRun` 判 CJK，而**标点不是 CJK**——于是带问号的整句被当成一个不可匹配的短语 emitting 出去，放宽路径只有一个词可 OR，索性放弃。

**中文问句里标点本来就多**，所以这正是 `ask` 最该处理的输入形状。修法落在共享的 `expandForFTS`（先按标点切段，逐段再判 CJK），笔记路径与页路径一起好。修完复测，MCP 与桌面端都拿到了带 12 条出处的证据答案（见 2）。

### 4. 没验证到的部分（如实记下）

- **AI 端点本身不稳定**：连续 5 次 `repotory_ask` 有 1 次返回 `error: AI endpoint returned no choices`，桌面端同一路径同样会拿到这个错误。**这不是接线差异**——两端调的是同一个 `svc.AskAIWithEvidence`；是本机配置的那个模型端点偶尔给出空 choices。本 ADR 决策 3 在这里的含义正是「配了端点但调用失败就报错」，错误文本如实透出。
- **「配置了但调用失败 → 报错、不回退」这条分支没有在 live 上跑过**：live 的端点是配好的，回退分支由单元测试（`TestAskWithoutAIEndpointLabelsItsFallback`）守着。真机上把端点改坏再验一次才算是端到端确认。
- **`repotory_ask` 的 stdout 契约只在本仓自己的 probe 上验过**：MCP 客户端（Claude Code / Cursor 等）读到的形状没有第三方客户端实测。
