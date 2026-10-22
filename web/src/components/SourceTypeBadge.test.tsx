// SourceTypeBadge.test.tsx — guards the derived source-type badge that ADR-0022
// 决策 5 asks for on note cards.
//
// The regression this prevents: the note card used to label a note by its raw
// source name ("Codex", "Opencode", "CodeBuddy Memory"), while the settings
// page labelled the same source by its TYPE ("Agent 记忆" / "会话记录"). Two
// vocabularies for one thing — the user could not tell from a card which
// category it belonged to. The badge now renders the server-derived bucket,
// and the raw name survives only as a tooltip.
//
// The assertions below are the contract the card depends on: a manual note
// stays unbadged, an unknown bucket renders nothing (a source name is not a
// type — guessing would invent a category), and a known bucket gets its own
// tone so the colour means the same thing everywhere.
//
// Absence is asserted through the tooltip rather than through container
// traversal: a rendered badge ALWAYS carries a title ("label · source"), so
// "no element with a title mentioning this source" means the badge was not
// rendered at all. That keeps the assertion on the component's observable
// output instead of on the DOM tree's shape.

import { describe, it, expect, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import i18n from '../i18n' // real i18next instance — a mocked t() would pass even if the key were missing
import SourceTypeBadge from './SourceTypeBadge'

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
})

describe('SourceTypeBadge', () => {
  it('shows the type label for a derived bucket', () => {
    render(<SourceTypeBadge type="agent-import" source="claude" />)
    expect(screen.getByText('Agent 记忆')).toBeTruthy()
  })

  it('renders nothing for a manual note', () => {
    render(<SourceTypeBadge type="manual" source="manual" />)
    expect(screen.queryByTitle(/manual/)).toBeNull()
  })

  it('renders nothing when the type is missing or unknown', () => {
    // A note written before the server sent source_type, or a bucket from a
    // newer server: guessing from the source name would be a second mapping.
    const { unmount } = render(<SourceTypeBadge source="claude" />)
    expect(screen.queryByTitle(/claude/)).toBeNull()
    unmount()

    render(<SourceTypeBadge type="brand-new" source="claude" />)
    expect(screen.queryByTitle(/claude/)).toBeNull()
  })

  it('keeps the raw source name in the tooltip, not in the label', () => {
    render(<SourceTypeBadge type="user-conversation" source="codex" />)
    const badge = screen.getByText('会话记录')
    expect(badge.getAttribute('title')).toContain('codex')
  })

  it('gives each bucket its own tone', () => {
    const { unmount } = render(<SourceTypeBadge type="agent-import" source="claude" />)
    const importedClass = screen.getByText('Agent 记忆').className
    unmount()

    render(<SourceTypeBadge type="project-extract" source="scan" />)
    const extractedClass = screen.getByText('项目提取').className
    expect(importedClass).not.toBe(extractedClass)
  })
})
