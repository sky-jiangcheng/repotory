import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useNoteDraft } from './useNoteDraft'

const slot = (projectId: number) => `repotory-note-draft-${projectId}`

const read = (projectId: number) => {
  const raw = localStorage.getItem(slot(projectId))
  return raw ? (JSON.parse(raw) as { content: string }) : null
}

describe('useNoteDraft', () => {
  beforeEach(() => { localStorage.clear() })

  it('keeps one draft per project', () => {
    const { result } = renderHook(() => useNoteDraft(1))
    act(() => { result.current[1]({ ...result.current[0], content: 'alpha' }) })
    expect(read(1)?.content).toBe('alpha')
    expect(localStorage.getItem(slot(2))).toBeNull()
  })

  // The regression this hook exists for: a draft belonging to project A must
  // never end up in project B's storage slot, no matter who drives the switch.
  it('does not carry the previous project’s draft into the next one', () => {
    const { result, rerender } = renderHook(({ id }) => useNoteDraft(id), { initialProps: { id: 1 } })
    act(() => { result.current[1]({ ...result.current[0], content: 'alpha' }) })

    rerender({ id: 2 })

    expect(result.current[0].content).toBe('')
    // …and project A's own draft is still where it belongs.
    expect(read(1)?.content).toBe('alpha')
  })

  it('writes to the new project’s slot, never the old one', () => {
    const writes: Array<{ key: string; content: string }> = []
    const realSet = localStorage.setItem.bind(localStorage)
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k: string, v: string) => {
      writes.push({ key: k, content: (JSON.parse(v) as { content: string }).content })
      realSet(k, v)
    })

    const { result, rerender } = renderHook(({ id }) => useNoteDraft(id), { initialProps: { id: 1 } })
    act(() => { result.current[1]({ ...result.current[0], content: 'alpha' }) })

    rerender({ id: 2 })
    act(() => { result.current[1]({ ...result.current[0], content: 'beta' }) })

    spy.mockRestore()

    expect(read(2)?.content).toBe('beta')
    expect(read(1)?.content).toBe('alpha')
    // The old implementation wrote the previous project's draft into the new
    // project's slot on the way — a transient write that ends up overwritten
    // but still lands in storage (and in any crash between the two writes).
    expect(writes.filter(w => w.key === slot(2) && w.content === 'alpha')).toHaveLength(0)
  })

  it('restores the draft that was left in the new project', () => {
    localStorage.setItem(slot(2), JSON.stringify({ content: 'kept', title: '', tags: '', kind: 'knowledge' }))
    const { result, rerender } = renderHook(({ id }) => useNoteDraft(id), { initialProps: { id: 1 } })
    expect(result.current[0].content).toBe('')

    rerender({ id: 2 })
    expect(result.current[0].content).toBe('kept')
  })

  it('clears only the current project’s slot', () => {
    const { result, rerender } = renderHook(({ id }) => useNoteDraft(id), { initialProps: { id: 1 } })
    act(() => { result.current[1]({ ...result.current[0], content: 'alpha' }) })
    rerender({ id: 2 })
    act(() => { result.current[1]({ ...result.current[0], content: 'beta' }) })

    act(() => { result.current[2]() })

    // The slot is emptied (the persist effect rewrites it as an empty draft
    // right after the removal) — what matters is that project A is untouched.
    expect(read(2)?.content).toBe('')
    expect(read(1)?.content).toBe('alpha')
  })

  it('applies a functional update against the current project’s draft', () => {
    const { result } = renderHook(() => useNoteDraft(1))
    act(() => { result.current[1]({ ...result.current[0], content: 'alpha' }) })
    act(() => { result.current[1](d => ({ ...d, title: 'T' })) })
    expect(result.current[0].title).toBe('T')
    expect(result.current[0].content).toBe('alpha')
  })
})
