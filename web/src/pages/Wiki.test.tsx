// @vitest-environment jsdom
// Wiki.test.tsx — the /wiki browse surface (ADR-0032).
//
// What this pins:
//   - only approved pages are listed (the backend refuses anything else, and
//     this page never asks for anything else);
//   - a global page is LABELLED — it is visible inside a project scope
//     (ADR-0031), and without the label that reads as a filter that leaked;
//   - the scope selector carries the evidence path's scope, not the review
//     queue's: a project means "that project's pages PLUS the global ones";
//   - a failed load shows an error instead of pretending the library is empty.

import { describe, expect, it, vi, beforeEach, beforeAll } from 'vitest'
import { screen, waitFor, fireEvent, render } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import i18n from '../i18n' // real i18next instance — otherwise t() returns raw keys

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return {
    ...actual,
    browseWikiPages: vi.fn(),
    searchWikiPages: vi.fn(),
    getProjects: vi.fn(),
  }
})

import { browseWikiPages, searchWikiPages, getProjects, type Project, type WikiPageSummary } from '../api/client'
import Wiki from './Wiki'

const mockBrowse = vi.mocked(browseWikiPages)
const mockSearch = vi.mocked(searchWikiPages)
const mockProjects = vi.mocked(getProjects)

const summary = (over: Partial<WikiPageSummary> = {}): WikiPageSummary => ({
  id: 1,
  slug: 'gateway-design',
  title: '网关设计',
  kind: 'concept',
  project_id: 0,
  updated_at: '2026-10-21 10:00:00',
  snippet: '网关的总体设计。',
  ...over,
})

const project = (over: Partial<Project> = {}): Project => ({
  id: 1,
  name: 'repotory',
  root_path: '/code/repotory',
  level_override: 0,
  is_auto_grouped: false,
  is_starred: false,
  created_at: '2026-10-01',
  repo_count: 2,
  total_added: 0,
  total_deleted: 0,
  my_added: 0,
  my_deleted: 0,
  my_files: 0,
  my_added_7d: 0,
  is_workday: true,
  below_standard: false,
  ...over,
})

// The URL is part of the contract (?q= / ?project= are the deep-link
// surface), so the tests need to be able to read it.
function LocationProbe() {
  const loc = useLocation()
  return <span data-testid="location">{loc.pathname + loc.search}</span>
}

function renderWiki(initial = '/wiki') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <LocationProbe />
      <Wiki />
    </MemoryRouter>,
  )
}

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
})

beforeEach(() => {
  vi.clearAllMocks()
  mockBrowse.mockResolvedValue([])
  mockSearch.mockResolvedValue([])
  mockProjects.mockResolvedValue([project({ id: 7, name: 'repotory' })])
})

describe('the /wiki browse surface (ADR-0032)', () => {
  it('lists the approved pages with the scope of each one', async () => {
    mockBrowse.mockResolvedValue([
      summary({ id: 2, slug: 'b', title: 'B 页', project_id: 7 }),
      summary({ id: 1, slug: 'a', title: 'A 页', project_id: 0 }),
    ])
    renderWiki()

    expect(await screen.findByText('A 页')).toBeTruthy()
    expect(screen.getByText('B 页')).toBeTruthy()
    // The global page says so; the project page says which project.
    const rows = screen.getAllByRole('link')
    const globalRow = rows.find(l => l.textContent?.includes('A 页'))
    const projectRow = rows.find(l => l.textContent?.includes('B 页'))
    expect(globalRow?.textContent).toContain('全局')
    expect(projectRow?.textContent).toContain('repotory')
    expect(globalRow?.textContent).not.toContain('repotory')
    // No scope picked -> every approved page.
    expect(mockBrowse).toHaveBeenCalledWith(0, 100)
  })

  it('asks the backend for a search once a query is typed', async () => {
    mockSearch.mockResolvedValue([summary({ id: 3, title: '命中页' })])
    renderWiki()

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '网关' } })

    await waitFor(() => expect(mockSearch).toHaveBeenCalledWith(0, '网关', 50), { timeout: 2000 })
    expect(await screen.findByText('命中页')).toBeTruthy()
  })

  it('narrows to a project scope — and the URL carries it', async () => {
    renderWiki()
    await waitFor(() => expect(mockBrowse).toHaveBeenCalled())

    fireEvent.change(screen.getByLabelText('作用域'), { target: { value: '7' } })

    await waitFor(() => expect(mockBrowse).toHaveBeenCalledWith(7, 100), { timeout: 2000 })
    await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('project=7'))
  })

  it('mirrors the query into the URL', async () => {
    mockSearch.mockResolvedValue([summary({ id: 3, title: '命中页' })])
    renderWiki()

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '网关' } })
    await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('q='), { timeout: 2000 })
  })

  it('adopts the query from a deep link instead of searching for nothing', async () => {
    mockSearch.mockResolvedValue([summary({ id: 3, title: '命中页' })])
    // The deep link is the only entry point that carries the query, so a cold
    // entry with ?q= must search for it — not for the empty query.
    renderWiki('/wiki?q=' + encodeURIComponent('网关'))

    await waitFor(() => expect(mockSearch).toHaveBeenCalledWith(0, '网关', 50), { timeout: 2000 })
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('网关')
  })

  it('says the library is empty instead of showing a bare list', async () => {
    renderWiki()
    expect(await screen.findByText('还没有已批准的知识页')).toBeTruthy()
  })

  it('distinguishes "no match" from "no pages"', async () => {
    mockSearch.mockResolvedValue([])
    renderWiki()

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '不存在的词' } })
    await waitFor(() => expect(mockSearch).toHaveBeenCalled(), { timeout: 2000 })
    expect(await screen.findByText('没有匹配的知识页')).toBeTruthy()
    expect(screen.queryByText('还没有已批准的知识页')).toBeNull()
  })

  it('shows the failure instead of pretending the library is empty', async () => {
    mockBrowse.mockRejectedValue(new Error('network down'))
    renderWiki()

    expect(await screen.findByText('network down')).toBeTruthy()
    expect(screen.queryByText('还没有已批准的知识页')).toBeNull()
  })
})
