// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent, within } from '@testing-library/react'
import { lagged, renderReady } from '../test/renderReady'

// Partial mock: override the backend-calling endpoints, keep everything else
// (getConnectionKind etc.) real — same shape as Home.test.tsx.
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return {
    ...actual,
    getProjects: vi.fn(),
    listPendingWikiPages: vi.fn(),
    listRejectedWikiPages: vi.fn(),
    listCompileJobs: vi.fn(),
    findMergeCandidates: vi.fn(),
    mergeWikiPages: vi.fn(),
    runCommunitySummary: vi.fn(),
    listWikiPageVersions: vi.fn(),
    diffWikiPageVersion: vi.fn(),
    approveWikiPage: vi.fn(),
    rejectWikiPage: vi.fn(),
    startCompileJob: vi.fn(),
    startLintJob: vi.fn(),
    cancelCompileJob: vi.fn(),
    deleteCompiledPage: vi.fn(),
  }
})

// Same stable-t convention as Home.test.tsx: components pass defaultValue inline,
// so the mock returns it verbatim and every other call yields its own key —
// asserting on 'review.mergeAdopt' still works after the i18n gap closes.
const mockT = (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT }),
}))

import {
  approveWikiPage, cancelCompileJob, deleteCompiledPage, diffWikiPageVersion, findMergeCandidates,
  getProjects, listCompileJobs, listPendingWikiPages, listRejectedWikiPages, listWikiPageVersions,
  mergeWikiPages, rejectWikiPage, runCommunitySummary, startCompileJob, startLintJob,
  type MergeCandidate, type MergeCandidateReport, type WikiCommunityReport,
  type WikiPageVersion, type WikiPendingPage,
} from '../api/client'
import ReviewPage from './Review'

const mockGetProjects = vi.mocked(getProjects)
const mockListPending = vi.mocked(listPendingWikiPages)
const mockListRejected = vi.mocked(listRejectedWikiPages)
const mockListJobs = vi.mocked(listCompileJobs)
const mockFindCandidates = vi.mocked(findMergeCandidates)
const mockMerge = vi.mocked(mergeWikiPages)
const mockCommunity = vi.mocked(runCommunitySummary)
const mockListVersions = vi.mocked(listWikiPageVersions)
const mockDiff = vi.mocked(diffWikiPageVersion)

const pendingPage = (over: Partial<WikiPendingPage> = {}): WikiPendingPage => ({
  page: {
    id: 11, slug: 'payment-gateway', title: '支付网关', kind: 'concept', project_id: 4,
    content: '正文', updated_at: '2026-10-12 15:04:05', status: 'pending', source: 'compiler',
  },
  source_note_ids: [],
  out_links: [],
  in_links: [],
  ...over,
})

const candidate = (over: Partial<MergeCandidate> = {}): MergeCandidate => ({
  winner_id: 11, winner_slug: 'payment-gateway', loser_id: 3, loser_slug: 'gateway-payment',
  score: 7, signals: ['shared-notes', 'title-overlap'], shared_notes: 2, project_id: 4,
  ...over,
})

const report = (over: Partial<MergeCandidateReport> = {}): MergeCandidateReport => ({
  project_id: 4, pages: 12, pairs_scored: 9, pairs_possible: 66,
  candidates: [candidate()], truncated: false,
  ...over,
})

const pageVersion = (over: Partial<WikiPageVersion> = {}): WikiPageVersion => ({
  id: 71, page_id: 11, title: '支付网关', content: 'old', kind: 'concept',
  source: 'compiler', created_at: '2026-10-11 09:30:00',
  ...over,
})

const communityReport = (over: Partial<WikiCommunityReport> = {}): WikiCommunityReport => ({
  project_id: 4, approved_pages: 20, edges: 31, communities_found: 3, dropped_small: 1,
  dropped_large: 0, isolated: 2, rounds: 4, converged: true,
  pages_created: 2, pages_updated: 1, documents_linked: 9, notes_attached: 5,
  revision_todos: 1, empty_bodies: 0, summarized_slugs: [], skipped_by_budget: [],
  outbound_bytes: 4321, calls: 3, community_gate_off: false, run_at: '2026-10-12T15:04:05Z',
  elapsed_ms: 812,
  ...over,
})

// renderReady (ADR-0026) — the page fills its queues from a Promise.all inside a
// useEffect, so returning before that settles is how this file used to flake.
const renderReview = async () => { await renderReady(<ReviewPage />) }

