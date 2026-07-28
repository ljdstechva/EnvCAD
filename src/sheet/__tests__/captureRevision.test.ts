import { describe, expect, it, vi } from 'vitest'
import { captureWithRevisionRetry } from '../captureRevision'

describe('captureWithRevisionRetry', () => {
  it('discards one stale encode and returns only the retried current revision', async () => {
    const render = vi
      .fn()
      .mockResolvedValueOnce({ revision: 1 })
      .mockResolvedValueOnce({ revision: 2 })
    const rasterize = vi.fn(async (preview: { revision: number }) => ({
      bytesForRevision: preview.revision
    }))
    const onStale = vi.fn()

    await expect(
      captureWithRevisionRetry({
        render,
        rasterize,
        isCurrent: (preview) => preview.revision === 2,
        onStale
      })
    ).resolves.toEqual({
      preview: { revision: 2 },
      raster: { bytesForRevision: 2 }
    })
    expect(render).toHaveBeenCalledTimes(2)
    expect(rasterize).toHaveBeenCalledTimes(2)
    expect(onStale).toHaveBeenCalledTimes(1)
  })

  it('rejects after two document/revision changes instead of returning stale bytes', async () => {
    const onStale = vi.fn()
    await expect(
      captureWithRevisionRetry({
        render: async (attempt) => ({ revision: attempt + 1 }),
        rasterize: async (preview) => ({
          bytesForRevision: preview.revision
        }),
        isCurrent: () => false,
        onStale
      })
    ).rejects.toThrow(
      'changed twice during image capture; no stale image was returned'
    )
    expect(onStale).toHaveBeenCalledTimes(2)
  })
})
