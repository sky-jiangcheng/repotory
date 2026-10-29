// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>()
  return {
    ...actual,
    getProjects: vi.fn(),
    createHandoff: vi.fn(),
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

import { createHandoff, getProjects } from '../api/client'
import HandoffComposer from './HandoffComposer'

const mockProjects = vi.mocked(getProjects)
const mockCreate = vi.mocked(createHandoff)

const projects = [
  { id: 1, name: 'demo', root_path: '/home/me/demo', repo_count: 2, is_starred: false, level: 'local' },
] as never[]

beforeEach(() => {
  mockProjects.mockReset()
  mockCreate.mockReset()
  mockProjects.mockResolvedValue(projects)
  mockCreate.mockResolvedValue({ note_id: 42, title: 'Session Handoff', tags: 'handoff' })
})

describe('HandoffComposer', () => {
  it('renders nothing while closed', () => {
    const { container } = render(<HandoffComposer open={false} onClose={() => {}} />)
    expect(container.innerHTML).toBe('')
  })

  it('keeps the save button disabled until a summary and one section are filled', async () => {
    render(<HandoffComposer open onClose={() => {}} />)
    await waitFor(() => expect(mockProjects).toHaveBeenCalled())

    const save = screen.getByRole('button', { name: 'handoff.save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)

    fireEvent.change(screen.getByPlaceholderText('handoff.summaryPlaceholder'), {
      target: { value: 'shipped the composer' },
    })
    expect(save.disabled).toBe(true) // summary alone is not enough

    fireEvent.change(screen.getAllByPlaceholderText('handoff.sectionPlaceholder')[0], {
      target: { value: 'added the dialog\n\n  kept the old line  ' },
    })
    expect(save.disabled).toBe(false)
  })

  it('writes one bullet per line and drops the blank ones', async () => {
    const onClose = vi.fn()
    const onCreated = vi.fn()
    render(<HandoffComposer open onClose={onClose} onCreated={onCreated} />)
    await waitFor(() => expect(mockProjects).toHaveBeenCalled())

    fireEvent.change(screen.getByPlaceholderText('handoff.summaryPlaceholder'), {
      target: { value: 'shipped the composer' },
    })
    // The first section textarea is Changes, the second Decisions.
    const sections = screen.getAllByPlaceholderText('handoff.sectionPlaceholder')
    fireEvent.change(sections[0], { target: { value: 'added the dialog\n\nsecond bullet' } })

    fireEvent.click(screen.getByRole('button', { name: 'handoff.save' }))

    await waitFor(() => expect(mockCreate).toHaveBeenCalled())
    expect(mockCreate).toHaveBeenCalledWith(1, {
      summary: 'shipped the composer',
      changes: ['added the dialog', 'second bullet'],
      decisions: [],
      gotchas: [],
      nextSteps: [],
    })
    expect(onCreated).toHaveBeenCalledWith(42)
    expect(onClose).toHaveBeenCalled()
  })

  it('keeps the dialog open and shows the backend error when the write fails', async () => {
    mockCreate.mockRejectedValue(new Error('summary is required'))
    const onClose = vi.fn()
    render(<HandoffComposer open onClose={onClose} />)
    await waitFor(() => expect(mockProjects).toHaveBeenCalled())

    fireEvent.change(screen.getByPlaceholderText('handoff.summaryPlaceholder'), {
      target: { value: 'shipped the composer' },
    })
    fireEvent.change(screen.getAllByPlaceholderText('handoff.sectionPlaceholder')[0], {
      target: { value: 'added the dialog' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'handoff.save' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('summary is required')
    expect(onClose).not.toHaveBeenCalled()
  })
})