// The project filter renders one <option> per entry of `projects`, and that
// state only lands after the load effect's getProjects() promise resolves. So
// the combobox is queryable a render before the option it needs to accept:
// jsdom matches an assigned value against the options present at that moment,
// finds none, and hands the change handler an empty value — Number('') is 0,
// so projectFilter never leaves 0 and React writes '0' straight back onto the
// controlled node. Every project-gated button then stays disabled, and the
// failure surfaces far from its cause as `expected true to be false` on a
// button assertion. Which render wins that race tracked runner load, not
// product behaviour, so await the option first; the value check keeps a
// recurrence pointing at the select instead of at a downstream timeout.
async function pickProject(id: number, name: string) {
  await screen.findByRole('option', { name })
  const select = (await screen.findByRole(
    'combobox', { name: 'review.projectFilter' },
  )) as HTMLSelectElement
  fireEvent.change(select, { target: { value: String(id) } })
  await waitFor(() => expect(select.value).toBe(String(id)))
}

// The merge-suggestion <section> carries no accessible name (just an <h2>), and a
// document-wide `listitem` query would also count the pending and rejected card
// lists — so these tests must scope to the container before counting rows.
//
// 一条实测事实：`no-node-access` 在调用点上会报同样的 `heading.closest('section')`，
// 挪进函数后却完全不报。规则是看上下文的，这正是它只能当形态守卫、不能当时序保证的
// 又一个理由（ADR-0026 条件 4）。此处不需要 disable 注释——写了反而会被报成
// unused override。
async function mergeSection(): Promise<HTMLElement> {
  const heading = await screen.findByText('review.mergeHeading')
  return heading.closest('section') as HTMLElement
}

function mergeRows(section: HTMLElement): HTMLLIElement[] {
  return Array.from(section.querySelectorAll('li'))
}

beforeEach(() => {
  vi.clearAllMocks()
  // The three promises ADR-0026 names as this page's load path. Under
  // REPO_TEST_LAG_MS they land late on purpose — that is the promotion-criterion-1
  // probe, and it is a no-op on every ordinary run.
  mockGetProjects.mockImplementation(() => lagged([]))
  mockListPending.mockImplementation(() => lagged([]))
  mockListRejected.mockResolvedValue([])
  mockListJobs.mockResolvedValue([])
  mockFindCandidates.mockImplementation(() => lagged(report({ candidates: [] })))
  mockMerge.mockResolvedValue(null)
  mockCommunity.mockResolvedValue(communityReport())
  mockListVersions.mockResolvedValue([])
  mockDiff.mockResolvedValue('')
})

