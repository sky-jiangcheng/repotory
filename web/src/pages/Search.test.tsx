// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useEffect } from 'react'
import { screen, waitFor, fireEvent, within, render, act } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router-dom'
import { renderReady, settle } from '../test/renderReady'

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return {
    ...actual,
    searchAll: vi.fn(),
    getProjects: vi.fn(),
    listAllTags: vi.fn(),
  }
})

// Same stable-t convention as Home.test.tsx: components pass defaultValue
// inline, so the mock returns it verbatim (namespace prefixes are irrelevant
// under this mock).
const mockT = (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT }),
}))

import { searchAll, getProjects, listAllTags, type Project, type SearchHit } from '../api/client'
import Search from './Search'
import { invalidateCache } from '../hooks/useApiData'

const mockSearch = vi.mocked(searchAll)
const mockGetProjects = vi.mocked(getProjects)
const mockListAllTags = vi.mocked(listAllTags)

// A router handle for the in-app navigation case: the deep link has to work
// while the page is already mounted, not only on a cold entry.
function NavHandle({ navRef }: { navRef: { current: ((to: string) => void) | null } }) {
  const navigate = useNavigate()
  useEffect(() => { navRef.current = navigate }, [navigate, navRef])
  return null
}

const project = (over: Partial<Project>): Project => ({
  id: 1,
  name: 'Alpha',
  root_path: '/a',
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

// renderReady (ADR-0026): the result regions are mounted from `hits`, which only
// exists after the effect's promise resolves.
const renderSearch = async (initial = '/search') => {
  await renderReady(<Search />, { initialEntries: [initial] })
}

// useApiData's module-level cache (keyed 'projects:all' / 'tags:all') survives
// across tests in this file — bust it so every case mounts cold.
beforeEach(() => {
  vi.clearAllMocks()
  invalidateCache()
  mockSearch.mockResolvedValue([])
  mockGetProjects.mockResolvedValue([])
  mockListAllTags.mockResolvedValue([])
})

describe('Search page (ADR-0024 top-level global search)', () => {
  it('idle state recommends hot projects ranked by 7-day personal additions, starred as tiebreaker', async () => {
    mockGetProjects.mockResolvedValue([
      project({ id: 1, name: 'Quiet', my_added_7d: 0, is_starred: false }),
      project({ id: 2, name: 'Busy', my_added_7d: 120, is_starred: false }),
      project({ id: 3, name: 'Starred', my_added_7d: 0, is_starred: true }),
      // Yesterday had no personal commits at all (my_added 0 across the board),
      // but the 7-day window still separates them — the regression this guards.
      project({ id: 4, name: 'RecentOnly', my_added: 0, my_added_7d: 40, is_starred: false }),
    ])
    await renderSearch()
    expect(await screen.findByText('Busy')).toBeTruthy()
    // my_added_7d desc first; the starred project outranks the zero-activity tie.
    const hrefs = screen.getAllByRole('link').map(l => l.getAttribute('href'))
    expect(hrefs[0]).toBe('/project/2')
    expect(hrefs[1]).toBe('/project/4')
    expect(hrefs[2]).toBe('/project/3')
    expect(hrefs[3]).toBe('/project/1')
    // Idle is recommendations, not a search round-trip.
    expect(mockSearch).not.toHaveBeenCalled()
  })

  it('renders hot tag chips that fill the input and trigger the search', async () => {
    mockListAllTags.mockResolvedValue(['登录排查', '架构'])
    await renderSearch()
    const chip = await screen.findByRole('button', { name: '登录排查' })
    fireEvent.click(chip)
    // Chip click sets the query; the debounced effect fires searchAll.
    await waitFor(() => expect(mockSearch).toHaveBeenCalledWith('登录排查'), { timeout: 2000 })
  })

  it('searches (debounced) and groups note/todo hits under labelled regions', async () => {
    mockSearch.mockResolvedValue([
      { type: 'note', id: 5, project_id: 2, project_name: 'Alpha', title: '登录排查笔记', snippet: '关于 <mark>登录</mark> 的记录', updated_at: '2026-10-12 10:00:00' },
      { type: 'todo', id: 9, project_id: 3, project_name: 'Beta', title: '修复登录超时', snippet: '', updated_at: '2026-10-12 10:00:00' },
    ] satisfies SearchHit[])
    await renderSearch()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '登录' } })
    await waitFor(() => expect(mockSearch).toHaveBeenCalledWith('登录'), { timeout: 2000 })
    const notes = await screen.findByRole('region', { name: '笔记' })
    const todos = screen.getByRole('region', { name: '待办' })
    expect(within(notes).getByText('登录排查笔记')).toBeTruthy()
    expect(within(todos).getByText('修复登录超时')).toBeTruthy()
    // Both hit types use the shared global type-badge classes.
    // 断言对象就是 class 本身（两类徽章共用全局样式派生），可访问树里没有对应语义可查
    // ——ADR-0026 条件 4 的显式登记，不是疏漏。
    // eslint-disable-next-line testing-library/no-node-access
    expect(document.querySelector('.hit-type-note')).not.toBeNull()
    // eslint-disable-next-line testing-library/no-node-access
    expect(document.querySelector('.hit-type-todo')).not.toBeNull()
  })

  it('shows project-name matches under the projects group', async () => {
    mockGetProjects.mockResolvedValue([project({ id: 7, name: 'repotory-core', my_added: 30 })])
    await renderSearch()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'repotory' } })
    await waitFor(() => expect(mockSearch).toHaveBeenCalledWith('repotory'), { timeout: 2000 })
    const group = await screen.findByRole('region', { name: '项目' })
    expect(group.textContent).toContain('repotory-core')
  })

  it('pre-fills and searches from the ?q= deep link', async () => {
    mockSearch.mockResolvedValue([
      { type: 'note', id: 5, project_id: 2, project_name: 'Alpha', title: '登录排查笔记', snippet: '', updated_at: '2026-10-12 10:00:00' },
    ] satisfies SearchHit[])
    await renderSearch('/search?q=登录')
    expect(await screen.findByText('登录排查笔记')).toBeTruthy()
    expect(mockSearch).toHaveBeenCalledWith('登录')
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('登录')
  })

  // A deep link that arrives while the page is already mounted used to be
  // ignored: the query was read once at mount, so the input kept the old
  // value and the effect below wrote that old value back to the URL — the
  // link looked applied and searched for something else.
  it('adopts an in-app ?q= deep link instead of keeping the old query', async () => {
    const navRef: { current: ((to: string) => void) | null } = { current: null }
    render(
      <MemoryRouter initialEntries={['/search']}>
        <NavHandle navRef={navRef} />
        <Search />
      </MemoryRouter>,
    )
    await settle()

    act(() => { navRef.current?.('/search?q=登录') })

    await waitFor(() => expect(mockSearch).toHaveBeenCalledWith('登录'), { timeout: 2000 })
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('登录')
  })

  it('shows the no-results message when nothing matches', async () => {
    await renderSearch()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '不存在' } })
    await waitFor(() => expect(mockSearch).toHaveBeenCalledWith('不存在'), { timeout: 2000 })
    // The text renders twice (visible message + aria-live mirror), so assert
    // on the list instead of findByText, which throws on multiple matches.
    const msgs = await screen.findAllByText('没有匹配的结果')
    expect(msgs.length).toBeGreaterThan(0)
  })

  // The old catch collapsed failure into "no results": a downed local service
  // read as an empty corpus, which is the one interpretation a user must never
  // make on a local-first tool.
  it('a failed search shows the error instead of pretending the corpus is empty', async () => {
    mockSearch.mockRejectedValue(new Error('network down'))
    await renderSearch()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '登录' } })
    await waitFor(() => expect(mockSearch).toHaveBeenCalledWith('登录'), { timeout: 2000 })
    // Renders twice (visible row + aria-live mirror) — assert on the list.
    const errs = await screen.findAllByText('检索失败——请确认本地服务在运行后重试')
    expect(errs.length).toBeGreaterThan(0)
    expect(screen.queryAllByText('没有匹配的结果')).toHaveLength(0)
  })

  it('shows a loading indicator while the search is in flight, gone once settled', async () => {
    let resolveSearch!: (v: SearchHit[]) => void
    mockSearch.mockReturnValue(new Promise(resolve => { resolveSearch = resolve }))
    await renderSearch()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '登录' } })
    // Covers both the 150ms debounce and the request itself: the flag flips in
    // the effect body, not only when the promise is pending.
    expect(await screen.findByText('正在检索…')).toBeTruthy()
    resolveSearch([
      { type: 'note', id: 5, project_id: 2, project_name: 'Alpha', title: '登录排查笔记', snippet: '', updated_at: '2026-10-12 10:00:00' },
    ] satisfies SearchHit[])
    await screen.findByText('登录排查笔记')
    expect(screen.queryByText('正在检索…')).toBeNull()
  })
})
