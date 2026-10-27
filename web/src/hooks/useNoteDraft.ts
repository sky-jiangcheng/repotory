import { useCallback, useState, useEffect, type Dispatch, type SetStateAction } from 'react'
import type { NoteDraft } from '../components/notes/NoteEditor'

const emptyDraft: NoteDraft = { content: '', title: '', tags: '', kind: 'knowledge' }

function draftKey(projectId: number) {
  return `repotory-note-draft-${projectId}`
}

// Spelling is intentional: this names the key written by builds before the
// GitBoard -> Repotory rename, and loadDraft() moves its value over.
function legacyDraftKey(projectId: number) {
  return `gitboard-note-draft-${projectId}`
}

function loadDraft(projectId: number): NoteDraft {
  try {
    let raw = localStorage.getItem(draftKey(projectId))
    if (!raw) {
      raw = localStorage.getItem(legacyDraftKey(projectId))
      if (raw) {
        localStorage.setItem(draftKey(projectId), raw)
        localStorage.removeItem(legacyDraftKey(projectId))
      }
    }
    if (raw) {
      const parsed = JSON.parse(raw)
      if (
        typeof parsed === 'object' && parsed !== null &&
        typeof parsed.content === 'string' &&
        typeof parsed.title === 'string' &&
        typeof parsed.tags === 'string' &&
        typeof parsed.kind === 'string'
      ) {
        return {
          content: parsed.content,
          title: parsed.title,
          tags: parsed.tags,
          kind: parsed.kind,
          pinned: typeof parsed.pinned === 'boolean' ? parsed.pinned : undefined,
          // The chosen topic travels with the draft: a half-written note whose
          // filing is remembered is one less thing to re-pick after a reload.
          topicId: typeof parsed.topicId === 'number' ? parsed.topicId : undefined,
        }
      }
    }
  } catch (e: unknown) { console.error('[useNoteDraft] loadDraft failed:', e) }
  return { ...emptyDraft }
}

/**
 * useNoteDraft manages the draft state for the current note editor, persisting
 * it to localStorage keyed by projectId. Supports migration from the old
 * `repotory-` key prefix.
 *
 * The draft never crosses a project boundary. The state carries the project it
 * belongs to, and a project change re-derives it: without that, switching
 * projects would keep the previous project's draft in memory and then write it
 * into the new project's localStorage slot — one keystroke of the wrong note
 * filed into the wrong project, silently.
 *
 * This used to rely on the caller remounting the editor with a per-project
 * `key`. That worked, but only for that one caller: a hook whose safety
 * depends on a key nobody remembers is not a safety property. The `key` is
 * still there (it resets the rest of the editor state too); this is the
 * second line of defence, and the one that travels with the hook.
 */
export function useNoteDraft(projectId: number): [NoteDraft, Dispatch<SetStateAction<NoteDraft>>, () => void] {
  const [state, setState] = useState<{ projectId: number; draft: NoteDraft }>(
    () => ({ projectId, draft: loadDraft(projectId) }),
  )

  // Adjusting state during render is React's documented way to react to a
  // changed prop (the "derive state from props" pattern): the state that
  // belongs to another project is replaced before anything renders with it.
  const draft = state.projectId === projectId ? state.draft : loadDraft(projectId)
  if (state.projectId !== projectId) {
    setState({ projectId, draft })
  }

  useEffect(() => {
    // Only ever write the draft that belongs to the project being written to.
    if (state.projectId !== projectId) return
    try { localStorage.setItem(draftKey(projectId), JSON.stringify(state.draft)) } catch { /* ignore */ }
  }, [state, projectId])

  const setDraft: Dispatch<SetStateAction<NoteDraft>> = useCallback((action: SetStateAction<NoteDraft>) => {
    setState(prev => {
      const current = prev.projectId === projectId ? prev.draft : loadDraft(projectId)
      const next = typeof action === 'function'
        ? (action as (d: NoteDraft) => NoteDraft)(current)
        : action
      return { projectId, draft: next }
    })
  }, [projectId])

  const clearDraft = useCallback(() => {
    setState({ projectId, draft: { ...emptyDraft } })
    try { localStorage.removeItem(draftKey(projectId)) } catch { /* ignore */ }
  }, [projectId])

  return [draft, setDraft, clearDraft]
}
