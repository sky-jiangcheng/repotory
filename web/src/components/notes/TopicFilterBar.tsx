import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { NoteTopic } from '../../api/client'
import Icon from '../Icon'
import s from './TopicFilterBar.module.css'

interface Props {
  topics: NoteTopic[]
  /** The selected topic id; 0 means "all topics". */
  activeTopicId: number
  onSelect: (topicId: number) => void
  /** How many notes carry no topic — shown next to the "unfiled" chip. */
  unfiledCount: number
  onCreate: (name: string) => Promise<unknown>
  onRename: (topicId: number, name: string) => Promise<boolean>
  onDelete: (topicId: number) => Promise<boolean>
}

/**
 * The topic layer's control strip: one chip per topic, plus the two buckets
 * every project has — "all" and "unfiled".
 *
 * A topic is a real entity with its own lifecycle, so the strip is also where
 * topics are created, renamed and deleted. Creating one inline (a text field
 * that appears next to the strip) is deliberate: a topic is a short label, and
 * a modal for typing three characters is a detour.
 */
export default function TopicFilterBar({
  topics, activeTopicId, onSelect, unfiledCount, onCreate, onRename, onDelete,
}: Props) {
  const { t } = useTranslation()
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')

  const submitNew = async () => {
    const name = newName.trim()
    if (!name) { setCreating(false); return }
    const created = await onCreate(name)
    if (created) { setNewName(''); setCreating(false) }
  }

  const submitRename = async (topicId: number) => {
    const name = editName.trim()
    if (!name) return
    const ok = await onRename(topicId, name)
    if (ok) setEditingId(null)
  }

  return (
    <div className={s.topicBar}>
      <div className={s.chips}>
        {/* The chips only make sense once the project HAS topics: "all" and
            "unfiled" are two ways of slicing a set that does not exist yet.
            The create button always shows — otherwise a project with no
            topics would have no way to grow its first one. */}
        {topics.length > 0 && (
          <>
            <button
              className={`filter-btn ${activeTopicId === 0 ? 'active' : ''}`}
              onClick={() => onSelect(0)}
            >
              {t('project.topicsAll')}
            </button>
            <button
              className={`filter-btn ${activeTopicId === -1 ? 'active' : ''}`}
              onClick={() => onSelect(-1)}
              title={t('project.topicsUnfiledHint')}
            >
              {t('project.topicsUnfiled')} ({unfiledCount})
            </button>
          </>
        )}
        {topics.map(tp => (
          <span key={tp.id} className={s.topicChipWrap}>
            {editingId === tp.id ? (
              <span className={s.editBox}>
                <input
                  type="text"
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') void submitRename(tp.id)
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  placeholder={t('project.topicNamePlaceholder')}
                  aria-label={t('project.topicRename')}
                  className={`form-input ${s.editInput}`}
                  autoFocus
                />
                <button className="btn btn-sm btn-primary" onClick={() => void submitRename(tp.id)}>
                  {t('common.save')}
                </button>
                <button className="btn btn-sm" onClick={() => setEditingId(null)}>
                  {t('project.cancel')}
                </button>
              </span>
            ) : (
              <>
                <button
                  className={`filter-btn ${activeTopicId === tp.id ? 'active' : ''}`}
                  onClick={() => onSelect(tp.id)}
                  title={tp.description || tp.name}
                >
                  {tp.name} ({tp.note_count})
                </button>
                <span className={s.topicActions}>
                  <button
                    className={s.iconBtn}
                    title={t('project.topicRename')}
                    aria-label={t('project.topicRename')}
                    onClick={() => { setEditingId(tp.id); setEditName(tp.name) }}
                  >
                    <Icon name="edit" size={12} />
                  </button>
                  <button
                    className={s.iconBtn}
                    title={t('project.topicDelete')}
                    aria-label={t('project.topicDelete')}
                    onClick={() => void onDelete(tp.id)}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </span>
              </>
            )}
          </span>
        ))}
        {creating ? (
          <span className={s.editBox}>
            <input
              type="text"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') void submitNew()
                if (e.key === 'Escape') setCreating(false)
              }}
              placeholder={t('project.topicNamePlaceholder')}
              aria-label={t('project.topicCreate')}
              className={`form-input ${s.editInput}`}
              autoFocus
            />
            <button className="btn btn-sm btn-primary" onClick={() => void submitNew()}>
              {t('common.save')}
            </button>
            <button className="btn btn-sm" onClick={() => setCreating(false)}>
              {t('project.cancel')}
            </button>
          </span>
        ) : (
          <button className={`btn btn-sm ${s.addBtn}`} onClick={() => setCreating(true)}>
            <Icon name="plus" size={12} /> {t('project.topicCreate')}
          </button>
        )}
      </div>
    </div>
  )
}
