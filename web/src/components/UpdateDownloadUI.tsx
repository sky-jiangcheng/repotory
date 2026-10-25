// components/UpdateDownloadUI.tsx — the update download's progress surfaces.
//
// Two surfaces, one state:
//   - a MODAL progress dialog, the primary view (a 100 MB bundle takes long
//     enough that the percentage and the ETA need a home that cannot scroll
//     away);
//   - a CORNER CARD, the minimized form. The user can carry on with the app
//     while the bundle arrives, and still see that it is.
//
// Both read the same snapshot from api/downloadStatus.ts, so they can never
// disagree about the progress. The card is what the modal becomes when the
// user hits "minimize"; the modal reappears when they click the card.
//
// The card lives at the app level (App.tsx) rather than inside the settings
// tab: the download survives navigation, and a progress indicator that
// disappears when the user leaves the settings page is not a progress
// indicator.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  abortUpdateDownload,
  getDownloadSnapshot,
  isDownloading,
  minimizeDownloadModal,
  openDownloadedUpdate,
  openDownloadModal,
  subscribeDownloadState,
  syncDownloadState,
  type DownloadSnapshot,
} from '../api/client'
import Icon from './Icon'
import s from './UpdateDownloadUI.module.css'

/**
 * The download progress UI, mounted once at the app level.
 *
 * It reads the shared snapshot rather than owning any state of its own: the
 * settings tab can start a download, and this component picks it up.
 */
export default function UpdateDownloadUI() {
  const [snapshot, setSnapshot] = useState<DownloadSnapshot>(getDownloadSnapshot())

  useEffect(() => subscribeDownloadState(setSnapshot), [])

  // One read on mount, so a download started before this component mounted
  // (or in another window) is picked up.
  useEffect(() => { void syncDownloadState() }, [])

  const state = snapshot.state
  const active = isDownloading(state)
  // The card shows while a download runs and the modal is minimized, and
  // stays for a finished download until the user dismisses it — a completed
  // download with an "install" button must not vanish on its own.
  const showCard = !snapshot.modalOpen && (active || state.phase === 'done' || state.phase === 'failed')
  const showModal = snapshot.modalOpen && (active || state.phase === 'done' || state.phase === 'failed' || state.phase === 'canceled')

  if (!showCard && !showModal) return null

  return (
    <>
      {showModal && (
        <Modal
          snapshot={snapshot}
          onMinimize={minimizeDownloadModal}
          onCancel={() => { void abortUpdateDownload() }}
          onOpen={() => { void openDownloadedUpdate(state.path) }}
          onDismiss={() => { void abortUpdateDownload() }}
        />
      )}
      {showCard && (
        <CornerCard
          snapshot={snapshot}
          onExpand={openDownloadModal}
          onCancel={() => { void abortUpdateDownload() }}
        />
      )}
    </>
  )
}

interface ModalProps {
  snapshot: DownloadSnapshot
  onMinimize: () => void
  onCancel: () => void
  onOpen: () => void
  onDismiss: () => void
}

