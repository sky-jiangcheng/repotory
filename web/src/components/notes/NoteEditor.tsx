import { useTranslation } from 'react-i18next'
import { useEffect, useState } from 'react'
import { renderMarkdownAsync } from '../../utils/markdown'
import { suggestWikiLinks } from '../../api/endpoints'
import type { WikiLinkSuggestion } from '../../api/types'
import BlockEditor from '../BlockEditor'
import s from './NoteEditor.module.css'

/** The editable fields of a note draft. */
export interface NoteDraft {
  title: string
  tags: string
  kind: string
  content: string
  pinned?: boolean
}

interface Props {
  value: NoteDraft
  onChange: (draft: NoteDraft) => void
  onSave: () => void
  onCancel: () => void
  saving: boolean
  /** Extra meta controls only shown when editing an existing note. */
  showPinned?: boolean
  projects?: { id: number; name: string }[]
  currentProjectId?: number
  onMoveProject?: (projectId: number) => void
}

const KINDS = [
  { value: 'knowledge', key: 'project.kinds.knowledge' },
  { value: 'log', key: 'project.kinds.log' },
  { value: 'idea', key: 'project.kinds.idea' },
  { value: 'other', key: 'project.kinds.other' },
]

/**
 * The unified note editor used for both creating and editing a note:
 * title/tags/kind row, Markdown or block editing with live async preview
 * (Mermaid/KaTeX aware), and the save/cancel action row.
 */
export default function NoteEditor({
  value, onChange, onSave, onCancel, saving,
  showPinned = false, projects, currentProjectId, onMoveProject,
}: Props) {
  const { t } = useTranslation()
  const [showPreview, setShowPreview] = useState(true)
  const [mode, setMode] = useState<'markdown' | 'block'>('markdown')
  const [previewHtml, setPreviewHtml] = useState('')
  const [suggestions, setSuggestions] = useState<WikiLinkSuggestion[]>([])

  // Async preview: renderMarkdownAsync supports mermaid diagrams.
  useEffect(() => {
    if (!showPreview || !value.content) { setPreviewHtml(''); return } // eslint-disable-line react-hooks/set-state-in-effect
    let cancelled = false
    renderMarkdownAsync(value.content)
      .then(html => { if (!cancelled) setPreviewHtml(html) })
      .catch(() => { if (!cancelled) setPreviewHtml('') })
    return () => { cancelled = true }
  }, [value.content, showPreview])

  // Scan content for potential [[wikilink]] candidates
  useEffect(() => {
    if (!value.content || value.content.length < 10) {
      setSuggestions([]) // eslint-disable-line react-hooks/set-state-in-effect
      return
    }
    const timer = setTimeout(() => {
      suggestWikiLinks(currentProjectId || 0, value.content)
        .then(res => setSuggestions(res || []))
        .catch(() => setSuggestions([]))
    }, 400)
    return () => clearTimeout(timer)
  }, [value.content, currentProjectId])

  const applySuggestion = (sug: WikiLinkSuggestion) => {
    // Replace the first unmatched plain mention with [[slug|matched]] or [[slug]]
    const needle = sug.matched
    const idx = value.content.indexOf(needle)
    if (idx >= 0) {
      const replacement = needle.toLowerCase() === sug.slug.toLowerCase()
        ? `[[${sug.slug}]]`
        : `[[${sug.slug}|${needle}]]`
      const nextContent = value.content.slice(0, idx) + replacement + value.content.slice(idx + needle.length)
      onChange({ ...value, content: nextContent })
    }
  }

  return (
    <div className={s.noteEditorBlock}>
      <div className={s.noteMetaRow}>
        <input
          type="text"
          value={value.title}
          onChange={e => onChange({ ...value, title: e.target.value })}
          placeholder={t('project.titlePlaceholder')}
          className={`form-input note-title-input ${s.noteTitleInput}`}
        />
        <select
          value={value.kind}
          onChange={e => onChange({ ...value, kind: e.target.value })}
          className={`form-input ${s.noteKindSelect}`}
        >
          {KINDS.map(k => <option key={k.value} value={k.value}>{t(k.key)}</option>)}
        </select>
        {showPinned && (
          <label className={s.notePinToggle}>
            <input
              type="checkbox"
              checked={!!value.pinned}
              onChange={e => onChange({ ...value, pinned: e.target.checked })}
            />
            {t('project.pinned')}
          </label>
        )}
        {showPinned && projects && currentProjectId !== undefined && onMoveProject && (
          <select
            value={currentProjectId}
            onChange={e => onMoveProject(Number(e.target.value))}
            className={`form-input ${s.noteKindSelect}`}
            title={t('project.linkedProject')}
          >
            {projects.map(p => (
              <option key={p.id} value={p.id}>
                {p.id === currentProjectId ? `${p.name}（${t('project.current')}）` : p.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <input
        type="text"
        value={value.tags}
        onChange={e => onChange({ ...value, tags: e.target.value })}
        placeholder={t('project.tagsPlaceholder')}
        className={`form-input note-tags-input ${s.noteTagsInput}`}
      />
      {suggestions.length > 0 && (
        <div className={s.suggestionsBar}>
          <span className={s.suggestionsLabel}>
            {t('project.linkSuggestions', { defaultValue: '双链建议:' })}
          </span>
          {suggestions.map(sug => (
            <button
              key={`${sug.page_id}-${sug.matched}`}
              type="button"
              className={s.suggestionPill}
              onClick={() => applySuggestion(sug)}
              title={t('project.applyWikilink', {
                defaultValue: `转为 [[${sug.slug}]] 链接`,
              })}
            >
              + [[{sug.matched}]]
            </button>
          ))}
        </div>
      )}
      <div className={s.noteEditorSplit}>
        {mode === 'block' ? (
          <BlockEditor value={value.content} onChange={v => onChange({ ...value, content: v })} />
        ) : (
          <textarea
            value={value.content}
            onChange={e => onChange({ ...value, content: e.target.value })}
            placeholder={t('project.contentPlaceholder')}
            className={`form-input note-textarea ${s.noteTextarea}`}
            rows={10}
          />
        )}
        {showPreview && (
          <div className={`${s.notePreview} markdown-body`}>
            {previewHtml
              ? <div dangerouslySetInnerHTML={{ __html: previewHtml }} />
              : value.content
                ? <span className={s.draftHint}>{t('project.rendering')}</span>
                : null}
          </div>
        )}
      </div>
      <div className={s.noteEditorActions}>
        <button className="btn btn-primary btn-sm" onClick={onSave} disabled={saving || !value.content.trim()}>
          {t('project.save')}
        </button>
        <button className="btn btn-sm" onClick={() => setShowPreview(v => !v)}>
          {showPreview ? t('project.hidePreview') : t('project.preview')}
        </button>
        <button
          className="btn btn-sm"
          onClick={() => setMode(m => m === 'markdown' ? 'block' : 'markdown')}
          title={t('project.switchMode')}
        >
          {mode === 'markdown' ? t('project.blockEdit') : t('project.mdEdit')}
        </button>
        <button className="btn btn-sm" onClick={onCancel}>{t('project.cancel')}</button>
        {value.content && <span className={s.draftHint}>{t('project.draftSaved')}</span>}
      </div>
    </div>
  )
}
