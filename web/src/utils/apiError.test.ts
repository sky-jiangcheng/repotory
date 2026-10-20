import { describe, expect, it } from 'vitest'
import { describeApiError } from './apiError'

// The fake `t` returns the key so the test asserts the routing decision itself,
// not the wording (wording lives in locales and is free to change).
const t = (key: string) => key

describe('describeApiError', () => {
  it('routes the storage failures that actually reached the UI', () => {
    expect(describeApiError(t, new Error('constraint failed: FOREIGN KEY constraint failed (787)')))
      .toBe('errors.projectNotFound')
    expect(describeApiError(t, new Error('sql: no rows in result set'))).toBe('errors.recordGone')
    expect(describeApiError(t, new Error(
      'failed to create sub-project: constraint failed: UNIQUE constraint failed: projects.root_path (2067)',
    ))).toBe('errors.pathTaken')
  })

  it('routes the domain sentences the service layer now returns', () => {
    expect(describeApiError(t, new Error('project not found'))).toBe('errors.projectNotFound')
    expect(describeApiError(t, new Error('note not found'))).toBe('errors.noteNotFound')
    expect(describeApiError(t, new Error('repository not found'))).toBe('errors.repoNotFound')
    expect(describeApiError(t, new Error('title is required'))).toBe('errors.titleRequired')
    // Reachable by any HTTP client that calls the binding without the flag.
    expect(describeApiError(t, new Error('merge up requires explicit confirmation')))
      .toBe('errors.mergeNeedsConfirmation')
  })

  // A wrapped error carries both halves: `project not found: sql: no rows …`.
  // If the storage pattern were tested first the user would be told the record
  // is gone when the real problem is that the project does not exist.
  it('prefers the domain prefix over the attached storage text', () => {
    expect(describeApiError(t, new Error('project not found: sql: no rows in result set')))
      .toBe('errors.projectNotFound')
  })

  it('passes anything unknown through rather than swallowing it', () => {
    expect(describeApiError(t, new Error('disk on fire'))).toBe('disk on fire')
    expect(describeApiError(t, 'plain string error')).toBe('plain string error')
  })

  it('returns empty text for an empty or unusable error', () => {
    expect(describeApiError(t, new Error('   '))).toBe('')
    expect(describeApiError(t, undefined)).toBe('')
    expect(describeApiError(t, null)).toBe('')
    // A rejected non-Error value has no message to show; do not print "[object]".
    expect(describeApiError(t, { weird: true })).toBe('')
  })
})
