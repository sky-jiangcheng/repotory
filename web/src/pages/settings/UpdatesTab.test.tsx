// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'

// Partial mock: override the backend-calling endpoints, keep the rest real.
vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>()
  return {
    ...actual,
    getAppVersion: vi.fn(),
    openBrowserURL: vi.fn(),
    updateConfig: vi.fn(),
    runUpdateCheck: vi.fn(),
    subscribeUpdateState: vi.fn(),
    getUpdateState: vi.fn(),
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; version?: string }) => {
      if (key.endsWith('.currentVersion')) return `Current v${opts?.version ?? ''}`
      if (key.endsWith('.latestVersion')) return `Latest v${opts?.version ?? ''}`
      return opts?.defaultValue ?? key
    },
  }),
}))

import {
  getAppVersion, getUpdateState, openBrowserURL, runUpdateCheck, subscribeUpdateState, updateConfig,
} from '../../api/client'
import UpdatesTab from './UpdatesTab'

const noUpdate = {
  current: '2.12.3',
  latest: '2.12.3',
  has_update: false,
  release_url: 'https://example.invalid/release',
  published_at: '2026-10-24T10:00:00Z',
  notes: '',
  assets: [],
  download_url: '',
  download_name: '',
}

const newerVersion = {
  ...noUpdate,
  latest: '2.13.0',
  has_update: true,
  download_url: 'https://example.invalid/repotory-darwin-arm64.dmg',
  download_name: 'repotory-darwin-arm64.dmg',
  notes: '- **shiny** new thing',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getAppVersion).mockResolvedValue('2.12.3')
  vi.mocked(getUpdateState).mockReturnValue({ phase: 'idle', info: null, error: '' })
  vi.mocked(subscribeUpdateState).mockReturnValue(() => {})
})

function renderTab(config: Record<string, string> = {}) {
  return render(<UpdatesTab initialConfig={config} showMessage={() => {}} />)
}

describe('UpdatesTab', () => {
  it('shows the running version before any check has run', async () => {
    renderTab()
    // The version comes from a local read, not from GitHub: a card that could
    // only state your version after a network round trip would sit blank on
    // the very machine that needs the proxy field.
    expect(await screen.findByText('Current v2.12.3')).toBeTruthy()
  })

  it('runs a check when the user clicks the button', async () => {
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'settings.updates.check' }))
    await waitFor(() => expect(runUpdateCheck).toHaveBeenCalled())
  })

  it('opens the platform bundle in the system browser, not the release page', async () => {
    vi.mocked(getUpdateState).mockReturnValue({ phase: 'available', info: newerVersion, error: '' })
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'settings.updates.download' }))
    await waitFor(() =>
      expect(openBrowserURL).toHaveBeenCalledWith('https://example.invalid/repotory-darwin-arm64.dmg'),
    )
  })

  it('falls back to the release page when the release has no bundle for this platform', async () => {
    vi.mocked(getUpdateState).mockReturnValue({
      phase: 'available',
      info: { ...newerVersion, download_url: '', download_name: '' },
      error: '',
    })
    renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'settings.updates.download' }))
    await waitFor(() => expect(openBrowserURL).toHaveBeenCalledWith('https://example.invalid/release'))
  })

  it('persists the auto-check switch under update_check_enabled', async () => {
    renderTab({ update_check_enabled: '1' })
    fireEvent.click(screen.getByRole('button', { name: 'settings.updates.autoCheckLabel' }))
    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith('update_check_enabled', '0'),
    )
  })

  it('persists the proxy under update_proxy', async () => {
    renderTab()
    fireEvent.change(screen.getByLabelText('settings.updates.proxyLabel'), {
      target: { value: 'http://127.0.0.1:7890' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'settings.save' }))
    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith('update_proxy', 'http://127.0.0.1:7890'))
  })
})
