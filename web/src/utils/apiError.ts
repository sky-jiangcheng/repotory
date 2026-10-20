// Minimal structural type so this module does not depend on i18next's own types.
type Translate = (key: string) => string

// The backend now answers domain questions with domain sentences
// (`project not found`, `note not found`, …), but a storage-level failure can
// still reach a caller as raw SQLite text — `constraint failed: FOREIGN KEY
// constraint failed (787)`, `sql: no rows in result set`,
// `UNIQUE constraint failed: projects.root_path (2067)`. Showing those verbatim
// inside a Chinese UI is both unreadable and unactionable, so every write path
// funnels its error through here first.
//
// Order matters: a domain prefix wins even when the wrapped storage error is
// still attached (`project not found: sql: no rows in result set` must read as
// "project not found", not as the generic "record is gone").
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^note not found/i, 'errors.noteNotFound'],
  [/^repository not found/i, 'errors.repoNotFound'],
  [/^project not found/i, 'errors.projectNotFound'],
  [/^title is required/i, 'errors.titleRequired'],
  [/merge up requires explicit confirmation/i, 'errors.mergeNeedsConfirmation'],
  [/UNIQUE constraint failed: projects\.root_path/i, 'errors.pathTaken'],
  [/FOREIGN KEY constraint failed/i, 'errors.projectNotFound'],
  [/no rows in result set/i, 'errors.recordGone'],
]

/** Turn an unknown error into text the user can act on; unknown errors pass
 *  through unchanged rather than being swallowed. */
export function describeApiError(t: Translate, err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const message = raw.trim()
  if (!message) return ''
  for (const [pattern, key] of RULES) {
    if (pattern.test(message)) return t(key)
  }
  return message
}
