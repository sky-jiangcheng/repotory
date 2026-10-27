#!/usr/bin/env node
// scripts/check-i18n-keys.mjs — locale 词条覆盖守卫（CI gate，纯 node、零依赖）。
//
// 背景 / rationale：i18next 的词条缺失是「静默失败」——`t('home.thinking')` 在
// 任何 locale 里都取不到值时，i18next 返回 key 本身，不抛错、不告警，tsc 与 eslint
// 也看不出来。只有当调用点顺手写了 `defaultValue` 时更隐蔽：英文界面会安静地显示
// 中文默认值，界面看起来是「翻译得不完整」，而不是「坏了」，于是没人会去查。
//
// 2026-10-25 的前端审计抓到的正是这一类：有 7 个 key（home.thinking /
// home.sourceGraph / home.sourceSemantic / home.sourceFact / home.sourceFts /
// project.linkSuggestions / project.applyWikilink）在中英两份 locale 里都不存在，
// 英文界面于是硬编码着「思考中」「图谱」「向量」「事实」「全文」「双链建议:」。
// 这类缺陷不可能靠 review 发现，也不可能靠任何单元测试发现：locale 是纯数据，
// vitest 根本不去读它。
//
// 这个守卫把七件事变成硬门：
//
//   1. 词条覆盖：代码里静态引用到的每个 key，必须在每个 locale 的对应 namespace
//      里都存在（i18next 的 `nsSeparator` 默认是 `:`，所以 `search:xxx` 是
//      namespace 语法，不是 key 的一部分）。
//   2. 跨语言漂移：同一 namespace 下，各 locale 的 base key 集合必须完全一致。
//      一边加了新词条、另一边忘了翻译，会在这里被拦下。
//   3. 复数基键：i18next v21+ 的复数后缀（`_zero/_one/_two/_few/_many/_other`）
//      是 locale 专属的，可以只存在于某个 locale；但只要某个 locale 用了复数变体，
//      它就必须同时有 base key —— 否则 count=1 时会一路回落到「查无此词条」。
//   4. 英文残留中文：英文 locale 的值里不允许残留中文（含全角标点）。这一条把
//      「英文界面出现中文」从一个靠眼力发现的问题变成机器判定的问题。
//   5. 源码里的硬编码中文：界面文案压根没走 i18next、直接写死在 JSX 里，是英文
//      界面出现中文的第二条路径，locale 检查看不见它。
//   6. 动态键族：模板字面量 key（`t(`project.tab_${key}`)`）的静态前缀必须在每个
//      locale 都对应一个非空键族。
//   7. 翻译文本不得当 HTML 注入：`dangerouslySetInnerHTML` 里直接塞 `t(...)` 的
//      返回值，等于把词条变成注入点。
//
// 已知盲区（有意不做，报不出来而不是假装覆盖）：
//   - 动态 key：`t(someVar)` 无法静态求值。代码里的 `t(opt.labelKey)`、`t(key)`
//     这类调用会被单独计数并打印，不报错。
//   - 模板字面量 key：`t(`project.tab_${key}`)` 取静态前缀当作「键族」，只要求该
//     键族在每个 locale 至少存在一个成员；具体成员对不对得上，靠下面第 1 条的
//     base key 漂移检查兜底。
//   - 调用点上的 `defaultValue`：本仓有大量 `t('x', { defaultValue: '中文' })`。
//     它们在 key 存在时永远不会被读到（第 1 条保证 key 一定存在），因此不再逐条
//     清理；但如果哪天 key 被删了，第 1 条会先在 CI 上失败，而不是让 defaultValue
//     悄悄接管。
//
// 运行：node scripts/check-i18n-keys.mjs
// 结果：干净 → exit 0；发现覆盖问题 → 打印清单并 exit 1。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const localesDir = join(root, 'web/src/locales')
const srcDir = join(root, 'web/src')

// i18next 默认 namespace（web/src/i18n/index.ts 的 defaultNS）。
const DEFAULT_NS = 'common'

// i18next v21+ 的复数后缀。pluralSeparator 默认 '_'。
const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other']

// 有意在英文 locale 里保留中文的词条。逐条登记理由，不要整体关掉这条检查。
const ALLOW_CJK_IN_EN = [
  // 例：某个只在中文界面出现的专有名词，需要在英文文档里保留原样。
]

