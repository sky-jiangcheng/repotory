import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import DOMPurify from 'dompurify'
import Icon from '../components/Icon'
import { getProjects, listAllTags, searchAll, type Project, type SearchHit } from '../api/client'
import { useApiData } from '../hooks/useApiData'
import s from './Search.module.css'

// Search is the top-level global search page (ADR-0024). It replaces the
// inline search box the old home memory ring carried: one big input, results
// grouped by 项目 / 笔记 / 待办, and the query mirrored into ?q= so
// recommendations and deep links stay addressable.
//
// Strings live in the `search` namespace (locales/*/search.json), referenced
// with the `search:` prefix from the default common namespace. The idle
// (no-query) state is the recommendation surface: hot projects ranked
// client-side by recent personal additions, with starred/repo count
// tiebreakers, and hot tags from ListAllTags that fill the input on click.
//
// Ranking uses Project.my_added_7d (a 7-day window), not the single-day
// my_added: GetProjects anchors my_added on yesterday, so on any day without
// personal commits every project scores 0 and the "hot" ordering silently
// degenerates to alphabetical. All of it reuses existing endpoints — no new
// backend surface.
export default function Search() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  // ?q= 是唯一的深链入口，而 URL 是**外部事实**：站内跳转、浏览器前进后退都会
  // 改它。输入框是本地事实，两边要能对齐。
  //
  // 之前只在挂载时读一次 ?q=：站内跳到 /search?q=xxx 时输入框仍是上一次的
  // 内容，深链静默失效，紧接着又被下面的 effect 反写成旧值——深链入口形同
  // 虚设，而且失败得很安静（URL 显示的是新词，搜出来的是旧词的结果）。
  const urlQuery = searchParams.get('q') ?? ''
  const [query, setQuery] = useState(urlQuery)
  // 我们最后写进 URL 的值：用来区分「外部改了 URL」和「我们自己刚写的那一次
  // 还没生效」。react-router 的 navigate 走 transition（低优先级），在它生效
  // 之前从 URL 读到的还是旧值——那次旧值不是外部改动。
  const written = useRef(urlQuery)

  // 外部改动（站内深链 / 浏览器前进后退）→ 以 URL 为准重置输入框。
  //
  // 依赖是 urlQuery：只有 URL **真的变了**才会跑这个 effect。react-router
  // 的 transition 会先渲染一次旧 URL，那次渲染不会触发它——所以打字打到一半
  // 不会被旧值清空（早先的版本正是在渲染期直接比对 URL，因此踩了这个坑）。
  useEffect(() => {
    if (urlQuery !== written.current) setQuery(urlQuery)
  }, [urlQuery, setQuery])
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searched, setSearched] = useState(false)
  const [searching, setSearching] = useState(false)
  const [failed, setFailed] = useState(false)

  // Shared caches: the projects list is the same one the command palette and
  // dashboard use; tags join it so the recommendation row costs one request.
  const { data: projectsData } = useApiData(() => getProjects(undefined, false), [], { cacheKey: 'projects:all' })
  const { data: tagsData } = useApiData(() => listAllTags(), [], { cacheKey: 'tags:all' })

  // Debounced search + URL mirroring, both keyed on the query. setSearchParams
  // is referentially stable in react-router, so the sync cannot loop.
  useEffect(() => {
    const q = query.trim()
    // 记下我们写进 URL 的值：上面的同步 effect 据此判断「URL 变成别的值」
    // 是不是外部改动。
    written.current = q
    setSearchParams(q ? { q } : {}, { replace: true })
    if (!q) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHits([]); setSearched(false); setSearching(false); setFailed(false)
      return
    }
    let cancelled = false
    // Loading is the debounced-search lifecycle itself, not a derived value: a
    // render-time derivation cannot know a fetch is in flight. The catch used
    // to collapse failure into "no results" — a downed local service read as an
    // empty corpus, which is the one interpretation a user must never make.
    setSearching(true); setFailed(false)
    const timer = setTimeout(() => {
      searchAll(q)
        .then(r => { if (!cancelled) { setHits(r ?? []); setSearched(true); setFailed(false); setSearching(false) } })
        .catch(() => { if (!cancelled) { setHits([]); setSearched(true); setFailed(true); setSearching(false) } })
    }, 150)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [query, setSearchParams])

  const noteHits = useMemo(() => hits.filter(h => h.type === 'note'), [hits])
  const todoHits = useMemo(() => hits.filter(h => h.type === 'todo'), [hits])

  // Project-name matches are client-side over the shared projects list —
  // the same fallback the command palette offers.
  const projectHits = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return [] as Project[]
    return (projectsData ?? []).filter(p => p.name.toLowerCase().includes(q)).slice(0, 8)
  }, [projectsData, query])

  const hotProjects = useMemo(() => {
    return [...(projectsData ?? [])]
      .sort((a, b) =>
        b.my_added_7d - a.my_added_7d ||
        Number(b.is_starred) - Number(a.is_starred) ||
        b.repo_count - a.repo_count ||
        a.name.localeCompare(b.name))
      .slice(0, 6)
  }, [projectsData])

  const hotTags = useMemo(() => (tagsData ?? []).slice(0, 12), [tagsData])

  const noResults = searched && !failed
    && noteHits.length === 0 && todoHits.length === 0 && projectHits.length === 0

  return (
    <div className={s.page}>
      <h1 className={s.title}>{t('search:title', { defaultValue: '全局搜索' })}</h1>

      <input
        type="search"
        className={`search-input ${s.bigInput}`}
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={t('search:placeholder', { defaultValue: '搜索笔记、待办与项目…' })}
        aria-label={t('search:title', { defaultValue: '全局搜索' })}
        autoFocus
      />

      {searched || searching ? (
        <div className={s.results} aria-label={t('search:results', { defaultValue: '搜索结果' })}>
          {searching && (
            <div className={s.loadingRow} role="status">
              {t('search:searching', { defaultValue: '正在检索…' })}
            </div>
          )}
          {failed && (
            <div className={s.errorRow}>
              {t('search:searchFailed', { defaultValue: '检索失败——请确认本地服务在运行后重试' })}
            </div>
          )}

          {projectHits.length > 0 && (
            <section className={s.group} aria-label={t('search:groupProjects', { defaultValue: '项目' })}>
              <h2 className={s.groupTitle}>
                {t('search:groupProjects', { defaultValue: '项目' })}
                <span className={s.groupCount}>{projectHits.length}</span>
              </h2>
              <ul className={s.rowList}>
                {projectHits.map(p => (
                  <li key={p.id}>
                    <Link to={`/project/${p.id}`} className={s.row}>
                      <span className={`${s.typeBadge} ${s.typeProject}`}>{t('commandPalette.projectMark', { defaultValue: '项目' })}</span>
                      <span className={s.rowBody}>
                        <span className={s.rowTitle}>{p.name}</span>
                        <span className={s.rowSub}>
                          {t('commandPalette.reposCount', { count: p.repo_count })}
                          {' · '}+{p.my_added_7d}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {noteHits.length > 0 && (
            <section className={s.group} aria-label={t('search:groupNotes', { defaultValue: '笔记' })}>
              <h2 className={s.groupTitle}>
                {t('search:groupNotes', { defaultValue: '笔记' })}
                <span className={s.groupCount}>{noteHits.length}</span>
              </h2>
              <ul className={s.rowList}>
                {noteHits.map(h => <HitRow key={`note-${h.id}`} hit={h} t={t} />)}
              </ul>
            </section>
          )}

          {todoHits.length > 0 && (
            <section className={s.group} aria-label={t('search:groupTodos', { defaultValue: '待办' })}>
              <h2 className={s.groupTitle}>
                {t('search:groupTodos', { defaultValue: '待办' })}
                <span className={s.groupCount}>{todoHits.length}</span>
              </h2>
              <ul className={s.rowList}>
                {todoHits.map(h => <HitRow key={`todo-${h.id}`} hit={h} t={t} />)}
              </ul>
            </section>
          )}

          {noResults && (
            <div className={s.noResults}>
              <p>{t('search:noResults', { defaultValue: '没有匹配的结果' })}</p>
              {hotTags.length > 0 && <p className={s.noResultsHint}>{t('search:tryHotTags', { defaultValue: '试试从热门标签开始' })}</p>}
            </div>
          )}

          <div className="visually-hidden" role="status" aria-live="polite">
            {searching
              ? ''
              : failed
                ? t('search:searchFailed', { defaultValue: '检索失败——请确认本地服务在运行后重试' })
                : noResults
                  ? t('search:noResults', { defaultValue: '没有匹配的结果' })
                  : t('search:resultsCount', { count: hits.length + projectHits.length, defaultValue: '{{count}} 条结果' })}
          </div>
        </div>
      ) : (
        <div className={s.reco}>
          <section className={s.group} aria-label={t('search:hotProjects', { defaultValue: '热门项目' })}>
            <h2 className={s.groupTitle}>
              {t('search:hotProjects', { defaultValue: '热门项目' })}
              <span className={s.groupHint}>{t('search:hotProjectsSub', { defaultValue: '按最近个人新增排序' })}</span>
            </h2>
            <ul className={s.hotGrid}>
              {hotProjects.map(p => (
                <li key={p.id}>
                  <Link to={`/project/${p.id}`} className={s.hotCard}>
                    <span className={s.hotName}>
                      {p.is_starred && <Icon name="star" size={12} filled />}
                      {p.name}
                    </span>
                    <span className={s.hotSub}>
                      {t('commandPalette.reposCount', { count: p.repo_count })}
                      {' · '}
                      {t('search:recentAdded', { count: p.my_added_7d, defaultValue: '近 7 天 +{{count}}' })}
                    </span>
                  </Link>
                </li>
              ))}
              {hotProjects.length === 0 && (
                <li className={s.recoEmpty}>{t('search:noHotProjects', { defaultValue: '还没有项目数据——先在设置里配置扫描目录' })}</li>
              )}
            </ul>
          </section>

          <section className={s.group} aria-label={t('search:hotTags', { defaultValue: '热门标签' })}>
            <h2 className={s.groupTitle}>
              {t('search:hotTags', { defaultValue: '热门标签' })}
              <span className={s.groupHint}>{t('search:hotTagsHint', { defaultValue: '点击标签立即检索' })}</span>
            </h2>
            <div className={s.tagRow}>
              {hotTags.map(tag => (
                <button type="button" key={tag} className={s.tagChip} onClick={() => setQuery(tag)}>
                  {tag}
                </button>
              ))}
              {hotTags.length === 0 && (
                <span className={s.recoEmpty}>{t('search:noHotTags', { defaultValue: '笔记里还没有标签' })}</span>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

// One search hit row — shared between the notes and todos groups. The snippet
// comes back from FTS5 with <mark> highlights; DOMPurify keeps the same
// sanitization contract as the command palette and the old home ring.
function HitRow({ hit, t }: { hit: SearchHit; t: TFunction }) {
  return (
    <li>
      <Link to={`/project/${hit.project_id}`} className={s.row}>
        <span className={`hit-type-${hit.type} ${s.typeBadge}`}>
          {hit.type === 'note'
            ? t('commandPalette.noteMark', { defaultValue: '笔记' })
            : t('commandPalette.todoMark', { defaultValue: '待办' })}
        </span>
        <span className={s.rowBody}>
          <span className={s.rowTitle}>{hit.title}</span>
          <span className={s.rowSub}>
            {hit.project_name} · <span dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(hit.snippet.slice(0, 80)) }} />
          </span>
        </span>
      </Link>
    </li>
  )
}
