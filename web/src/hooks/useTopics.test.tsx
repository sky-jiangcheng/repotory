// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'

vi.mock('../api/client', () => ({
  listTopics: vi.fn(),
  createTopic: vi.fn(),
  updateTopic: vi.fn(),
  deleteTopic: vi.fn(),
  setNoteTopic: vi.fn(),
}))

const mockT = (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockT }),
}))

import { useTopics } from './useTopics'
import { listTopics, createTopic, updateTopic, deleteTopic } from '../api/client'
import TopicFilterBar from '../components/notes/TopicFilterBar'

const mockListTopics = vi.mocked(listTopics)
const mockCreateTopic = vi.mocked(createTopic)
const mockUpdateTopic = vi.mocked(updateTopic)
const mockDeleteTopic = vi.mocked(deleteTopic)

const topic = (id: number, name: string, noteCount = 0) => ({
  id,
  project_id: 7,
  name,
  description: '',
  sort_order: 0,
  note_count: noteCount,
  created_at: '2026-10-25T00:00:00Z',
  updated_at: '2026-10-25T00:00:00Z',
})

beforeEach(() => {
  mockListTopics.mockReset().mockResolvedValue([])
  mockCreateTopic.mockReset()
  mockUpdateTopic.mockReset().mockResolvedValue(undefined)
  mockDeleteTopic.mockReset().mockResolvedValue(undefined)
})

describe('useTopics', () => {
  it('loads the project topics', async () => {
    mockListTopics.mockResolvedValue([topic(1, '支付网关', 3)])
    const { result } = renderHook(() => useTopics(7))
    await waitFor(() => expect(result.current.topics).toHaveLength(1))
    expect(result.current.topics[0].name).toBe('支付网关')
    expect(mockListTopics).toHaveBeenCalledWith(7)
  })

  it('reports a load failure instead of an empty topic list', async () => {
    mockListTopics.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useTopics(7))
    await waitFor(() => expect(result.current.error).toContain('boom'))
    expect(result.current.loading).toBe(false)
  })

  it('adds a created topic to the list', async () => {
    mockCreateTopic.mockResolvedValue(topic(2, '新主题'))
    const { result } = renderHook(() => useTopics(7))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => { await result.current.create('新主题') })
    expect(mockCreateTopic).toHaveBeenCalledWith(7, '新主题')
    expect(result.current.topics.map(tp => tp.name)).toContain('新主题')
  })

  it('keeps the list untouched when creating fails, and says why', async () => {
    mockCreateTopic.mockRejectedValue(new Error('该主题已存在'))
    const { result } = renderHook(() => useTopics(7))
    await waitFor(() => expect(result.current.loading).toBe(false))
    let created: unknown = 'unset'
    await act(async () => { created = await result.current.create('重复') })
    expect(created).toBeNull()
    expect(result.current.topics).toHaveLength(0)
    expect(result.current.error).toContain('该主题已存在')
  })

  it('renames a topic in place', async () => {
    mockListTopics.mockResolvedValue([topic(1, '旧名字')])
    const { result } = renderHook(() => useTopics(7))
    await waitFor(() => expect(result.current.topics).toHaveLength(1))
    await act(async () => { await result.current.rename(1, '新名字') })
    expect(mockUpdateTopic).toHaveBeenCalledWith(1, '新名字')
    expect(result.current.topics[0].name).toBe('新名字')
  })

  it('deletes a topic and drops the filter that pointed at it', async () => {
    mockListTopics.mockResolvedValue([topic(1, '网关')])
    const { result } = renderHook(() => useTopics(7))
    await waitFor(() => expect(result.current.topics).toHaveLength(1))
    act(() => result.current.setActiveTopicId(1))
    expect(result.current.activeTopicId).toBe(1)
    await act(async () => { await result.current.remove(1) })
    expect(mockDeleteTopic).toHaveBeenCalledWith(1)
    expect(result.current.topics).toHaveLength(0)
    // The filter must not keep pointing at a topic that no longer exists.
    expect(result.current.activeTopicId).toBe(0)
  })

  it('drops a selection that belongs to another project', async () => {
    mockListTopics.mockResolvedValue([topic(1, '网关')])
    const { result, rerender } = renderHook(({ id }) => useTopics(id), { initialProps: { id: 7 } })
    await waitFor(() => expect(result.current.topics).toHaveLength(1))
    act(() => result.current.setActiveTopicId(1))
    rerender({ id: 8 })
    // The new project's list resolves after the switch; let it settle so the
    // pending state update is flushed inside act().
    await act(async () => { await Promise.resolve() })
    // The selection belonged to project 7; in project 8 it means nothing.
    expect(result.current.activeTopicId).toBe(0)
  })
})

describe('TopicFilterBar', () => {
  it('lists the topics with their note counts and the unfiled bucket', () => {
    render(
      <TopicFilterBar
        topics={[topic(1, '支付网关', 3), topic(2, '对账', 1)]}
        activeTopicId={0}
        onSelect={() => {}}
        unfiledCount={5}
        onCreate={async () => null}
        onRename={async () => true}
        onDelete={async () => true}
      />,
    )
    expect(screen.getByText('支付网关 (3)')).toBeTruthy()
    expect(screen.getByText('对账 (1)')).toBeTruthy()
    expect(screen.getByText('project.topicsUnfiled (5)')).toBeTruthy()
  })

  it('creates a topic inline', async () => {
    const onCreate = vi.fn().mockResolvedValue(topic(3, '新主题'))
    render(
      <TopicFilterBar
        topics={[]}
        activeTopicId={0}
        onSelect={() => {}}
        unfiledCount={0}
        onCreate={onCreate}
        onRename={async () => true}
        onDelete={async () => true}
      />,
    )
    fireEvent.click(screen.getByText('project.topicCreate'))
    fireEvent.change(screen.getByLabelText('project.topicCreate'), { target: { value: '新主题' } })
    fireEvent.click(screen.getByText('common.save'))
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('新主题'))
  })

  it('selects a topic when its chip is clicked', () => {
    const onSelect = vi.fn()
    render(
      <TopicFilterBar
        topics={[topic(1, '支付网关', 3)]}
        activeTopicId={0}
        onSelect={onSelect}
        unfiledCount={0}
        onCreate={async () => null}
        onRename={async () => true}
        onDelete={async () => true}
      />,
    )
    fireEvent.click(screen.getByText('支付网关 (3)'))
    expect(onSelect).toHaveBeenCalledWith(1)
  })
})