// 有意留在源码里的中文（不是界面文案）。逐条登记理由，不要整体关掉这条检查。
const ALLOW_CJK_IN_SRC = [
  {
    file: 'App.tsx',
    pattern: /中文/,
    reason: '语言选项自身的名字——zh-CN 这个语言就叫「中文」，两种界面都该显示它',
  },
  {
    file: 'pages/ProjectDetail.tsx',
    pattern: /不存在/,
    reason: '用来识别后端返回的中文错误文案，不是界面文案',
  },
  {
    file: 'utils/markdown.ts',
    pattern: /（/,
    reason: 'markdown 强调解析要认中文全角括号，属于正则字符类的一部分',
  },
]

// 中日韩统一表意文字 + CJK 标点 + 全角字符。英文 locale 里出现它们即视为未翻译。
//
// 区间用码位写死、在运行时拼出正则，而不是在源码里写字面量区间（`一-鿿` 之类）：
// 字面量区间的两个端点字符一旦被编辑器或工具链归一化，区间就会悄悄变成一个
// 覆盖大片码位的错误范围——本文件第一版就踩过：`豈` 实际落在 U+8C48 而非
// U+F900，区间从 U+F900-FAFF 变成了 U+8C48-FAFF，连 emoji 都被判成中文。
// 码位写法没有这个歧义，而且文件里全是 ASCII。
const CJK_RANGES = [
  [0x3000, 0x303f], // CJK 符号与标点
  [0x3400, 0x4dbf], // 扩展 A
  [0x4e00, 0x9fff], // 基本区
  [0xf900, 0xfaff], // 兼容表意文字
  [0xfe30, 0xfe4f], // 兼容形式
  [0xff00, 0xffef], // 全角形式
]
const BACKSLASH = String.fromCharCode(92)
const CJK = new RegExp(
  '[' +
    CJK_RANGES.map(([lo, hi]) => `${BACKSLASH}u${lo.toString(16)}-${BACKSLASH}u${hi.toString(16)}`).join('') +
    ']',
)

function walk(dir, exts, base = dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p, exts, base))
    else if (exts.includes(extname(p))) out.push(relative(base, p))
  }
  return out
}

/** 把一棵 JSON 树摊平成 { 点分路径 → 叶子值 }。 */
function flatten(node, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(node)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else out.set(key, v)
  }
  return out
}

/** 数一棵子树里有多少个叶子。 */
function countLeaves(node) {
  if (!node || typeof node !== 'object') return 0
  let n = 0
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) n += countLeaves(v)
    else n += 1
  }
  return n
}

// --- 载入 locale ------------------------------------------------------------
if (!statSync(localesDir).isDirectory()) {
  console.error(`no locale directory at ${relative(root, localesDir)} — nothing to check`)
  process.exit(1)
}

const localeCodes = readdirSync(localesDir)
  .filter(name => statSync(join(localesDir, name)).isDirectory())
  .sort()

if (localeCodes.length === 0) {
  console.error('no locales found under web/src/locales — nothing to check')
  process.exit(1)
}

/** bundles: locale → Map(ns → { tree, leaves }) */
const bundles = new Map()
const problems = []

for (const loc of localeCodes) {
  const nsMap = new Map()
  const files = readdirSync(join(localesDir, loc)).filter(f => f.endsWith('.json')).sort()
  for (const file of files) {
    const ns = file.replace(/\.json$/, '')
    const raw = readFileSync(join(localesDir, loc, file), 'utf8')
    let tree
    try {
      tree = JSON.parse(raw)
    } catch (err) {
      problems.push({ kind: 'parse', file: `${loc}/${file}`, detail: err.message, hint: 'JSON 解析失败' })
      continue
    }
    nsMap.set(ns, { tree, leaves: flatten(tree) })
  }
  bundles.set(loc, nsMap)
}

