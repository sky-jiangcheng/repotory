// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'

const callMock = vi.fn()
vi.mock('./transport', () => ({ call: (...args: unknown[]) => callMock(...args) }))

import { listRecentHandoffs, createHandoff } from './memoryEndpoints'

beforeEach(() => {
  callMock.mockReset()
  callMock.mockResolvedValue([])
})

describe('memory endpoint routing contract', () => {
  it('listRecentHandoffs routes to the ListRecentHandoffs binding with the limit', async () => {
    await listRecentHandoffs(10)
    expect(callMock).toHaveBeenCalledWith({
      method: 'ListRecentHandoffs',
      args: [10],
      path: '/handoffs/recent',
    })
  })

  it('listRecentHandoffs defaults the limit and unwraps null to an empty array', async () => {
    callMock.mockResolvedValueOnce(null)
    const got = await listRecentHandoffs()
    expect(callMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'ListRecentHandoffs', args: [10] }),
    )
    expect(got).toEqual([])
  })

  it('createHandoff routes to the CreateHandoff binding with every section', async () => {
    await createHandoff(7, {
      summary: 'shipped the composer',
      changes: ['added the dialog'],
      gotchas: ['the palette overlay traps fixed children'],
    })
    expect(callMock).toHaveBeenCalledWith({
      method: 'CreateHandoff',
      args: [
        7,
        'shipped the composer',
        ['added the dialog'],
        [],
        ['the palette overlay traps fixed children'],
        [],
      ],
    })
  })

  it('createHandoff sends empty arrays for the sections the caller omitted', async () => {
    await createHandoff(1, { summary: 'only a summary' })
    expect(callMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'CreateHandoff', args: [1, 'only a summary', [], [], [], []] }),
    )
  })
})
