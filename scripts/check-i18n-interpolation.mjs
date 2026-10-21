#!/usr/bin/env node
// scripts/check-i18n-interpolation.mjs — locale 插值语法守卫（CI gate，纯 node、零依赖）。
//
// 背景 / rationale：i18next 的插值语法是双花括号 `{{name}}`。写成单花括号
// `{name}` 不会报错、不会告警、eslint 与 tsc 都看不出来——i18next 把整串当成
// 没有占位符的普通文本原样吐出去，UI 上就出现「待整理 {count}」「(count) 个项目」
// 这种把占位符当字面量展示的界面。2026-10-21 的 GUI 冒烟在知识库页与首页各抓到
// 一处（organizeJump / projectCount），三处全部是同一个成因：手写 locale 时凭直觉
// 用了单花括号。
//
// 这个守卫把「单花括号占位符」变成一条硬门。之所以值得单独一条 CI job 而不塞进
// 现有测试：locale 是纯数据，vitest 不会去读它；而这类错误的发现成本极高——它不在
// 任何断言的失败路径上，只能靠人眼在界面上看见。
//
// 检查口径：
//   1. 单花括号占位符：值里出现 `{ident}` 但不是 `{{...}}` 的一部分 → 报错。
//   2. 占位符孤儿：locale 声明了 `{{name}}`，但整棵 locale 目录里没有任何
//      `.tsx/.ts` 代码把 `name` 作为 t() 的传参传入 → 报错（防止改名后留下的
//      死占位符，它会原样显示在界面上）。
//
// 关于第 2 条的边界：只报「整个 locale 目录都没人传」的，不做逐调用点的精确核对
// ——那需要解析 TS，属于另一个量级的工具。宁可在真实误报时用白名单登记，也不
// 引入一个跑不动的检查。
//
// 运行：node scripts/check-i18n-interpolation.mjs
// 结果：干净 → exit 0；发现占位符问题 → 打印清单并 exit 1。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const localesDir = join(root, 'web/src/locales')
const srcDir = join(root, 'web/src')

// 有意保留单花括号、不参与插值的 locale 值。用正则匹配整串，命中才豁免。
const ALLOW = [
  // CSS-in-JS / PostCSS 之类以 { 开头的内容偶尔会被抄进 locale 当示例；
  // 真出现时在这里登记并写明理由，别让守卫被整体关掉。
]

function walk(dir, exts, base = dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p, exts, base))
    else if (exts.includes(extname(p))) out.push(relative(base, p))
  }
  return out
}

// 占位符名字：字母数字下划线，允许点分层级（i18next 的 keySeparator）。
const IDENT = '[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)*'

// 剥掉所有合法的 {{...}}，剩下的单花括号 {name} 就是漏网的。
const DOUBLE = /\{\{\s*[^}]*\}\}/g
const SINGLE = new RegExp(`\\{\\s*(${IDENT})\\s*\\}`, 'g')

/** 收集一个 JSON 对象树里的所有叶子字符串。 */
function leaves(node, out = []) {
  if (typeof node === 'string') out.push(node)
  else if (Array.isArray(node)) node.forEach(n => leaves(n, out))
  else if (node && typeof node === 'object') Object.values(node).forEach(n => leaves(n, out))
  return out
}

const problems = []

// --- 1. locale 文件扫描 -------------------------------------------------------
const localeFiles = walk(localesDir, ['.json'])
if (localeFiles.length === 0) {
  console.error('no locale files found under web/src/locales — nothing to check')
  process.exit(1)
}

for (const rel of localeFiles) {
  const path = join(localesDir, rel)
  let tree
  try {
    tree = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    problems.push({ file: rel, kind: 'parse', detail: err.message })
    continue
  }

  for (const value of leaves(tree)) {
    if (ALLOW.some(re => re.test(value))) continue
    const stripped = value.replace(DOUBLE, '')
    SINGLE.lastIndex = 0
    let m
    while ((m = SINGLE.exec(stripped)) !== null) {
      problems.push({
        file: rel,
        kind: 'single-brace',
        placeholder: m[1],
        detail: value,
        hint: `i18next 插值是双花括号：${m[0]} → {{${m[1]}}}`,
      })
    }
  }
}

// --- 2. 占位符孤儿：locale 声明了但没人传 ---------------------------------------
// 把所有源码里的 t(...) 调用粗粒度收集成「出现过的标识符」集合。
const srcText = walk(srcDir, ['.ts', '.tsx'])
  .map(rel => readFileSync(join(srcDir, rel), 'utf8'))
  .join('\n')

for (const rel of localeFiles) {
  const tree = JSON.parse(readFileSync(join(localesDir, rel), 'utf8'))
  for (const value of leaves(tree)) {
    DOUBLE.lastIndex = 0
    let m
    while ((m = DOUBLE.exec(value)) !== null) {
      const name = m[0].replace(/^\{\{\s*|\s*\}\}$/g, '')
      if (!name) continue
      // 转成源码里会出现的形态：`{{count}}` → `count`，`{{withRepos}}` → `withRepos`。
      const ident = name.split('.')[0]
      if (!new RegExp(`\\b${ident}\\s*[:,}]`).test(srcText) &&
          !new RegExp(`\\b${ident}\\b`).test(srcText)) {
        problems.push({
          file: rel,
          kind: 'orphan-placeholder',
          placeholder: name,
          detail: value,
          hint: `locale 声明了 {{${name}}}，但源码里找不到同名传参——界面会原样显示占位符`,
        })
      }
    }
  }
}

// --- 输出 ---------------------------------------------------------------------
if (problems.length === 0) {
  console.log(`i18n interpolation OK — ${localeFiles.length} locale file(s) checked`)
  process.exit(0)
}

const byFile = new Map()
for (const p of problems) {
  if (!byFile.has(p.file)) byFile.set(p.file, [])
  byFile.get(p.file).push(p)
}

console.error(`i18n interpolation: ${problems.length} problem(s)\n`)
for (const [file, list] of byFile) {
  console.error(`  web/src/locales/${file}`)
  for (const p of list) {
    if (p.kind === 'parse') {
      console.error(`    [parse] ${p.detail}`)
      continue
    }
    console.error(`    [${p.kind}] ${JSON.stringify(p.detail)}`)
    console.error(`      → ${p.hint}`)
  }
  console.error('')
}
process.exit(1)