// --- namespace 一致性 -------------------------------------------------------
const nsSets = new Map()
for (const [loc, nsMap] of bundles) nsSets.set(loc, [...nsMap.keys()].sort().join(','))
const allNs = [...new Set([...nsSets.values()])]
if (allNs.length > 1) {
  for (const [loc, ns] of nsSets) {
    if (ns !== allNs[0]) {
      problems.push({
        kind: 'ns-mismatch',
        file: loc,
        detail: `namespace 集合是 ${ns}，其他 locale 是 ${allNs[0]}`,
        hint: '每个 locale 必须提供同样的 namespace 文件',
      })
    }
  }
}
const namespaces = [...new Set([...bundles.values()].flatMap(m => [...m.keys()]))].sort()

// --- 复数变体判定 -----------------------------------------------------------
// `X_suffix` 只有在 base `X` 至少在一个 locale 存在时才算复数变体；否则它就是
// 一个普通 key（开发者本意就叫 some_one 之类）。判定跨 locale 做一次，避免把
// 合法词条误判成「少了基键」。
/** pluralBase: ns → (path → base | null) */
const pluralBase = new Map()
for (const ns of namespaces) {
  const union = new Set()
  for (const nsMap of bundles.values()) {
    const b = nsMap.get(ns)
    if (b) for (const p of b.leaves.keys()) union.add(p)
  }
  const perPath = new Map()
  for (const nsMap of bundles.values()) {
    const b = nsMap.get(ns)
    if (!b) continue
    for (const p of b.leaves.keys()) {
      let base = null
      for (const s of PLURAL_SUFFIXES) {
        if (p.endsWith(s) && union.has(p.slice(0, -s.length))) {
          base = p.slice(0, -s.length)
          break
        }
      }
      perPath.set(p, base)
    }
  }
  pluralBase.set(ns, perPath)
}

// --- 从源码收集 t() 调用 ----------------------------------------------------
const srcFiles = walk(srcDir, ['.ts', '.tsx']).filter(rel => {
  if (/\.test\.[jt]sx?$/.test(rel)) return false
  if (rel.split('/').includes('test')) return false
  if (rel.includes('__tests__')) return false
  return true
})

const T_CALL = /\bt\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`)/g

const staticKeys = new Map()  // key → [{ file, line }]
const families = new Map()   // 静态前缀 → [{ file, line }]
let dynamicCalls = 0

const unquote = s => s.replace(/\\(.)/g, '$1')

for (const rel of srcFiles) {
  const text = readFileSync(join(srcDir, rel), 'utf8')
  T_CALL.lastIndex = 0
  let m
  while ((m = T_CALL.exec(text)) !== null) {
    const line = text.slice(0, m.index).split('\n').length
    const raw = m[1] ?? m[2] ?? m[3]
    const isTemplate = m[3] !== undefined
    if (isTemplate && raw.includes('${')) {
      // 动态模板：取第一个插值点之前的静态前缀当作键族。
      const prefix = raw.slice(0, raw.indexOf('${'))
      if (!prefix) { dynamicCalls += 1; continue }
      const list = families.get(prefix) ?? []
      list.push({ file: rel, line })
      families.set(prefix, list)
      continue
    }
    const key = unquote(raw)
    if (!key) { dynamicCalls += 1; continue }
    const list = staticKeys.get(key) ?? []
    list.push({ file: rel, line })
    staticKeys.set(key, list)
  }
  // 动态 key：首参不是字符串字面量的调用（如 t(opt.labelKey) / t(key)）。
  // 只统计，不报错——静态求值做不到。
  const dyn = text.match(/\bt\(\s*(?!'|"|`)/g)
  if (dyn) dynamicCalls += dyn.length
}

// --- 1. 词条覆盖 ------------------------------------------------------------
/** 在某个 namespace 的树里解析点分 key。 */
const resolveKey = (nsTree, key) => {
  if (!nsTree) return { ok: false, reason: 'ns-missing' }
  let cur = nsTree
  for (const part of key.split('.')) {
    if (cur && typeof cur === 'object' && part in cur) cur = cur[part]
    else return { ok: false, reason: 'missing' }
  }
  if (cur && typeof cur === 'object') return { ok: false, reason: 'branch' }
  return { ok: true }
}

