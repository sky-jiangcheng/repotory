// api/updateStatus.ts — the app-wide state of "is there a newer version?".
//
// Why a store instead of local component state. Two places need the answer:
// the navigation bar (a badge that appears when a newer release exists) and
// the Settings → Updates tab (the full card). If each ran its own check, the
// app would hit GitHub's API twice per launch and the two could disagree —
// a badge saying "up to date" next to a card saying "2.13.0 available" is
// worse than either alone.
//
// The module holds one snapshot and notifies subscribers, the same shape the
// connection-kind tracker in transport.ts uses for the same reason.
//
// The check is advisory end to end: it reports what GitHub published and
// nothing more. Nothing here downloads or installs anything.

import { checkUpdate, getConfig } from './endpoints'
import { isDesktopRuntime } from './transport'
import type { UpdateInfo } from './types'

export type UpdatePhase =
  /** No check has run yet. */
  | 'idle'
  /** A check is in flight. */
  | 'checking'
  /** The running build is the newest one. */
  | 'current'
  /** A newer release exists. */
  | 'available'
  /** The check failed (network, proxy, GitHub error). */
  | 'error'

export interface UpdateState {
  phase: UpdatePhase
  /** The last successful check's payload; kept across a later failure so a
   *  transient error does not wipe a known-good verdict off the screen. */
  info: UpdateInfo | null
  /** The failure message, empty unless phase === 'error'. */
  error: string
}

const initialState: UpdateState = { phase: 'idle', info: null, error: '' }

let state: UpdateState = initialState
const listeners = new Set<(s: UpdateState) => void>()

function publish(next: UpdateState) {
  state = next
  for (const l of listeners) l(state)
}

/** The current snapshot. */
export function getUpdateState(): UpdateState {
  return state
}

/** Subscribe to state changes; returns an unsubscribe function. */
export function subscribeUpdateState(cb: (s: UpdateState) => void): () => void {
  listeners.add(cb)
  cb(state)
  return () => { listeners.delete(cb) }
}

// One check at a time: a second caller joining an in-flight check waits for
// the same result rather than firing a second GitHub request.
let inFlight: Promise<UpdateState> | null = null

/**
 * Run one update check and publish the verdict.
 *
 * Errors are NOT swallowed: the promise rejects with the backend's message
 * so a caller that asked explicitly (the settings tab) can show it. The
 * published state carries the same message for the badge, which has no
 * place to render a full error.
 */
export function runUpdateCheck(): Promise<UpdateState> {
  if (inFlight) return inFlight
  publish({ ...state, phase: 'checking', error: '' })
  inFlight = checkUpdate()
    .then(info => {
      const next: UpdateState = {
        phase: info.has_update ? 'available' : 'current',
        info,
        error: '',
      }
      publish(next)
      return next
    })
    .catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e)
      // The previous verdict survives a failed re-check: the badge keeps
      // showing a known-newer version rather than silently reverting to
      // "no information".
      publish({ phase: 'error', info: state.info, error: message })
      throw e
    })
    .finally(() => { inFlight = null })
  return inFlight
}

/**
 * The startup check: run one background check unless the user turned it off.
 *
 * Two gates, in this order:
 *   - `update_check_enabled` — the explicit opt-out. Absent means enabled
 *     (matching the backend's own reading of the same key).
 *   - desktop runtime — the check is the desktop app maintaining itself. A
 *     browser tab pointed at a headless server has no use for it, and the
 *     manual button in the settings tab still works there.
 *
 * A failure is swallowed on purpose: a machine that cannot reach GitHub
 * must not see an error banner over the whole app on every launch. The
 * settings tab re-runs the check on demand and shows the message there.
 *
 * Returns the promise so a caller (and a test) can await the outcome; the
 * app's own caller ignores it.
 */
export function startUpdateCheck(): Promise<void> {
  if (!isDesktopRuntime()) return Promise.resolve()
  return getConfig()
    .then(cfg => {
      if (cfg.config?.update_check_enabled === '0') return undefined
      return runUpdateCheck().catch(() => undefined)
    })
    .then(() => undefined)
    .catch(() => undefined)
}
