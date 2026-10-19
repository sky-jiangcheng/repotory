import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { triggerScan, importClaudeMemory, runBackupNow, updateConfig } from '../../api/client'
import s from './ActionsTab.module.css'

interface Props {
  // Full config map from the settings page: the remote-backup (ADR-0025 L2)
  // form seeds its inputs from the backup_remote_* keys.
  initialConfig: Record<string, string>
  showMessage: (msg: string) => void
}

export default function ActionsTab({ initialConfig, showMessage }: Props) {
  const { t } = useTranslation()
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [backingUp, setBackingUp] = useState(false)
  // Remote backup (ADR-0025 L2): an S3-compatible push of the daily snapshot.
  // Defaults all empty = zero egress; nothing here dials anything, the form
  // only persists config keys for the backend's upload flow to consult.
  const [remoteOn, setRemoteOn] = useState(initialConfig.backup_remote_enabled === '1')
  const [remote, setRemote] = useState({
    endpoint: initialConfig.backup_remote_endpoint ?? '',
    bucket: initialConfig.backup_remote_bucket ?? '',
    prefix: initialConfig.backup_remote_prefix ?? '',
    accessKey: initialConfig.backup_remote_access_key ?? '',
    secretKey: initialConfig.backup_remote_secret_key ?? '',
  })
  const [savingRemote, setSavingRemote] = useState(false)

  const handleRescan = async () => {
    setSaving(true)
    try {
      await triggerScan()
      showMessage(t('settings.rescanDone'))
    } catch (e: unknown) {
      showMessage(t('settings.rescanFailedMsg', { msg: e instanceof Error ? e.message : t('common.unknownError') }))
    } finally {
      setSaving(false)
    }
  }

  const handleBackup = async () => {
    setBackingUp(true)
    try {
      const path = await runBackupNow()
      showMessage(t('settings.backupDone', { path }))
    } catch (e: unknown) {
      showMessage(t('settings.backupFailed', { msg: e instanceof Error ? e.message : t('common.unknownError') }))
    } finally {
      setBackingUp(false)
    }
  }

  const handleRemoteToggle = (on: boolean) => {
    setRemoteOn(on)
    void persistRemote(
      { backup_remote_enabled: on ? '1' : '0' },
      on ? t('settings.backupRemoteOn') : t('settings.backupRemoteOff'),
    )
  }

  const persistRemote = async (kv: Record<string, string>, ok: string) => {
    setSavingRemote(true)
    try {
      for (const [k, v] of Object.entries(kv)) {
        await updateConfig(k, v)
      }
      showMessage(ok)
    } catch (e: unknown) {
      showMessage(t('settings.saveFailedMsg', { msg: e instanceof Error ? e.message : t('common.unknownError') }))
    } finally {
      setSavingRemote(false)
    }
  }

  const handleRemoteSave = () => {
    const kv: Record<string, string> = {
      backup_remote_endpoint: remote.endpoint.trim(),
      backup_remote_bucket: remote.bucket.trim(),
      backup_remote_prefix: remote.prefix.trim(),
      backup_remote_access_key: remote.accessKey.trim(),
      backup_remote_secret_key: remote.secretKey,
    }
    void persistRemote(kv, t('settings.backupRemoteSaved'))
  }

  const handleImport = async () => {
    setImporting(true)
    try {
      const r = await importClaudeMemory()
      showMessage(t('settings.importDone', { created: r.synced, updated: r.updated, skipped: r.skipped }))
    } catch (e: unknown) {
      showMessage(t('settings.importFailed', { msg: e instanceof Error ? e.message : t('common.unknownError') }))
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="settings-section">
      {/* Two independent maintenance actions, split into groups so neither
          reads as the page's single primary action. */}
      <section className="settings-group">
        <h2 className="settings-group-title">{t('settings.groupRescan')}</h2>
        <p className="section-desc">{t('settings.actionsDesc')}</p>
        <div className={s.actionRow}>
          <button className="btn btn-primary" onClick={handleRescan} disabled={saving}>
            {saving ? t('common.scanning') : t('settings.rescanAll')}
          </button>
        </div>
      </section>

      <section className="settings-group">
        <h2 className="settings-group-title">{t('settings.backupTitle')}</h2>
        <p className="section-desc">{t('settings.backupDesc')}</p>
        <div className={s.actionRow}>
          <button className="btn btn-primary" onClick={handleBackup} disabled={backingUp}>
            {backingUp ? t('settings.backingUp') : t('settings.backupNow')}
          </button>
        </div>
        <p className="section-desc">{t('settings.backupRemoteHint')}</p>
        <div className={s.actionRow}>
          <button
            className="btn btn-secondary"
            onClick={() => handleRemoteToggle(!remoteOn)}
            disabled={savingRemote}
            aria-pressed={remoteOn}
          >
            {remoteOn ? t('settings.backupRemoteOnShort') : t('settings.backupRemoteOffShort')}
          </button>
        </div>
        {remoteOn && (
          <div className={s.remoteGrid}>
            <label>
              <span>{t('settings.backupRemoteEndpoint')}</span>
              <input
                className="form-input"
                value={remote.endpoint}
                onChange={(e) => setRemote({ ...remote, endpoint: e.target.value })}
                placeholder="https://s3.example.com"
              />
            </label>
            <label>
              <span>{t('settings.backupRemoteBucket')}</span>
              <input
                className="form-input"
                value={remote.bucket}
                onChange={(e) => setRemote({ ...remote, bucket: e.target.value })}
              />
            </label>
            <label>
              <span>{t('settings.backupRemotePrefix')}</span>
              <input
                className="form-input"
                value={remote.prefix}
                onChange={(e) => setRemote({ ...remote, prefix: e.target.value })}
                placeholder="repotory"
              />
            </label>
            <label>
              <span>{t('settings.backupRemoteAccessKey')}</span>
              <input
                className="form-input"
                value={remote.accessKey}
                onChange={(e) => setRemote({ ...remote, accessKey: e.target.value })}
              />
            </label>
            <label>
              <span>{t('settings.backupRemoteSecretKey')}</span>
              <input
                className="form-input"
                type="password"
                value={remote.secretKey}
                onChange={(e) => setRemote({ ...remote, secretKey: e.target.value })}
              />
            </label>
            <div className={s.actionRow}>
              <button className="btn btn-primary" onClick={handleRemoteSave} disabled={savingRemote}>
                {savingRemote ? t('settings.saving') : t('settings.backupRemoteSave')}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="settings-group">
        <h2 className="settings-group-title">{t('settings.importClaudeTitle')}</h2>
        <p className="section-desc" dangerouslySetInnerHTML={{ __html: t('settings.importClaudeDesc') }} />
        <div className={s.actionRow}>
          <button className="btn btn-primary" onClick={handleImport} disabled={importing}>
            {importing ? t('settings.importing') : t('settings.importClaudeAction')}
          </button>
          <Link to="/knowledge" className="btn btn-secondary">{t('settings.gotoKnowledge')}</Link>
        </div>
      </section>
    </div>
  )
}