/** The modal progress dialog. */
function Modal({ snapshot, onMinimize, onCancel, onOpen, onDismiss }: ModalProps) {
  const { t } = useTranslation()
  const state = snapshot.state
  const active = isDownloading(state)

  return (
    <div className={s.overlay} role="dialog" aria-modal="true" aria-label={t('settings.updates.downloadTitle')}>
      <div className={s.modal}>
        <div className={s.modalHead}>
          <div className={s.headIcon} aria-hidden="true">
            <Icon name="download" size={18} />
          </div>
          <div className={s.headText}>
            <div className={s.modalTitle}>{titleFor(t, state)}</div>
            {state.version && (
              <div className={s.modalVersion}>{t('settings.updates.downloadVersion', { version: state.version })}</div>
            )}
          </div>
        </div>

        <div className={s.progressTrack} role="progressbar" aria-valuenow={Math.round(percent(state))} aria-valuemin={0} aria-valuemax={100}>
          <div className={s.progressFill} style={{ width: `${percent(state)}%` }} />
        </div>

        <div className={s.statsRow}>
          <span className={s.percent}>{Math.round(percent(state))}%</span>
          <span className={s.bytes}>
            {t('settings.updates.downloadBytes', {
              done: formatBytes(state.downloaded),
              total: formatBytes(state.total),
            })}
          </span>
        </div>

        <div className={s.metaRow}>
          <span className={s.meta}>
            {t('settings.updates.downloadSpeed', { speed: formatBytes(state.speed) + '/s' })}
          </span>
          <span className={s.meta}>
            {state.remaining_seconds >= 0
              ? t('settings.updates.downloadRemaining', { time: formatDuration(state.remaining_seconds) })
              : t('settings.updates.downloadRemainingUnknown')}
          </span>
        </div>

        {state.phase === 'verifying' && (
          <p className={s.note}>{t('settings.updates.downloadVerifying')}</p>
        )}
        {state.phase === 'failed' && (
          <p className={s.error} role="alert">{state.error || t('settings.updates.downloadFailed')}</p>
        )}
        {state.phase === 'canceled' && (
          <p className={s.note}>{t('settings.updates.downloadCanceled')}</p>
        )}
        {state.phase === 'done' && (
          <p className={s.success}>
            {state.checksum_verified
              ? t('settings.updates.downloadDoneVerified')
              : t('settings.updates.downloadDoneUnverified')}
          </p>
        )}

        {active && (
          <p className={s.hint}>{t('settings.updates.downloadHint')}</p>
        )}

        <div className={s.modalActions}>
          {state.phase === 'done' ? (
            <>
              <button className="btn btn-secondary" onClick={onDismiss}>{t('settings.updates.downloadLater')}</button>
              <button className="btn btn-primary" onClick={onOpen}>{t('settings.updates.downloadOpenInstaller')}</button>
            </>
          ) : active ? (
            <>
              <button className="btn btn-secondary" onClick={onMinimize}>{t('settings.updates.downloadMinimize')}</button>
              <button className="btn btn-danger" onClick={onCancel}>{t('settings.updates.downloadCancel')}</button>
            </>
          ) : (
            <button className="btn btn-secondary" onClick={onDismiss}>{t('common.close')}</button>
          )}
        </div>
      </div>
    </div>
  )
}

interface CornerCardProps {
  snapshot: DownloadSnapshot
  onExpand: () => void
  onCancel: () => void
}

/** The minimized corner card. */
function CornerCard({ snapshot, onExpand, onCancel }: CornerCardProps) {
  const { t } = useTranslation()
  const state = snapshot.state
  const active = isDownloading(state)

  return (
    <div className={s.corner}>
      <button
        className={s.cornerButton}
        onClick={onExpand}
        aria-label={t('settings.updates.downloadExpand')}
      >
        <span className={s.cornerIcon} aria-hidden="true">
          <Icon name={state.phase === 'done' ? 'check' : 'download'} size={14} />
        </span>
        <span className={s.cornerText}>
          <span className={s.cornerTitle}>
            {state.phase === 'done'
              ? t('settings.updates.downloadDoneShort')
              : t('settings.updates.downloadRunningShort')}
          </span>
          {active && (
            <span className={s.cornerMeta}>
              {Math.round(percent(state))}% · {formatBytes(state.downloaded)} / {formatBytes(state.total)}
            </span>
          )}
          {state.phase === 'failed' && (
            <span className={s.cornerMeta}>{state.error || t('settings.updates.downloadFailed')}</span>
          )}
        </span>
      </button>
      <div className={s.cornerTrack}>
        <div className={s.cornerFill} style={{ width: `${percent(state)}%` }} />
      </div>
      {active && (
        <button className={s.cornerCancel} onClick={onCancel} aria-label={t('settings.updates.downloadCancel')}>
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  )
}

/** The modal's headline, which changes with the phase. */
function titleFor(t: (k: string, o?: Record<string, unknown>) => string, state: DownloadSnapshot['state']): string {
  switch (state.phase) {
    case 'running': return t('settings.updates.downloadRunning')
    case 'verifying': return t('settings.updates.downloadVerifyingTitle')
    case 'done': return t('settings.updates.downloadDoneTitle')
    case 'failed': return t('settings.updates.downloadFailedTitle')
    case 'canceled': return t('settings.updates.downloadCanceledTitle')
    default: return t('settings.updates.downloadTitle')
  }
}

/** The completion percentage, 0 when the total size is unknown. */
function percent(state: DownloadSnapshot['state']): number {
  if (state.total <= 0) return 0
  const p = (state.downloaded / state.total) * 100
  return p > 100 ? 100 : p
}

/** A byte count in the largest unit that keeps it readable. */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  const rounded = i === 0 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${units[i]}`
}

/** A duration in seconds as "1分23秒" / "45秒" / "2小时5分". */
export function formatDuration(seconds: number): string {
  if (seconds < 0) return '—'
  if (seconds < 60) return `${Math.ceil(seconds)}秒`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.ceil(seconds % 60)
  if (minutes < 60) return `${minutes}分${rest}秒`
  const hours = Math.floor(minutes / 60)
  return `${hours}小时${minutes % 60}分`
}
