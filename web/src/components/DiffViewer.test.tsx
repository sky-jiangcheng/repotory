// DiffViewer.test.tsx — guards the unified-diff line rendering.
//
// The regression this prevents (found by the 2026-10-24 UI sweep): the
// component emits one <code> per diff line with NO text node between the
// siblings, and inline <code> boxes collapse onto one visual row. Only the
// '+'/'-' variants had `display: block`, so a diff consisting mostly of
// context lines rendered as a single run-on sentence — the diff was
// unreadable exactly when it had nothing dramatic to show.
//
// The CSS fix (`.diffPre code { display: block }`) lives in a .module.css
// file, which vitest does not evaluate — so a DOM-only assertion cannot see
// it. These tests therefore pin the STRUCTURE that the CSS depends on: one
// <code> element per diff line, and the +/- variants tagged with their own
// classes. If someone merges the lines into one <code>, or drops the
// per-line classes, the CSS can no longer colour or line-break them and
// these tests fail.
//
// The actual `display: block` rule is asserted by reading the stylesheet
// through node:fs (same technique as styles/semanticInk.test.ts, because
// import.meta.glob('?raw') returns EMPTY strings for .css under vitest).

// 本文件的 DOM 访问是**显式登记**而非疏漏（ADR-0026 条件 4）：被测对象是 diff
// 的逐行结构——每一行必须是一个独立的 <code> 元素，行数与行内容本身就是断言
// 对象，没有任何 role / name 可查。换成 role 查询等于把「每行一个元素」这个
// 前提从断言里抹掉：只要行被合并成一个 <code>，行数就会变少，而角色查询根本
// 看不见行。testing-library 其余规则在本文件仍然生效。
/* eslint-disable testing-library/no-container, testing-library/no-node-access */
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import DiffViewer from './DiffViewer'

const fsName = 'node:' + 'fs'
const pathName = 'node:' + 'path'
const procName = 'node:' + 'process'

interface NodeFs {
  readFileSync(p: string, enc: string): string
}
interface NodePath {
  resolve(...p: string[]): string
  join(...p: string[]): string
}
interface NodeProcess {
  cwd(): string
}

async function readDiffCss(): Promise<string> {
  const fs = (await import(/* @vite-ignore */ fsName)) as unknown as NodeFs
  const path = (await import(/* @vite-ignore */ pathName)) as unknown as NodePath
  const proc = (await import(/* @vite-ignore */ procName)) as unknown as NodeProcess
  return fs.readFileSync(
    path.resolve(proc.cwd(), 'src/components/DiffViewer.module.css'),
    'utf8',
  )
}

describe('DiffViewer', () => {
  it('emits one <code> element per diff line', () => {
    const text = [' context one', ' context two', '+added', '-removed'].join('\n')
    const { container } = render(<DiffViewer text={text} />)
    const codes = container.querySelectorAll('code')
    expect(codes).toHaveLength(4)
    expect(Array.from(codes).map(c => c.textContent)).toEqual([
      ' context one',
      ' context two',
      '+added',
      '-removed',
    ])
  })

  it('tags added and removed lines with their own classes so the CSS can recolour them', () => {
    const { container } = render(<DiffViewer text={'+added\n-removed\n plain'} />)
    const codes = Array.from(container.querySelectorAll('code'))
    expect(codes[0].className).toContain('diffLineAdd')
    expect(codes[1].className).toContain('diffLineDel')
    expect(codes[2].className).not.toContain('diffLineAdd')
    expect(codes[2].className).not.toContain('diffLineDel')
  })

  it('gives every diff line its own row via display: block on the shared code rule', async () => {
    // The load-bearing CSS rule. Inline <code> siblings collapse onto one
    // row, so without this the context lines of a diff run together and the
    // panel becomes unreadable.
    const css = await readDiffCss()
    expect(css).toMatch(/\.diffPre\s+code\s*\{[^}]*display:\s*block/)
  })
})