for (const [key, sites] of [...staticKeys].sort()) {
  const [ns, rest] = key.includes(':') ? key.split(':', 2) : [DEFAULT_NS, key]
  if (!namespaces.includes(ns)) {
    problems.push({
      kind: 'unknown-ns',
      file: sites[0].file,
      line: sites[0].line,
      detail: key,
      hint: `namespace ${ns} 不存在（现有：${namespaces.join(', ')}）`,
    })
    continue
  }
  if (!rest) {
    problems.push({
      kind: 'empty-key',
      file: sites[0].file,
      line: sites[0].line,
      detail: key,
      hint: 'key 为空',
    })
    continue
  }
  for (const [loc, nsMap] of bundles) {
    const b = nsMap.get(ns)
    if (!b) continue
    const r = resolveKey(b.tree, rest)
    if (r.ok) continue
    const hint = r.reason === 'branch'
      ? '指向了一个分支（对象），不是词条'
      : `在 ${loc}/${ns}.json 里找不到`
    problems.push({
      kind: 'missing-key',
      file: sites[0].file,
      line: sites[0].line,
      detail: key,
      locale: loc,
      hint,
    })
  }
}

// --- 2. 跨语言漂移 ----------------------------------------------------------
for (const ns of namespaces) {
  const perPath = pluralBase.get(ns)
  const baseSets = new Map() // locale → Set(base key)
  for (const [loc, nsMap] of bundles) {
    const b = nsMap.get(ns)
    if (!b) continue
    const set = new Set()
    for (const p of b.leaves.keys()) set.add(perPath.get(p) ?? p)
    baseSets.set(loc, set)
  }
  const all = new Set()
  for (const s of baseSets.values()) for (const k of s) all.add(k)
  for (const [loc, set] of baseSets) {
    const missing = [...all].filter(k => !set.has(k)).sort()
    for (const k of missing) {
      problems.push({
        kind: 'drift',
        file: `${loc}/${ns}.json`,
        detail: k,
        locale: loc,
        hint: '其他 locale 有这个词条，这个 locale 没有',
      })
    }
  }
}

// --- 3. 复数基键 ------------------------------------------------------------
for (const [loc, nsMap] of bundles) {
  for (const [ns, b] of nsMap) {
    const perPath = pluralBase.get(ns)
    if (!perPath) continue
    for (const p of b.leaves.keys()) {
      const base = perPath.get(p)
      if (!base) continue
      if (b.leaves.has(base)) continue
      problems.push({
        kind: 'plural-without-base',
        file: `${loc}/${ns}.json`,
        detail: `${p} → ${base}`,
        locale: loc,
        hint: '用了复数变体却没有 base key，count=1 时会回落到「查无此词条」',
      })
    }
  }
}

// --- 4. 键族存在性（动态模板的静态前缀）------------------------------------
for (const [prefix, sites] of [...families].sort()) {
  const [ns, rest] = prefix.includes(':') ? prefix.split(':', 2) : [DEFAULT_NS, prefix]
  if (!namespaces.includes(ns) || !rest) {
    problems.push({
      kind: 'unknown-ns',
      file: sites[0].file,
      line: sites[0].line,
      detail: prefix,
      hint: `namespace ${ns} 不存在（现有：${namespaces.join(', ')}）`,
    })
    continue
  }
  for (const [loc, nsMap] of bundles) {
    const b = nsMap.get(ns)
    if (!b) continue
    let count = 0
    if (rest.endsWith('.')) {
      // 前缀落在完整路径上：要求它是一个非空的分支。
      let cur = b.tree
      let reachable = true
      for (const part of rest.slice(0, -1).split('.')) {
        if (cur && typeof cur === 'object' && part in cur) cur = cur[part]
        else { reachable = false; break }
      }
      if (reachable && cur && typeof cur === 'object') count = countLeaves(cur)
    } else {
      // 前缀落在半截词上（如 project.tab_）：只要该 locale 里有同前缀的成员即可。
      for (const p of b.leaves.keys()) if (p.startsWith(rest)) count += 1
    }
    if (count > 0) continue
    problems.push({
      kind: 'missing-family',
      file: sites[0].file,
      line: sites[0].line,
      detail: prefix,
      locale: loc,
      hint: `键族「${prefix}」在 ${loc}/${ns}.json 里一个成员都没有`,
    })
  }
}

