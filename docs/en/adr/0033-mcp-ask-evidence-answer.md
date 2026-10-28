# ADR-0033: Wiring MCP `repotory_ask` to evidence-backed Q&A — one answer for the agent and the desktop

- Status: Accepted (**written and implemented on 2026-10-28, promoted on the user's approval the same day**. The implementation and verification results are in the "Implementation notes" and "Verification record" sections at the end)
- Date: 2026-10-28
- Related: [ADR-0014](0014-llm-wiki-knowledge-compiler.md) (the compiled-knowledge layer — where evidence and its refs come from), [ADR-0015](0015-w3-minimal-compile-loop.md) (the approval gate is on the write side), [ADR-0027](0027-jetbrains-plugin.md) (thin-client discipline — one implementation per capability), [ADR-0030](0030-ai-call-audit.md) (the MCP process IS the agent surface, so its calls are audited), [ADR-0032](0032-approved-wiki-page-visibility.md) (same batch: approved pages are readable by agents too), [ADR-0006](0006-scope-freeze.md) (scope freeze — this ADR does not widen the product)
- Starting schema: v28 (**no schema change in this ADR**)

## Background

### Fact one: the tool called "ask" was doing a grep

`repotory_ask` is the only tool on the MCP surface whose name promises an answer. Its implementation before this batch (in `cmd/mcp/main.go`) was:

```go
hits := svc.SearchAll(query)
if len(hits) == 0 {
    return makeTextResult("No results found for: " + query), nil
}
return makeTextResult(strings.Join(service.FormatSearchAnswer(hits, 5), "\n---\n")), nil
```

`FormatSearchAnswer` produces `[type] title\nsnippet` text blocks. That is a list of FTS hits, not an answer — and the tool's own description admitted it: "Ask a question against the local knowledge base (**notes + todos search**)".

So an agent asking "why does this retry three times?" got five titles back and had to compose the answer itself. **The work of answering was pushed back to the agent**, which has no retrieval rights, no context, and no idea what those notes mean in the library.

### Fact two: the desktop app has long had an answer with sources

`AskAIWithEvidence` in `internal/service/wiki_evidence.go` is a complete chain: `GatherEvidence` retrieves pages and notes (with a budget and citation refs P1/N3) → `evidenceMessages` assembles the prompt (L3 cross-project profile + L2 project scenario + evidence block + question) → `chatWithAudit` calls the model (**audited**) → returns `EvidenceAnswer{Reply, Evidence, Truncated}`. The desktop ask panel uses exactly this.

Same product, same local library: **the desktop gives a cited answer, MCP gives a list of titles**. That fork is the kind of problem this repo keeps writing ADRs about — ADR-0027 wrote it down for the IDE plugins (thin clients: one implementation per capability). Here it is the desktop and MCP that have drifted apart.

### Fact three: the acceptance criterion asks for ONE answer

TODO Sprint 1.5 states it plainly: "**the desktop and MCP give an answer with sources for the same question**". If MCP wrote its own Q&A logic, the two surfaces would answer in their own ways. To have "one answer", there cannot be two implementations.

## Decisions

**1. MCP's `repotory_ask` calls `service.AskAIWithEvidence` — the same implementation as the desktop.**

Not "also call a model from MCP", but *the same function*: the same retrieval, the same prompt assembly, the same budget (`DefaultEvidenceBudget`: 12 items / 4000 chars / 3 s). Only the transport and the rendering differ.

- The sources travel with the answer: the P1/N3 refs in `Evidence` are the refs the model cites, and the source list resolves them back to "type / title / id / slug / owning project".
- Auditing is unchanged: the MCP process sets `svc.SetAuditSurface(service.AISurfaceMCP)` (ADR-0030), so model calls still land in `ai_call_log`.

**2. No AI endpoint configured → keyword fallback, labelled as NOT an answer.**

The fallback is not new: the old tool did exactly this, and removing it would leave installs without an endpoint with nothing at all. **But the wording has to change:**

```
No AI endpoint is configured, so this is a keyword match list, NOT an answer:
```

The old tool returned the same text with no label, and an agent would read five titles as a conclusion. **The label is the core of this decision, not a courtesy**: a tool named `ask` returning unlabelled grep output is the agent fabricating a conclusion on the user's behalf.

**3. Endpoint configured but the call failed → an error, not a fallback.**

"Never configured" and "the endpoint is down" are different facts: the first needs the user to open Settings, the second is worth retrying. Collapsing both into the same grep output means the agent never learns whether this environment can answer questions at all. So exactly one sentinel error takes the fallback path (`ErrAIChatNotConfigured`); everything else is `error: …`.

**4. New `project_id` / `path` scope arguments.**

The desktop panel has a project context; MCP had none, so every MCP answer was cross-project. With the two arguments: `project_id` wins, `path` is resolved server-side (the same matcher `repotory_context` uses), and neither means a cross-project answer.

**5. The answer must carry its sources.**

A `[P2]` inside the model's reply means nothing to the reader unless the reader can see what P2 is. The output is therefore always "the answer, then a Sources list", one line per ref with type, title, id, slug and owning project.

**6. The output contract changed, on purpose.**

The old shape was `[type] title\nsnippet` blocks; the new one is a prose answer plus a Sources section. **Clients that depend on the old shape will read something different.** That is the cost this ADR accepts: the tool's name promises an answer, and `repotory_ask` returning a list of titles was the defect. The fallback path keeps the old shape (`FormatSearchAnswer`'s blocks), so **clients on an unconfigured install parse the same shape as before** — only the path with an endpoint changes.

