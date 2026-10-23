// BrandMark.test.tsx — guards that the app UI uses the real brand mark.
//
// The regression this prevents: the navbar rendered a "▦" text glyph while
// every shipped artifact (app icon, favicon, VS Code extension) carried the
// mark from build/icon.svg. Nothing failed — the glyph just looked like a
// placeholder next to a real icon. These assertions make the mark a hard
// dependency, so swapping it back out breaks a test rather than shipping
// silently.
//
// Second regression these guard: the brand moved from a navy tile to the
// paper card (warm field + hairline ink frame). The UI is generated from
// the same SSOT as the shipped icons, so a half-applied move — card in the
// dock, navy tile in the navbar — would look like two products.

// 本文件的 DOM 访问是**显式登记**而非疏漏（ADR-0026 条件 4）：被测对象是装饰性
// SVG——`aria-hidden` 正是设计意图，所以没有任何 role/name 可查。断言的是
// `<rect>/<path>` 的几何数量与 `aria-hidden` 本身，两者都只能从 DOM 拿；换成
// role 查询等于假装 logo 有可访问语义，会把要测的东西测没。testing-library
// 其余规则在本文件仍然生效。
/* eslint-disable testing-library/no-container, testing-library/no-node-access */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import BrandMark from './BrandMark'

describe('BrandMark', () => {
  it('renders an inline SVG rather than a text glyph', () => {
    const { container } = render(<BrandMark />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    // The old navbar used a bare "▦" character, which inherits font metrics
    // and has no geometry of its own.
    expect(svg!.querySelectorAll('rect, path').length).toBeGreaterThan(1)
  })

  it('carries the paper-card field, not a gradient or a bevel', () => {
    const { container } = render(<BrandMark />)
    const html = container.innerHTML
    // Warm-paper field + near-black ink, the brand SSOT's palette. A blue
    // gradient and a white hairline were what made the old mark read as
    // stock app-icon chrome.
    expect(html).toContain('#F5F0E4')
    expect(html).toContain('#1B1B1B')
    expect(container.querySelector('linearGradient')).toBeNull()
    expect(container.querySelector('clipPath')).toBeNull()
    // The one stroke in the mark is the brand frame itself: the hairline
    // that makes the card read as printed. It is a rect outline, not the
    // old bevel rim on the glyph.
    const stroked = [...container.querySelectorAll('[stroke]')]
    expect(stroked).toHaveLength(1)
    expect(stroked[0].tagName.toLowerCase()).toBe('rect')
    expect(container.querySelector('path')!.getAttribute('stroke')).toBeNull()
  })

  it('draws the mark as one filled path with a real counter', () => {
    const { container } = render(<BrandMark />)
    const mark = container.querySelector('path')!
    // The R is a fill, not a bundle of strokes: strokes at this size are what
    // made the previous mark lose its white and pinch at 16px. Nonzero winding
    // is the typeface's own, so the counter stays a hole.
    expect(mark.getAttribute('fill-rule')).toBe('nonzero')
    expect(mark.getAttribute('stroke')).toBeNull()
    // Two subpaths: outer silhouette + counter.
    expect(mark.getAttribute('d')!.match(/M/g)).toHaveLength(2)
  })

  it('keeps the glyph inside the tile', () => {
    const { container } = render(<BrandMark />)
    const mark = container.querySelector('path')!
    // The letter is scaled and centred by its own transform; without it the
    // glyph renders at its original 340-unit cap and crowds the tile edge.
    const g = mark.closest('g')!
    const scale = Number(/scale\(([\d.]+)\)/.exec(g.getAttribute('transform')!)![1])
    expect(scale).toBeCloseTo(320 / 340, 5)
  })

  it('is hidden from assistive tech unless given a title', () => {
    const { container, rerender } = render(<BrandMark />)
    // Adjacent text already names the product, so the mark is decorative by
    // default — announcing it would double the name for screen readers.
    expect(container.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true')

    rerender(<BrandMark title="Repotory" />)
    const named = screen.getByRole('img', { name: 'Repotory' })
    expect(named).toBeTruthy()
    expect(named.getAttribute('aria-hidden')).toBeNull()
  })
})
