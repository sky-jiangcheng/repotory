import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  listOrganizeGroups, reassignLandingNotes, deleteLandingProject, getProjects,
  type OrganizeGroup, type Project,
} from '../../api/client'
import { useConfirmClick } from '../../hooks/useConfirmClick'
import { useToast } from '../../hooks/useToast'
import ErrorBanner from '../../components/ErrorBanner'
import Icon from '../../components/Icon'
import s from './KnowledgeOrganize.module.css'

// The knowledge-base organize surface (ADR-0023). Import placeholders and the
// default "Uncategorized" bucket collect notes that arrived from external
// knowledge without a matching project; this view lets a person re-file them
// into a real project (or the default) and remove an emptied placeholder — the
// whole point being that nothing is silently lost anymore, but filing stays a
// human act. Renders nothing when there is nothing to organize.

// nestingParent finds the placeholder a bucket sits inside, judged by the root
// paths on disk: "Fund账户绑定PI" lives under "富港科技资料", and the list
// rendered the two as flat siblings with no hint of the containment (the
// 2026-10-21 smoke test). Derived from the paths the groups already carry —
// no new column, no new query.
export function nestingParent(
  groups: OrganizeGroup[],
  g: OrganizeGroup,
): OrganizeGroup | undefined {
  let best: OrganizeGroup | undefined
  for (const other of groups) {
    if (other.project_id === g.project_id) continue
    // Path-separator aware: "/a/bc" must not count as inside "/a/b".
    if (!g.root_path.startsWith(other.root_path + '/')) continue
    // The longest matching ancestor is the immediate parent.
    if (!best || other.root_path.length > best.root_path.length) best = other
  }
  return best
}

