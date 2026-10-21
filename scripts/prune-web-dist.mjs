#!/usr/bin/env node
// scripts/prune-web-dist.mjs — 清理 web/dist 里本次构建未产出的孤儿 chunk。
//
// 背景 / why this exists. vite.config.ts 设了 `emptyOutDir: false`（此环境的
// 批量删除守卫会拦 Vite 内建的清空），改由构建流程负责清理。但清理一直
// 没落地：npm run build 只做 `tsc && vite build`，vite 自己不清目录，于是
// 每次构建都把新 chunk 写进去、旧 chunk 留在原地。实测累积到 15 份
// elk-*.js（每份 1.4MB，合计 21MB）—— elk 是 mermaid 的图布局引擎，mermaid
// 按需动态 import，所以它本该只有一份。
//
// 这不是"磁盘不好看"的问题。web/dist 被 `go:embed all:web/dist` 整个打进
// 二进制（main.go），孤儿文件直接让可执行文件变大：本地构建的 repotory
// 已达 83.6MB，其中约 21MB 是重复的 elk chunk。
//
// 做法. 读 Vite 产出的 .vite/manifest.json，取出本次构建真实产出的所有
// 资源文件，凡是在 dist/assets 下但不在 manifest 里的，视为孤儿删除。
//
// 关键约束：只删 assets/ 目录下的文件，且只删「manifest 未列出」的那些。
// 理由是 manifest 的覆盖范围只到 Vite 产出的资源——dist 根目录下的
// index.html、favicon.ico、favicon.svg 来自 web/public 与 HTML 入口，
// 不在 manifest 的 file 列表里（manifest 的 index.html 条目指向的是它注入
// 的入口 chunk，不是 HTML 本身）。早期版本按「dist 内未列入 manifest 即孤儿」
// 删过一轮，把 index.html 和 favicon 一起删了，页面直接白屏——所以现在的
// 范围必须严格限定在 assets/。
//
// 降级情形：
//   - 无 manifest → 打印提示并以 0 退出，不删任何东西。宁可留垃圾，不可误删。
//   - manifest 为空 → 同上。
//
// 运行：node scripts/prune-web-dist.mjs [distDir]
// 默认目录：web/dist。CI 里不跑这个脚本（CI 从干净 checkout 构建，没有历史
// 残留可清）；它是本地构建后的整理步骤。

import { readFileSync, existsSync, statSync, unlinkSync, readdirSync } from 'node:fs'
import { join, relative, dirname, sep, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// The argument may be repo-relative (as the npm scripts pass it) or absolute.
const distArg = process.argv[2]
const distDir = !distArg
  ? join(root, 'web', 'dist')
  : isAbsolute(distArg)
    ? resolve(distArg)
    : join(root, distArg)

if (!existsSync(distDir)) {
  console.log(`[prune-web-dist] ${relative(root, distDir)} does not exist — nothing to prune`)
  process.exit(0)
}

const assetsDir = join(distDir, 'assets')
if (!existsSync(assetsDir)) {
  console.log(`[prune-web-dist] no assets/ in ${relative(root, distDir)} — nothing to prune`)
  process.exit(0)
}

const manifestPath = join(distDir, '.vite', 'manifest.json')
if (!existsSync(manifestPath)) {
  console.log(
    `[prune-web-dist] no manifest at ${relative(root, manifestPath)} — ` +
      'cannot tell orphans from live files, skipping (nothing deleted)'
  )
  process.exit(0)
}

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (err) {
  console.error(`[prune-web-dist] manifest is unreadable: ${err.message} — skipping`)
  process.exit(0)
}

// Collect every file the current build produced. The manifest maps an entry
// key to { file, css, assets, ... }; those are output paths relative to the
// outDir root (i.e. they start with "assets/").
const produced = new Set()
for (const entry of Object.values(manifest)) {
  if (!entry || typeof entry !== 'object') continue
  if (typeof entry.file === 'string') produced.add(entry.file)
  if (typeof entry.css === 'string') produced.add(entry.css)
  if (Array.isArray(entry.css)) for (const c of entry.css) produced.add(c)
  if (Array.isArray(entry.assets)) for (const a of entry.assets) produced.add(a)
}

if (produced.size === 0) {
  console.log('[prune-web-dist] manifest lists no files — skipping (nothing deleted)')
  process.exit(0)
}

let deleted = 0
let freed = 0
const failures = []

function walk(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walk(full)
      continue
    }
    const rel = relative(distDir, full).split(sep).join('/')
    if (produced.has(rel)) continue
    try {
      unlinkSync(full)
      deleted++
      freed += st.size
    } catch (err) {
      failures.push(`${rel}: ${err.message}`)
    }
  }
}

// Scope: assets/ ONLY. Everything else in dist (index.html, favicon.*, and
// whatever web/public carries) is copied verbatim by Vite and is NOT listed
// in the manifest — deleting by "not in manifest" at the dist root would take
// the page's own HTML with it.
walk(assetsDir)

if (deleted === 0) {
  console.log(`[prune-web-dist] no orphans in ${relative(root, assetsDir)}`)
} else {
  console.log(
    `[prune-web-dist] pruned ${deleted} orphan file(s) from ${relative(root, assetsDir)}, ` +
      `freed ${(freed / 1024 / 1024).toFixed(1)} MB`
  )
}

if (failures.length > 0) {
  console.error(`[prune-web-dist] ${failures.length} file(s) could not be deleted:`)
  for (const f of failures) console.error(`  ${f}`)
  process.exit(1)
}