// --- 5. 英文 locale 的中文残留 ----------------------------------------------
for (const [loc, nsMap] of bundles) {
  if (loc.toLowerCase().startsWith('zh')) continue
  for (const [ns, b] of nsMap) {
    for (const [p, v] of b.leaves) {
      if (typeof v !== 'string') continue
      if (!CJK.test(v)) continue
      const id = `${loc}/${ns}.json:${p}`
      if (ALLOW_CJK_IN_EN.some(a => a.key === id)) continue
      problems.push({
        kind: 'untranslated',
        file: `${loc}/${ns}.json`,
        detail: `${p} = ${JSON.stringify(v.slice(0, 60))}`,
        locale: loc,
        hint: '英文 locale 里残留中文——英文界面会直接显示出来',
      })
    }
  }
}

// --- 6. 源码里的硬编码中文 --------------------------------------------------
// 前五条都盯着 locale 文件，但英文界面出现中文还有第二条路径：界面文案压根没走
// i18next，直接写死在 JSX 里。locale 检查看不见它，只能扫源码。
// 排除两类不算漏网的：① 注释；② `defaultValue`——第 1 条已经保证 key 一定存在，
// 它永远读不到（既有写法，全仓两百多处），不算「漏网的硬编码」。
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g
const LINE_COMMENT = /(^|[^:])\/\/.*$/
const DEFAULT_VALUE = /defaultValue\s*:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g

for (const rel of srcFiles) {
  let text = readFileSync(join(srcDir, rel), 'utf8')
  text = text.replace(BLOCK_COMMENT, '')
  text = text.replace(DEFAULT_VALUE, "defaultValue: ''")
  text.split('\n').forEach((line, idx) => {
    const code = line.replace(LINE_COMMENT, '$1')
    if (!CJK.test(code)) return
    const snippet = code.trim()
    if (!snippet) return
    if (ALLOW_CJK_IN_SRC.some(a => a.file === rel && a.pattern.test(snippet))) return
    problems.push({
      kind: 'hardcoded-cjk',
      file: rel,
      line: idx + 1,
      detail: snippet.slice(0, 80),
      hint: '源码里写死了中文——英文界面会直接显示出来，应走 locale',
    })
  })
}

// --- 7. 翻译文本不得当 HTML 注入 --------------------------------------------
// `dangerouslySetInnerHTML={{ __html: t('...') }}` 等于把「词条」变成注入点：
// 哪天有人把某个词条改成含 `<img onerror=…>` 的字符串，就直接在界面上执行了。
// 已经消毒过的内容（DOMPurify.sanitize / renderMarkdown）不在此列。
const DANGEROUS_TRANSLATION = /dangerouslySetInnerHTML\s*=\s*\{\{\s*__html\s*:\s*t\(/g

for (const rel of srcFiles) {
  const text = readFileSync(join(srcDir, rel), 'utf8')
  DANGEROUS_TRANSLATION.lastIndex = 0
  let m
  while ((m = DANGEROUS_TRANSLATION.exec(text)) !== null) {
    problems.push({
      kind: 'html-injection',
      file: rel,
      line: text.slice(0, m.index).split('\n').length,
      detail: m[0],
      hint: '翻译文本不得当 HTML 注入——用 CodeText 之类只认固定标签的组件渲染',
    })
  }
}

// --- 输出 ---------------------------------------------------------------------
const referenced = staticKeys.size
const summary = `i18n key coverage — ${localeCodes.length} locale(s), ${namespaces.join('/')} ns, ` +
  `${referenced} 个静态 key，${families.size} 个动态键族，${dynamicCalls} 处动态 key 无法静态校验`

if (problems.length === 0) {
  console.log(`${summary}\ni18n key coverage OK`)
  process.exit(0)
}

const byKind = new Map()
for (const p of problems) {
  const list = byKind.get(p.kind) ?? []
  list.push(p)
  byKind.set(p.kind, list)
}

console.error(`${summary}\ni18n key coverage: ${problems.length} problem(s)\n`)
for (const [kind, list] of byKind) {
  console.error(`  [${kind}] ${list.length}`)
  for (const p of list) {
    const where = p.line ? `${p.file}:${p.line}` : p.file
    console.error(`    ${where}  ${p.detail}`)
    console.error(`      → ${p.hint}`)
  }
  console.error('')
}
process.exit(1)
