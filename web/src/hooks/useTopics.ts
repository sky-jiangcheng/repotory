import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  listTopics, createTopic, updateTopic, deleteTopic,
  type NoteTopic,
} from '../api/client'
import { describeApiError } from '../utils/apiError'

interface TopicState {
  /** The project the loaded topics belong to. */
  projectId: number
  topics: NoteTopic[]
  error: string
  /** Whether a load has completed for this project. */
  loaded: boolean
}

interface ActiveTopic {
  /** The project the selection belongs to. */
  projectId: number
  id: number
}

/**
 * useTopics owns one project's topic list and every write on it.
 *
 * Topics are project-scoped: a topic belongs to exactly one project, so the
 * list is fetched per project. The hook keeps the "which topic is selected"
 * state out of the components so the note list, the editor and the filter bar
 * all read the same list — a topic list fetched twice can disagree, and a
 * chip showing a stale count next to a note filed under a topic that no
 * longer exists is exactly that kind of disagreement.
 *
 * Both the loaded list and the selection carry the project they belong to, so
 * switching projects invalidates them by derivation rather than by resetting
 * state inside an effect: a filter pointing at another project's topic would
 * show an empty list for reasons the user cannot see.
 */
export interface TopicsHandle {
  topics: NoteTopic[]
  loading: boolean
  error: string
  /** The selected topic id; 0 means "no topic filter". */
  activeTopicId: number
  setActiveTopicId: (id: number) => void
  /** Create a topic; returns the new topic or null on failure. */
  create: (name: string) => Promise<NoteTopic | null>
  /** Rename a topic. Resolves to whether it succeeded. */
  rename: (topicId: number, name: string) => Promise<boolean>
  /** Delete a topic. The notes filed under it are kept. */
  remove: (topicId: number) => Promise<boolean>
  refresh: () => void
  clearError: () => void
}

export function useTopics(projectId: number): TopicsHandle {
  const { t } = useTranslation()
  const [state, setState] = useState<TopicState>({ projectId, topics: [], error: '', loaded: false })
  const [active, setActive] = useState<ActiveTopic>({ projectId, id: 0 })
  const [seq, setSeq] = useState(0)

  useEffect(() => {
    let cancelled = false
    listTopics(projectId)
      .then(list => {
        if (cancelled) return
        setState({ projectId, topics: list, error: '', loaded: true })
      })
      .catch(e => {
        if (cancelled) return
        setState({
          projectId,
          topics: [],
          error: t('project.topicsLoadFailed') + ': ' + describeApiError(t, e),
          loaded: true,
        })
      })
    return () => { cancelled = true }
  }, [projectId, seq, t])

  const refresh = useCallback(() => setSeq(s => s + 1), [])

  const create = useCallback(async (name: string) => {
    setState(s => ({ ...s, error: '' }))
    try {
      const created = await createTopic(projectId, name)
      setState(s => ({ ...s, topics: [...s.topics, created].sort((a, b) => a.name.localeCompare(b.name)) }))
      return created
    } catch (e) {
      setState(s => ({ ...s, error: t('project.topicCreateFailed') + ': ' + describeApiError(t, e) }))
      return null
    }
  }, [projectId, t])

  const rename = useCallback(async (topicId: number, name: string) => {
    setState(s => ({ ...s, error: '' }))
    try {
      await updateTopic(topicId, name)
      setState(s => ({
        ...s,
        topics: s.topics
          .map(tp => tp.id === topicId ? { ...tp, name } : tp)
          .sort((a, b) => a.name.localeCompare(b.name)),
      }))
      return true
    } catch (e) {
      setState(s => ({ ...s, error: t('project.topicRenameFailed') + ': ' + describeApiError(t, e) }))
      return false
    }
  }, [t])

  const remove = useCallback(async (topicId: number) => {
    setState(s => ({ ...s, error: '' }))
    try {
      await deleteTopic(topicId)
      setState(s => ({ ...s, topics: s.topics.filter(tp => tp.id !== topicId) }))
      // A filter pointing at the topic just deleted would show "no notes"
      // for a reason that reads like the notes are gone.
      setActive(cur => cur.id === topicId ? { ...cur, id: 0 } : cur)
      return true
    } catch (e) {
      setState(s => ({ ...s, error: t('project.topicDeleteFailed') + ': ' + describeApiError(t, e) }))
      return false
    }
  }, [t])

  const clearError = useCallback(() => setState(s => ({ ...s, error: '' })), [])

  return {
    // A list loaded for another project is not this project's list.
    topics: state.projectId === projectId ? state.topics : [],
    loading: !state.loaded || state.projectId !== projectId,
    error: state.projectId === projectId ? state.error : '',
    activeTopicId: active.projectId === projectId ? active.id : 0,
    setActiveTopicId: (id: number) => setActive({ projectId, id }),
    create, rename, remove, refresh, clearError,
  }
}