## Candidate matrix (how MCP answers)

| Option | Value | Main cost | Verdict |
|---|---|---|---|
| **Reuse `AskAIWithEvidence`, labelled fallback when unconfigured** (this decision) | The desktop and MCP share one implementation; the sources travel with the answer | The output contract changes (decision 6) | **Adopted** |
| Write a separate Q&A path in MCP | Leaves the desktop alone | Two retrievals and two prompts means two answers; TODO's acceptance criterion simply fails | Rejected |
| Keep the grep, add a separate `repotory_answer` tool | The old contract stays | Two tools with overlapping meanings; the agent does not know which to pick; "ask" stays misleading | Rejected |
| No fallback — error when no endpoint | Cleanest semantics | Most installs (no endpoint configured) simply lose the tool | Rejected |
| Fallback without a label | Compatible with the old shape | The agent reads titles as a conclusion — exactly what this ADR exists to fix | Rejected |

## Consequences

**Positive**:

- MCP goes from "helping the agent find things" to "giving the agent an answer", with sources.
- The desktop and the MCP answers are produced by the same code, so they **cannot disagree** — the literal meaning of TODO 1.5's acceptance criterion.
- Installs without an endpoint still get output, and the output **says what it is**.
- Model calls keep using MCP's audit surface (ADR-0030); no new gap in the audit trail.

**Negative (not glossed over)**:

