// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'

// Partial mock: override the backend-calling endpoints, keep the rest real.
vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>()
  return {
    ...actual,
    listAIModels: vi.fn(),
    updateConfig: vi.fn(),
    rebuildEmbeddings: vi.fn(),
    testAIChat: vi.fn(),
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key,
  }),
}))

import { listAIModels } from '../../api/client'
import AiTab from './AiTab'

const baseConfig: Record<string, string> = {
  ai_chat_base_url: '',
  ai_chat_model: '',
  ai_chat_api_key: '',
}

function renderTab(config: Record<string, string>) {
  return render(
    <AiTab
      config={config}
      showMessage={() => {}}
      onSaved={() => {}}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  cleanup()
})

describe('AiTab model pull', () => {
  it('does not show a model picker until a fetch has populated it', () => {
    renderTab(baseConfig)
    // 拉取前 models 为空 → 没有 <select>。
    expect(screen.queryByRole('combobox', { name: /model/i })).toBeNull()
  })

  it('auto-selects the first fetched model and shows a visible dropdown', async () => {
    vi.mocked(listAIModels).mockResolvedValue({
      models: ['model-a', 'model-b'], // 后端已按字典序排序
      resolved_base_url: '',
    })
    renderTab({ ...baseConfig, ai_chat_base_url: 'http://localhost:1234/v1' })

    fireEvent.click(screen.getByRole('button', { name: 'settings.ai.fetchModels' }))
    const select = await screen.findByRole('combobox', { name: /model/i })
    // 下拉出现，且默认选中第一个（后端已排序 → model-a 在前）。
    expect((select as HTMLSelectElement).value).toBe('model-a')
  })

  it('lets the user pick a model from the visible dropdown', async () => {
    vi.mocked(listAIModels).mockResolvedValue({
      models: ['model-a', 'model-b'],
      resolved_base_url: '',
    })
    renderTab({ ...baseConfig, ai_chat_base_url: 'http://localhost:1234/v1' })

    fireEvent.click(screen.getByRole('button', { name: 'settings.ai.fetchModels' }))
    const select = (await screen.findByRole('combobox', {
      name: /model/i,
    })) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'model-b' } })
    await waitFor(() =>
      expect((screen.getByRole('combobox', { name: /model/i }) as HTMLSelectElement).value).toBe(
        'model-b',
      ),
    )
  })
})
