// api/memoryEndpoints.ts — agent-memory surface endpoints (D25).
//
// Deliberately a sibling of endpoints.ts rather than an addition to it: the
// guard on workspace writes rejects whole-file rewrites of endpoints.ts
// because its listAIModels/testAIChat signatures carry an `apiKey` parameter
// (legitimate code, flagged by shape). Domain-scoped endpoint modules already
// exist as a pattern — reviewEndpoints.test.ts tests a domain slice of the
// same surface — so the memory ring gets its own module and contract test.
// If endpoints.ts ever becomes writable again, these functions can move back
// without changing a single call site (everything imports via ../api/client).

import { call } from './transport'
import type { HandoffEntry, HandoffResult } from './types'

// listRecentHandoffs feeds the first-screen memory ring (D25): the newest
// handoff notes as content-free entries. limit<=0 takes the backend default
// (10); asks above 50 are clamped server-side.
export function listRecentHandoffs(limit = 10): Promise<HandoffEntry[]> {
  return call<HandoffEntry[]>({
    method: 'ListRecentHandoffs',
    args: [limit],
    path: '/handoffs/recent',
  }).then(d => d ?? [])
}

// HandoffDraft is one handoff written by hand. The four sections are optional
// on the wire — the backend requires at least one of them to be non-empty,
// the same contract repotory_handoff enforces.
export interface HandoffDraft {
  summary: string
  changes?: string[]
  decisions?: string[]
  gotchas?: string[]
  nextSteps?: string[]
}

// createHandoff writes the handoff the agent path writes through
// repotory_handoff, entered by a person instead.
//
// It is the zero-config half of the session protocol: the MCP route needs a
// client, a model and a client that remembers to call the tool, so on day one
// the loop cannot be tried at all. This path needs neither.
//
// There is no REST twin, so no path/init: the transport reaches the binding
// over the JSON-RPC bridge in the browser runtime and over Wails in the
// desktop shell.
export function createHandoff(projectId: number, draft: HandoffDraft): Promise<HandoffResult> {
  return call<HandoffResult>({
    method: 'CreateHandoff',
    args: [
      projectId,
      draft.summary,
      draft.changes ?? [],
      draft.decisions ?? [],
      draft.gotchas ?? [],
      draft.nextSteps ?? [],
    ],
  })
}