describe('Review merge suggestions (ADR-0019)', () => {
  it('renders each candidate as a directed pair, loser first', async () => {
    mockFindCandidates.mockImplementation(() => lagged(report({
      candidates: [
        candidate(),
        candidate({
          winner_id: 12, winner_slug: 'quota-sync', loser_id: 9, loser_slug: 'quota-refresh',
          score: 4, signals: ['linked'], shared_notes: 0,
        }),
      ],
    })))
    await renderReview()
    const section = await mergeSection()
    // A1 (ADR-0026): the merge section is mounted unconditionally, so `await`ing
    // its heading waits for nothing — the rows are the data. With
    // REPO_TEST_LAG_MS set, the old synchronous read here ran one render early
    // and saw zero rows.
    await waitFor(() => expect(mergeRows(section)).toHaveLength(2))
    const rows = mergeRows(section)
    expect(rows).toHaveLength(2)
    // Direction is the row's whole payload: [[loser]] → [[winner]]. The loser's
    // slug must come BEFORE the winner's, or a reviewer reading top-down would
    // absorb the wrong page.
    expect(rows[0].textContent).toMatch(/gateway-payment.*→.*payment-gateway/)
    expect(rows[1].textContent).toMatch(/quota-refresh.*→.*quota-sync/)
    // Signals and score are the "why" the structural pass is allowed to claim.
    expect(rows[0].textContent).toContain('shared-notes')
    expect(rows[0].textContent).toContain('title-overlap')
    expect(rows[1].textContent).not.toContain('title-overlap')
    // shared_notes is emitted only when non-zero — a "0 shared notes" chip is noise.
    expect(rows[0].textContent).toContain('review.mergeSharedNotes')
    expect(rows[1].textContent).not.toContain('review.mergeSharedNotes')
    expect(screen.getAllByText('review.mergeAdopt')).toHaveLength(2)
  })

  it('asks for confirmation before merging: the first click fires no call', async () => {
    mockFindCandidates.mockResolvedValue(report())
    mockMerge.mockResolvedValue({
      loser_id: 3, loser_slug: 'gateway-payment', winner_id: 11, winner_slug: 'payment-gateway',
      edges_redirected: 2, edges_dropped: 0, notes_reattached: 3, loser_previous_status: 'approved',
    })
    await renderReview()
    const adopt = await screen.findByText('review.mergeAdopt')
    fireEvent.click(adopt)
    // Armed, not executed — a merge destroys the loser's content, so one click
    // is never enough (and no modal library is involved).
    expect(mockMerge).not.toHaveBeenCalled()
    expect(adopt.textContent).toBe('review.mergeConfirm')
    fireEvent.click(screen.getByText('review.mergeConfirm'))
    await waitFor(() => expect(mockMerge).toHaveBeenCalledWith(3, 11))
    // Loser first: the binding's argument order is (loserID, winnerID) and the
    // Wails layer resolves positionally.
    expect(mockMerge.mock.calls[0][0]).toBe(3)
    expect(mockMerge.mock.calls[0][1]).toBe(11)
  })

  it('hides a dismissed pair locally without calling anything', async () => {
    mockFindCandidates.mockImplementation(() => lagged(report()))
    await renderReview()
    const section = await mergeSection()
    // A1 (ADR-0026): the heading is mounted unconditionally, so waiting for it
    // proves nothing about the rows — wait for the row itself.
    await waitFor(() => expect(mergeRows(section)).toHaveLength(1))
    fireEvent.click(within(section).getByText('review.mergeIgnore'))
    await waitFor(() => expect(mergeRows(section)).toHaveLength(0))
    // Ignoring is a view-local filter: nothing is sent anywhere, and nothing is
    // stored — no endpoint exists to record it, by design.
    expect(mockMerge).not.toHaveBeenCalled()
    expect(section.textContent).toContain('review.emptyMergeTitle')
  })

  it('degrades a null candidate report to the empty state instead of throwing', async () => {
    // The endpoint normalises null to an empty report, but the page is the last
    // line: a report that arrives null must still render the queue, not a crash.
    mockFindCandidates.mockImplementation(() => lagged(null as unknown as MergeCandidateReport))
    mockListPending.mockImplementation(() => lagged([pendingPage()]))
    await renderReview()
    expect(await screen.findByText('review.mergeHeading')).toBeTruthy()
    // A1 (ADR-0026): the empty-merge title and the pending row are both
    // effect-filled, while the heading is not — await one of the data elements
    // before reading the rest synchronously.
    expect(await screen.findByText('payment-gateway')).toBeTruthy()
    expect(screen.getByText('review.emptyMergeTitle')).toBeTruthy()
    // The rest of the page survived the null too.
    expect(screen.getByText('review.pendingHeading')).toBeTruthy()
  })

  it('says when the list was truncated', async () => {
    mockFindCandidates.mockResolvedValue(report({ truncated: true }))
    await renderReview()
    expect(await screen.findByText('review.mergeTruncated')).toBeTruthy()
  })
})

describe('Review community synthesis (ADR-0020)', () => {
  it('is disabled on "all projects", because project 0 is the global tier', async () => {
    await renderReview()
    const button = (await screen.findByText('review.startCommunity')) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    // The reason is stated, not implied by a greyed control.
    expect(button.getAttribute('title')).toBe('review.communityNeedsProject')
    fireEvent.click(button)
    expect(mockCommunity).not.toHaveBeenCalled()
  })

  it('runs for a selected project and reports the counters it got back', async () => {
    mockGetProjects.mockResolvedValue([{
      id: 4, name: 'Alpha', root_path: '/x', level_override: 0, is_auto_grouped: false,
      is_starred: false, created_at: '', repo_count: 1, total_added: 0, total_deleted: 0,
      my_added: 0, my_deleted: 0, my_files: 0, is_workday: false, below_standard: false,
    }])
    mockCommunity.mockResolvedValue(communityReport())
    await renderReview()
    await pickProject(4, 'Alpha')
    const button = (await screen.findByText('review.startCommunity')) as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)
    await waitFor(() => expect(mockCommunity).toHaveBeenCalledWith(4))
    expect(await screen.findByText('review.communityHeading')).toBeTruthy()
    // The counters stay on screen after the toast expires — a paid-for run whose
    // evidence vanishes in five seconds is not evidence.
    expect(screen.getByText('review.communityPagesCreated')).toBeTruthy()
    expect(screen.getByText('review.communityOutbound')).toBeTruthy()
  })

  it('surfaces the backend note verbatim when the gate is off', async () => {
    mockGetProjects.mockResolvedValue([{
      id: 4, name: 'Alpha', root_path: '/x', level_override: 0, is_auto_grouped: false,
      is_starred: false, created_at: '', repo_count: 1, total_added: 0, total_deleted: 0,
      my_added: 0, my_deleted: 0, my_files: 0, is_workday: false, below_standard: false,
    }])
    mockCommunity.mockResolvedValue(communityReport({
      community_gate_off: true, pages_created: 0, pages_updated: 0, documents_linked: 0,
      revision_todos: 0, empty_bodies: 0, outbound_bytes: 0,
      llm_note: '未开启（wiki_community）：只做了结构检测',
    }))
    await renderReview()
    await pickProject(4, 'Alpha')
    const button = (await screen.findByText('review.startCommunity')) as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)
    await screen.findByText('review.communityHeading')
    expect(screen.getByText('未开启（wiki_community）：只做了结构检测')).toBeTruthy()
    expect(screen.queryByText('review.communityPagesCreated')).toBeNull()
    expect(screen.getByText('review.communityGateOffNote')).toBeTruthy()
  })
})

