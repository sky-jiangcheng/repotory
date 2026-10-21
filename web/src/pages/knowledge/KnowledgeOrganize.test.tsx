// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import { renderReady } from '../../test/renderReady'
import type { Project } from '../../api/client'

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>()
  return {
    ...actual,
    listOrganizeGroups: vi.fn(),
    reassignLandingNotes: vi.fn(),
    deleteLandingProject: vi.fn(),
    getProjects: vi.fn(),
  }
})

// Interpolate {{placeholders}} so an assertion can name a real project; the
// component passes real values in `opts`, and the defaultValue carries the
// template.
const mockT = (key: string, opts?: { defaultValue?: string; [k: string]: unknown }) => {
  const text = opts?.defaultValue ?? key
  return text.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(opts?.[name] ?? ''))
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT }),
}))

const mockToast = vi.fn()
vi.mock('../../hooks/useToast', () => ({
  useToast: () => mockToast,
}))

import {
  listOrganizeGroups, reassignLandingNotes, deleteLandingProject, getProjects,
  type OrganizeGroup,
} from '../../api/client'
import KnowledgeOrganize, { nestingParent } from './KnowledgeOrganize'

const mockListGroups = vi.mocked(listOrganizeGroups)
const mockReassign = vi.mocked(reassignLandingNotes)
const mockDelete = vi.mocked(deleteLandingProject)
const mockGetProjects = vi.mocked(getProjects)

const group = (over: Partial<OrganizeGroup> = {}): OrganizeGroup => ({
  project_id: 1,
  name: 'bucket',
  root_path: '/docs/bucket',
  kind: 'import_placeholder',
  note_count: 1,
  repo_bound: true,
  ...over,
})

const realProject = (over: Partial<Project> = {}): Project => ({
  id: 10,
  name: 'Real Project',
  root_path: '/code/real',
  project_kind: 'scanned',
  repo_count: 1,
  ...over,
} as Project)

beforeEach(() => {
  vi.clearAllMocks()
  mockGetProjects.mockResolvedValue([realProject()])
})

describe('nestingParent', () => {
  const parent = group({ project_id: 1, name: '富港科技资料', root_path: '/Documents/富港科技资料' })

  it('finds the immediate container', () => {
    const child = group({ project_id: 2, name: 'Fund账户绑定PI', root_path: '/Documents/富港科技资料/Fund账户绑定PI' })
    expect(nestingParent([parent, child], child)?.project_id).toBe(1)
  })

  it('returns undefined for a top-level bucket', () => {
    expect(nestingParent([parent], parent)).toBeUndefined()
  })

  it('prefers the longest matching ancestor, not the first one', () => {
    const mid = group({ project_id: 2, name: 'mid', root_path: '/Documents/富港科技资料/mid' })
    const child = group({ project_id: 3, name: 'child', root_path: '/Documents/富港科技资料/mid/child' })
    expect(nestingParent([parent, mid, child], child)?.project_id).toBe(2)
  })

  it('does not treat a sibling with a shared prefix as a container', () => {
    // "/docs/bucket2" starts with "/docs/bucket" as a string but is not inside it.
    const other = group({ project_id: 2, name: 'bucket2', root_path: '/docs/bucket2' })
    expect(nestingParent([group({ root_path: '/docs/bucket' }), other], other)).toBeUndefined()
  })
})

describe('KnowledgeOrganize', () => {
  it('names the container of a nested placeholder', async () => {
    mockListGroups.mockResolvedValue([
      group({ project_id: 1, name: '富港科技资料', root_path: '/Documents/富港科技资料' }),
      group({
        project_id: 2,
        name: 'Fund账户绑定PI',
        root_path: '/Documents/富港科技资料/Fund账户绑定PI',
      }),
    ])

    renderReady(<KnowledgeOrganize />)

    // The container qualifier is what makes the nesting legible.
    await waitFor(() => {
      expect(screen.getByText('位于 富港科技资料 内')).toBeTruthy()
    })
  })

  it('reports what a reassign moved, and offers to drop the emptied shell', async () => {
    mockListGroups.mockResolvedValue([
      group({ project_id: 1, name: 'CodeStat', note_count: 11 }),
    ])
    mockReassign.mockResolvedValue(11)

    renderReady(<KnowledgeOrganize />)

    const select = await screen.findByRole('combobox')
    fireEvent.change(select, { target: { value: '10' } })

    const button = screen.getByText('归口')
    ;(button as HTMLButtonElement).click()

    await waitFor(() => {
      expect(mockReassign).toHaveBeenCalledWith(1, 10)
    })
    await waitFor(() => {
      expect(mockToast).toHaveBeenCalled()
    })
    const toastArg = mockToast.mock.calls[0][0]
    expect(toastArg.kind).toBe('success')
    expect(toastArg.title).toContain('11')
    expect(toastArg.title).toContain('CodeStat')
    expect(toastArg.title).toContain('Real Project')
    // The source is now an empty shell — the toast must offer to remove it.
    expect(toastArg.actionLabel).toBeTruthy()
  })

  it('does not offer the delete action when the source still holds notes', async () => {
    mockListGroups.mockResolvedValue([
      group({ project_id: 1, name: 'CodeStat', note_count: 11 }),
    ])
    // Only 3 of 11 notes move, so 8 remain behind.
    mockReassign.mockResolvedValue(3)

    renderReady(<KnowledgeOrganize />)

    const select = await screen.findByRole('combobox')
    fireEvent.change(select, { target: { value: '10' } })
    ;(screen.getByText('归口') as HTMLButtonElement).click()

    await waitFor(() => expect(mockToast).toHaveBeenCalled())
    expect(mockToast.mock.calls[0][0].actionLabel).toBeUndefined()
  })

  it('confirms a delete with the number of notes that went with it', async () => {
    mockListGroups.mockResolvedValue([
      group({ project_id: 1, name: 'CodeStat', note_count: 11 }),
    ])
    mockDelete.mockResolvedValue(undefined)

    renderReady(<KnowledgeOrganize />)

    // The delete button arms first, then fires on the second click.
    const del = await screen.findByTitle('连同其笔记一并删除')
    expect((del as HTMLButtonElement).textContent).toBe('common.delete')
    ;(del as HTMLButtonElement).click()
    await waitFor(() => {
      expect((screen.getByTitle('连同其笔记一并删除') as HTMLButtonElement).textContent)
        .not.toBe('common.delete')
    })
    ;(screen.getByTitle('连同其笔记一并删除') as HTMLButtonElement).click()

    await waitFor(() => expect(mockToast).toHaveBeenCalled())
    const toastArg = mockToast.mock.calls[0][0]
    expect(toastArg.title).toContain('CodeStat')
    expect(toastArg.message).toContain('11')
  })
})
