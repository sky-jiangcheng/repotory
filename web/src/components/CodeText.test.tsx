import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import CodeText from './CodeText'

// Node access lives in helpers rather than at the call site: the
// testing-library rules (no-container / no-node-access) fire on direct
// container access — Review.test.tsx uses the same shape for its section
// helpers.
function tags(selector: string): string[] {
  return Array.from(document.querySelectorAll(selector)).map(el => el.tagName.toLowerCase())
}

function textsOf(selector: string): string[] {
  return Array.from(document.querySelectorAll(selector)).map(el => el.textContent ?? '')
}

function bodyText(): string {
  return document.body.textContent ?? ''
}

describe('CodeText', () => {
  it('renders <code> as an element and everything else as text', () => {
    render(<CodeText text="插件放在 <code>plugins/</code> 目录里" />)
    expect(textsOf('code')).toEqual(['plugins/'])
    expect(bodyText()).toContain('插件放在')
    expect(bodyText()).toContain('目录里')
  })

  it('renders several code spans in one string', () => {
    render(<CodeText text="<code>a</code> 和 <code>b</code>" />)
    expect(textsOf('code')).toEqual(['a', 'b'])
  })

  // The point of the component: a locale value is data, so it must never be
  // able to introduce markup of its own.
  it('never interprets anything but <code> as HTML', () => {
    render(<CodeText text={'<img src=x onerror="alert(1)">'} />)
    expect(tags('img')).toHaveLength(0)
    expect(bodyText()).toContain('<img src=x onerror="alert(1)">')
  })

  it('does not execute a script tag smuggled through a locale value', () => {
    render(<CodeText text={'<script>alert(1)</script>'} />)
    expect(tags('script')).toHaveLength(0)
    expect(bodyText()).toContain('<script>alert(1)</script>')
  })
})