- **The output contract changed** (decision 6). Agents that parse `[type] title` text blocks need updating.
- **Q&A on the MCP surface now depends on model availability.** When the endpoint is down, `repotory_ask` is an error rather than a result. That is more honest than "quietly hand back a pile of titles", but it does make the tool less always-available.
- **Q&A got slower.** A local model can take tens of seconds to minutes; over stdio that is one long call. The retrieval itself is bounded at 3 s; the model call has no shorter default (`aiAskTimeout` is 5 minutes, same as the desktop).
- **The fallback wording is English**, consistent with the rest of the agent surface (`repotory_ask`'s other return values were English too).

## Implementation notes (facts that differed from the design)

1. **`repotory_ask` moved out of `main.go` into `cmd/mcp/tools_ask.go`.** It is the only tool in this file with three pieces of logic (model call + fallback policy + scope resolution), and leaving it in `registerTools` would keep growing that function; the wiki tools added in the same batch went the same way, into `cmd/mcp/tools_wiki.go`.
2. **"Not configured" needs a decidable error, so `service.ErrAIChatNotConfigured` was added as a sentinel.** `aiChatConfig` used to return an ordinary error string with a pointer to the settings page, which left callers to distinguish two kinds of failure by string matching — the most fragile kind of check. It is now an `errors.Is`-able sentinel, and **the error text is unchanged** ("AI chat is not configured — set the endpoint and model in Settings → AI"), so the existing frontend hint is unaffected.
3. **The tool description was rewritten, and it states two boundaries explicitly**: an empty `query` lists the pages (that is not a failed search), and an unconfigured endpoint yields keyword matches (that is not an answer). Agents choose tools by description, and every missing sentence is another misuse.
4. **The tool count went from 16 to 18** (`repotory_wiki_search` / `repotory_wiki_read`), and `TestToolsRegistered`'s pinned list was updated — that list is nailed down, so a drift in tool count fails the test.
5. **Verification after the implementation exposed and fixed a retrieval gap: a punctuated Chinese question gathered no evidence at all.** On the first live run of `repotory_ask`, the answer was the model's general knowledge (ending with "the reply above is the model's own") instead of the local page — even though `SearchWikiPages(0, "时态图")` hit it. The cause sat in the shared `expandForFTS`: `isCJKRun` judges a punctuated sentence as non-CJK, so the whole sentence was emitted as one unmatchable phrase, the relaxation had a single term to OR, and gave up. **Chinese questions are mostly punctuation**, so this is exactly the shape `ask` exists for. The fix landed in `internal/db/search.go` (split at punctuation first, then judge each segment), so the notes path and the page path got better together. See implementation correction 5 of [ADR-0032](0032-approved-wiki-page-visibility.md).
   - **The gap made decision 2's safety net the common case rather than the exception**: the "this is the model's own reply" label saved the semantics honestly, but an `ask` tool that can never produce local sources has not wired up evidence-backed Q&A. After the fix, both MCP and the desktop were measured returning an evidence-backed answer with 12 sources.

## Verification

See "Verification record" at the end.

## Not doing (explicitly left blank)

- No streaming answers on the MCP side (the desktop has `AskAIWithEvidenceStream`, but it rides Wails events, and stdio MCP has no event channel).
- `repotory_ask` writes nothing (filing an answer as a page is a desktop human action — see `FileAnswerAsPage`).
- The MCP surface does not expose the raw model configuration (endpoints and keys are not the agent's business).
- `repotory_notes_search` is untouched (searching notes and todos is still a grep; its semantics ARE a search).

## Verification record

The measured record from the 2026-10-28 implementation.

### 1. Automated tests

| Where | Cases | Result |
|---|---|---|
| `cmd/mcp` (`tools_ask_test.go`) | 4 cases: an empty query is refused / **with no endpoint the fallback is explicitly labelled "not an answer"** / the wording when there is no endpoint and no hit / the query is still required | all green |
| `cmd/mcp` (`tools_wiki_test.go`) | 4 cases: wiki search finds approved pages / an empty query lists the approved pages / **the tools never expose an unapproved page** / wiki read returns the body | all green |
| `cmd/mcp` (`main_test.go`) | `TestToolsRegistered` pins the list of **18** tools — a drift in tool count turns the test red | all green |
| `go test ./...` | the whole repository | pass |

### 2. Live measurement: the desktop and MCP give the same answer with sources

TODO 1.5's acceptance criterion is "the desktop and MCP give an answer with sources for the same question". Both paths were given the same question:

```
MCP  repotory_ask(query="时态图是什么？为什么需要它？")
     → the reply, then a Sources list: [N2] note … [P3] page "ADR-0014…" [P4] note "ADR-0021:" …
       … [P12] page "ADR-0020: 社区摘要…", and it notes "(2 further match(es) omitted by the context budget)"

Desktop  AskAIWithEvidence(0, "时态图是什么？为什么需要它？")
     → 12 evidence items, the reply opening with the same "时态图是 **在 wiki_pages 表旁构建的 append-only 版本快照表…"
```

**The evidence count matches (12 = the `DefaultEvidenceBudget` cap) and the first source is the same ADR-0021 page.** That is not "the two look similar" — it is the same evidence produced by the same code; MCP and the desktop differ only in transport and rendering.

### 3. A retrieval gap found while verifying, and fixed (the same one as ADR-0032)

On the first live run of `repotory_ask`, the answer was the model's **general knowledge** (temporal diagrams in general, not the page this library holds), ending with:

```
_(no local knowledge matched this question; the reply above is the model's own)_
```

That label is decision 2's safety net doing its job — it honestly says "this did not come from the local library". But **the library plainly held that page** (`SearchWikiPages(0, "时态图")` hits it). The cause sat in the shared layer: `expandForFTS` decides "is this a CJK run?" with `isCJKRun`, and **punctuation is not CJK** — so the whole punctuated sentence was emitted as one unmatchable phrase, the relaxation had a single term to OR, and gave up.

**Chinese questions are mostly punctuation**, so this is precisely the input shape `ask` exists to handle. The fix landed in the shared `expandForFTS` (split at punctuation first, then judge each segment), so the notes path and the page path got better together. After the fix, both MCP and the desktop returned an evidence-backed answer with 12 sources (see 2).

### 4. What was NOT verified (recorded honestly)

- **The AI endpoint itself is unstable**: across five consecutive `repotory_ask` runs, one returned `error: AI endpoint returned no choices` — and the desktop path gets the same error for the same reason. **This is not a wiring difference**: both ends call the same `svc.AskAIWithEvidence`; it is the locally configured model endpoint occasionally returning empty choices. Decision 3 means exactly this: a configured endpoint that fails is reported as an error, with the text passed through as it is.
- **The "configured but failing → error, never a fallback" branch was not exercised live**: the live endpoint is configured, and the fallback branch is held by a unit test (`TestAskWithoutAIEndpointLabelsItsFallback`). Breaking the endpoint by hand and asking again would be the end-to-end confirmation.
- **The stdout contract of `repotory_ask` was only checked against this repository's own probe**: no third-party client (Claude Code / Cursor and the like) has read the resulting shape.
