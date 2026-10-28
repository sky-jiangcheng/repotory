import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigationType, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { browseWikiPages, getProjects, searchWikiPages } from '../api/client'
import type { Project, WikiPageSummary } from '../api/client'
import ErrorBanner from '../components/ErrorBanner'
import Icon from '../components/Icon'
import s from './Wiki.module.css'

// The approved knowledge layer, read by a person (ADR-0032).
//
// Three things this page is NOT:
//
//   - it is not a second review surface. Only approved pages are visible
//     here; the gate lives on the review page, and copying it would blur
//     "to be judged" and "published";
//   - it is not an editor. Changing an approved page belongs to ADR-0021's
//     revision flow (ADR-0032 decision 2);
//   - it is not the evidence path. It calls the SAME backend retrieval, so a
//     reader and an answer can never disagree about which pages exist — but
//     opening a page here does NOT count as an access (ADR-0032 decision 4:
//     access_count means "surfaced into an answer", and one column must
//     carry one meaning).
//
// The scope selector carries the evidence path's scope, not the review
// queue's: a project means "that project's pages PLUS the global ones"
// (ADR-0031). Global pages therefore show up inside a project scope, and
// every row says so — without that label the extra page reads like a filter
// that leaked.

export default function Wiki() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  // ?q= and ?project= are the deep-link surface: a scoped, searched view is
  // worth sharing, and the browser's back button has to walk it.
  const urlQuery = searchParams.get('q') ?? ''
  const urlScope = Number(searchParams.get('project') ?? '0') || 0
  const [query, setQuery] = useState(urlQuery)
  const [scope, setScope] = useState(urlScope)
  const [projects, setProjects] = useState<Project[]>([])
  const [pages, setPages] = useState<WikiPageSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [token, setToken] = useState(0)

  // What WE put into the URL. react-router may render an intermediate
  // location while our own write is in flight, and adopting that as an
  // external change would wipe the tail of what the user just typed.
  const written = useRef({ q: urlQuery, p: urlScope })
  // Only a history navigation (back / forward) may overwrite the local state;
  // our own PUSH/REPLACE writes must not.
  const navType = useNavigationType()

  useEffect(() => {
    if (navType !== 'POP') return
    if (urlQuery !== written.current.q) setQuery(urlQuery)
    if (urlScope !== written.current.p) setScope(urlScope)
  }, [navType, urlQuery, urlScope])

  // The scope dropdown needs the project list. Its failure is not the page's
  // failure: the pages still load, and a row whose project is unknown falls
  // back to its id rather than to a blank scope label.
  useEffect(() => {
    let cancelled = false
    getProjects()
      .then(ps => { if (!cancelled) setProjects(ps) })
      .catch(() => { /* the scope degrades to "all projects" */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const q = query.trim()
    written.current = { q, p: scope }
    const next: Record<string, string> = {}
    if (q) next.q = q
    if (scope) next.project = String(scope)
    setSearchParams(next, { replace: true })

    let cancelled = false
    // The search is debounced; the browse feed is not (there is nothing to
    // type into it).
    const timer = window.setTimeout(() => {
      const req = q ? searchWikiPages(scope, q, 50) : browseWikiPages(scope, 100)
      req
        .then(list => {
          if (cancelled) return
          setPages(list)
          setError('')
          setLoading(false)
        })
        .catch((e: unknown) => {
          if (cancelled) return
          setError(e instanceof Error ? e.message : t('wiki.loadFailed'))
          setLoading(false)
        })
    }, q ? 200 : 0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [query, scope, token, setSearchParams, t])

  const projectName = useMemo(() => {
    const m = new Map<number, string>()
    for (const p of projects) m.set(p.id, p.name)
    return (pid: number) => m.get(pid) ?? `#${pid}`
  }, [projects])

  const searching = query.trim().length > 0

  return (
    <div className={s.page}>
      {/* The nav bar already names this section ("知识页"), so a visible title
          would be duplication — it stays for screen readers and the document
          outline (same call as the knowledge and review pages). */}
      <h1 className="visually-hidden">{t('wiki.title')}</h1>

      <div className={s.toolbar}>
        <div className={s.search} role="search" aria-label={t('wiki.searchAria')}>
          <Icon name="search" size={15} className={s.searchIcon} />
          <input
            type="search"
            className={`form-input ${s.searchInput}`}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t('wiki.searchPlaceholder')}
            aria-label={t('wiki.searchAria')}
          />
        </div>
        <label className={s.scope}>
          <span className={s.scopeLabel}>{t('wiki.scopeLabel')}</span>
          <select
            className={s.select}
            value={scope}
            onChange={e => setScope(Number(e.target.value))}
          >
            <option value={0}>{t('wiki.scopeAll')}</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      </div>

      {error ? (
        <ErrorBanner message={error} onRetry={() => setToken(n => n + 1)} />
      ) : loading ? (
        <div className={s.list} aria-hidden>
          <div className="skeleton skeleton-text" style={{ height: 56 }} />
          <div className="skeleton skeleton-text" style={{ height: 56 }} />
          <div className="skeleton skeleton-text" style={{ height: 56 }} />
        </div>
      ) : pages.length === 0 ? (
        searching ? (
          <div className="empty-state small">
            <div className="empty-icon"><Icon name="search" size={32} /></div>
            <h3>{t('wiki.noMatchTitle')}</h3>
            <p>{t('wiki.noMatchMsg')}</p>
          </div>
        ) : (
          <div className="empty-state large">
            <div className="empty-icon"><Icon name="file-text" size={32} /></div>
            <h3>{t('wiki.emptyTitle')}</h3>
            <p>{t('wiki.emptyMsg')}</p>
            <div className="empty-actions">
              <Link to="/review" className="btn btn-secondary">{t('wiki.emptyLink')}</Link>
            </div>
          </div>
        )
      ) : (
        <>
          {/* Live result count, as quiet metadata: the list below it says the
              same thing by existing. */}
          <div className={s.resultCount} aria-live="polite">
            {t('wiki.resultCount', { count: pages.length })}
          </div>
          <ul className={s.list}>
            {pages.map(p => (
              <li key={p.id}>
                <Link to={`/wiki/${p.id}`} className={s.row}>
                  <span className={s.rowHead}>
                    <span className={`${s.kindBadge} ${s['kindBadge_' + p.kind] ?? ''}`}>
                      {t(`wiki.kind_${p.kind}`, p.kind)}
                    </span>
                    <span className={s.rowTitle}>{p.title || p.slug}</span>
                    <span className={`${s.scopeBadge} ${p.project_id === 0 ? s.scopeBadgeGlobal : ''}`}>
                      {p.project_id === 0 ? t('wiki.scopeGlobal') : projectName(p.project_id)}
                    </span>
                  </span>
                  <span className={s.rowSlug}>{p.slug}</span>
                  <span className={s.rowSnippet}>{p.snippet}</span>
                  <span className={s.rowDate}>{p.updated_at.slice(0, 10)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