function KnowledgeOrganize({ onPendingChange }: { onPendingChange?: (n: number) => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [groups, setGroups] = useState<OrganizeGroup[]>([])
  const [realProjects, setRealProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<number | null>(null)
  // Per-group chosen reassign target; 0 = none selected.
  const [targets, setTargets] = useState<Record<number, number>>({})

  const load = useCallback(() => {
    // State changes happen only in the promise callbacks, never synchronously in
    // the effect that calls this (react-hooks/set-state-in-effect) — the same
    // shape as NoteSection's fetchNotes.
    Promise.all([listOrganizeGroups(), getProjects(undefined, false)])
      .then(([gs, ps]) => {
        setGroups(gs)
        setRealProjects(ps.filter(p => p.project_kind === 'scanned'))
        setError('')
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  // Nothing awaiting the user: no landing buckets at all, or only an empty
  // default bucket (the default is never shown by itself — it is the catch-all).
  const worthShowing = groups.some(
    g => g.kind === 'import_placeholder' || (g.kind === 'default' && g.note_count > 0),
  )

  // Report the backlog upward so the page toolbar can offer a jump link. The
  // count is of NOTES, not buckets — "待整理 14" is the actionable number, and
  // it drops to 0 (link disappears) the moment the backlog is cleared.
  const pending = groups
    .filter(g => g.kind === 'import_placeholder' || (g.kind === 'default' && g.note_count > 0))
    .reduce((sum, g) => sum + (g.note_count || 0), 0)
  useEffect(() => { onPendingChange?.(loading ? 0 : pending) }, [loading, pending, onPendingChange])

  if (!loading && !worthShowing) {
    return null
  }

  const defaultGroup = groups.find(g => g.kind === 'default')

  // Reassign targets for a source bucket: the scanner-backed projects, plus the
  // default bucket for an import placeholder (un-filing into "Uncategorized").
  // The source itself and any other placeholder are never offered.
  const optionsFor = (g: OrganizeGroup): Array<{ id: number; name: string }> => {
    const opts = realProjects.map(p => ({ id: p.id, name: p.name }))
    if (g.kind !== 'default' && defaultGroup && defaultGroup.project_id !== g.project_id) {
      opts.push({ id: defaultGroup.project_id, name: t('project.kindDefault', { defaultValue: '未分类' }) })
    }
    return opts.filter(o => o.id !== g.project_id)
  }

  const doReassign = async (g: OrganizeGroup) => {
    const target = targets[g.project_id]
    if (!target) return
    setBusy(g.project_id)
    try {
      const moved = await reassignLandingNotes(g.project_id, target)
      await load()
      // Silence looked like a no-op: the row stayed, only its count changed, and
      // the user had no way to tell the move happened (2026-10-21 smoke test).
      // Say what moved, where it went, and — when the source is now an empty
      // shell — offer to remove it right there instead of leaving the user to
      // wonder which bucket is the leftover.
      const targetName = optionsFor(g).find(o => o.id === target)?.name ?? ''
      const emptied = moved > 0 && moved >= g.note_count
      toast({
        kind: 'success',
        title: t('knowledge.organizeReassigned', {
          count: moved,
          source: g.name,
          target: targetName,
          defaultValue: '已把 {{count}} 条笔记从「{{source}}」归口到「{{target}}」',
        }),
        message: emptied
          ? t('knowledge.organizeReassignedEmptied', { name: g.name, defaultValue: '「{{name}}」已空，只剩一个空壳。' })
          : t('knowledge.organizeReassignedHint', { defaultValue: '源占位项目仍在列表中，可手动删除。' }),
        actionLabel: emptied ? t('knowledge.organizeRemoveEmpty', { defaultValue: '删除空占位' }) : undefined,
        onAction: emptied
          ? async () => {
            try {
              await deleteLandingProject(g.project_id, false)
              await load()
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
            }
          }
          : undefined,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const doDelete = async (g: OrganizeGroup) => {
    setBusy(g.project_id)
    try {
      // deleteNotes=true only when the bucket still holds notes (confirmed path);
      // an emptied placeholder is dropped without the flag.
      const hadNotes = g.note_count > 0
      await deleteLandingProject(g.project_id, hadNotes)
      await load()
      toast({
        kind: 'success',
        title: t('knowledge.organizeDeleted', { name: g.name, defaultValue: '已删除占位「{{name}}」' }),
        message: hadNotes
          ? t('knowledge.organizeDeletedWithNotes', { count: g.note_count, defaultValue: '连同 {{count}} 条笔记一并删除。' })
          : t('knowledge.organizeDeletedEmpty', { defaultValue: '该占位本就没有笔记。' }),
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  if (loading && groups.length === 0) {
    return <div className="skeleton skeleton-text" style={{ height: 60 }} />
  }

  return (
    <div className={`knowledge-section ${s.section}`} id="knowledge-organize">
      <div className="section-header">
        <h2><Icon name="check" size={15} /> {t('knowledge.organizeTitle', { defaultValue: '知识库整理' })}</h2>
      </div>
      <p className={s.intro}>
        {t('knowledge.organizeIntro', { defaultValue: '这些笔记导入时没有匹配到项目，先落在占位/未分类里。归口到真实项目，或删除空的占位。' })}
      </p>
      {error && <ErrorBanner message={error} onRetry={load} />}

      {groups.length === 0 ? (
        <p className="empty-hint">{t('knowledge.organizeEmpty', { defaultValue: '暂无待整理的笔记。' })}</p>
      ) : (
        <div className={s.list}>
          {groups.map(g => (
            <OrganizeRow
              key={g.project_id}
              group={g}
              parent={nestingParent(groups, g)}
              options={optionsFor(g)}
              target={targets[g.project_id] ?? 0}
              busy={busy === g.project_id}
              onPickTarget={id => setTargets(prev => ({ ...prev, [g.project_id]: id }))}
              onReassign={() => void doReassign(g)}
              onDelete={() => void doDelete(g)}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function OrganizeRow({
  group, parent, options, target, busy, onPickTarget, onReassign, onDelete, t,
}: {
  group: OrganizeGroup
  parent?: OrganizeGroup
  options: Array<{ id: number; name: string }>
  target: number
  busy: boolean
  onPickTarget: (id: number) => void
  onReassign: () => void
  onDelete: () => void
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  const isDefault = group.kind === 'default'
  const sourceGone = !isDefault && !group.repo_bound
  // Confirm-before-delete is deliberate (the user's standing rule): the armed
  // click turns into a second tap that actually removes the bucket + its notes.
  const { armed, click } = useConfirmClick(onDelete)

  return (
    <div className={s.row}>
      <div className={s.rowHead}>
        {/* A nested placeholder states its container, so "Fund账户绑定PI" no
            longer reads as a sibling of the "富港科技资料" it lives under. */}
        {parent && (
          <span className={s.rowParent} title={group.root_path}>
            {t('knowledge.organizeNestedIn', { parent: parent.name, defaultValue: '位于 {{parent}} 内' })}
          </span>
        )}
        <span className={s.rowName} title={group.root_path}>{group.name}</span>
        <span className={`badge ${isDefault ? s.badgeDefault : s.badgePlaceholder}`}>
          {isDefault ? t('project.kindDefault', { defaultValue: '未分类' }) : t('project.kindPlaceholder', { defaultValue: '未归类仓库' })}
        </span>
        {sourceGone && (
          <span className={`badge ${s.badgeGone}`} title={t('knowledge.organizeSourceGoneTip', { defaultValue: '该仓库当前不在扫描结果里（可能已删除或尚未扫描）' })}>
            {t('knowledge.organizeSourceGone', { defaultValue: '源仓库不在' })}
          </span>
        )}
        <span className={s.rowCount}>
          {t('knowledge.organizeNoteCount', { n: group.note_count, defaultValue: '{{n}} 条笔记' })}
        </span>
      </div>

      <div className={s.rowActions}>
        {group.note_count > 0 && (
          <>
            <select
              className={`form-input ${s.select}`}
              value={target}
              disabled={busy || options.length === 0}
              onChange={e => onPickTarget(Number(e.target.value))}
            >
              <option value={0}>{t('knowledge.organizePickTarget', { defaultValue: '归口到…' })}</option>
              {options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            <button
              className="btn btn-sm btn-primary"
              disabled={busy || !target}
              onClick={onReassign}
            >
              {t('knowledge.organizeReassign', { defaultValue: '归口' })}
            </button>
          </>
        )}
        {/* The default bucket can never be deleted; only placeholders (emptied or
            with notes, the latter confirmed) are removable. */}
        {!isDefault && (
          <button
            className={`btn btn-sm ${armed ? 'btn-delete-confirm' : 'btn-danger'}`}
            disabled={busy}
            onClick={click}
            title={group.note_count > 0
              ? t('knowledge.organizeDeleteWithNotes', { defaultValue: '连同其笔记一并删除' })
              : t('knowledge.organizeDeleteEmpty', { defaultValue: '删除空占位' })}
          >
            {armed ? t('project.confirmDelete') : t('common.delete')}
          </button>
        )}
      </div>
    </div>
  )
}

export default KnowledgeOrganize