describe('Review page version history (ADR-0021)', () => {
  it('opens the history and renders the diff of a snapshot', async () => {
    mockListPending.mockResolvedValue([pendingPage()])
    mockListVersions.mockResolvedValue([
      pageVersion(),
      pageVersion({ id: 70, created_at: '2026-10-09 12:00:00' }),
    ])
    mockDiff.mockResolvedValue('--- a/payment-gateway\n+++ b/payment-gateway\n-旧结论\n+新结论')
    await renderReview()
    const toggle = await screen.findByText('review.versionHistory')
    fireEvent.click(toggle)
    await waitFor(() => expect(mockListVersions).toHaveBeenCalledWith(11))
    expect(await screen.findByText('review.versionListTitle')).toBeTruthy()
    expect(screen.getByText('2026-10-11 09:30:00')).toBeTruthy()
    fireEvent.click(screen.getByText('2026-10-09 12:00:00'))
    await waitFor(() => expect(mockDiff).toHaveBeenCalledWith(11, 70))
    // The shared DiffViewer colours the +/- lines; here the raw text is enough to
    // prove the page renders the backend's unified text rather than a summary.
    expect(await screen.findByText('+新结论')).toBeTruthy()
    expect(screen.getByText('-旧结论')).toBeTruthy()
  })

  it('says so when a page has no snapshots', async () => {
    mockListPending.mockResolvedValue([pendingPage()])
    mockListVersions.mockResolvedValue([])
    await renderReview()
    fireEvent.click(await screen.findByText('review.versionHistory'))
    expect(await screen.findByText('review.versionEmpty')).toBeTruthy()
    expect(mockDiff).not.toHaveBeenCalled()
  })
})

// The card list is the page's reason to exist; these two guard the wiring the
// new sections share with it (busy-gating and the approve call).
describe('Review queue wiring', () => {
  it('approves through the binding and reloads the queue', async () => {
    mockListPending.mockResolvedValue([pendingPage()])
    await renderReview()
    fireEvent.click(await screen.findByText('review.approve'))
    await waitFor(() => expect(mockListPending).toHaveBeenCalledWith(0))
    await waitFor(() => expect(approveWikiPage).toHaveBeenCalledWith(11))
    // A reload followed the approve: pending was called at least twice.
    await waitFor(() => expect(mockListPending.mock.calls.length).toBeGreaterThan(1))
  })

  it('starts a compile with the capped note budget', async () => {
    mockGetProjects.mockResolvedValue([{
      id: 4, name: 'Alpha', root_path: '/x', level_override: 0, is_auto_grouped: false,
      is_starred: false, created_at: '', repo_count: 1, total_added: 0, total_deleted: 0,
      my_added: 0, my_deleted: 0, my_files: 0, is_workday: false, below_standard: false,
    }])
    await renderReview()
    await pickProject(4, 'Alpha')
    const button = (await screen.findByText('review.startCompile')) as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)
    await waitFor(() => expect(startCompileJob).toHaveBeenCalledWith(4, 10))
    expect(startLintJob).not.toHaveBeenCalled()
    expect(cancelCompileJob).not.toHaveBeenCalled()
    expect(deleteCompiledPage).not.toHaveBeenCalled()
    expect(rejectWikiPage).not.toHaveBeenCalled()
  })
})
