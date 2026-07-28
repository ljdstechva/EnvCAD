import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { removeRuntimeDirectoryWithRetry } from '../runtimeDirectoryCleanup'

const runtimeDirectory = path.join(
  'C:\\Users\\Test\\AppData\\Local\\EnvCAD\\ai-runtime',
  'session-1234-0123456789abcdef01234567'
)

describe('removeRuntimeDirectoryWithRetry', () => {
  it('retries transient Windows directory locks and removes the exact session target', async () => {
    const busy = Object.assign(new Error('busy'), { code: 'EBUSY' })
    const remove = vi
      .fn()
      .mockRejectedValueOnce(busy)
      .mockRejectedValueOnce(busy)
      .mockResolvedValue(undefined)
    const wait = vi.fn(async () => undefined)

    await removeRuntimeDirectoryWithRetry(runtimeDirectory, {
      remove,
      wait
    })

    expect(remove).toHaveBeenCalledTimes(3)
    expect(remove).toHaveBeenLastCalledWith(path.resolve(runtimeDirectory), {
      recursive: true,
      force: true
    })
    expect(wait).toHaveBeenNthCalledWith(1, 50)
    expect(wait).toHaveBeenNthCalledWith(2, 100)
  })

  it.each([
    'C:\\',
    'C:\\Users\\Test',
    'C:\\Users\\Test\\AppData\\Local\\EnvCAD\\ai-runtime',
    'C:\\Users\\Test\\AppData\\Local\\EnvCAD\\ai-runtime\\other'
  ])('refuses the unsafe cleanup target %s', async (target) => {
    await expect(
      removeRuntimeDirectoryWithRetry(target, { remove: vi.fn() })
    ).rejects.toThrow('invalid EnvCAD AI runtime directory')
  })

  it('does not retry a non-transient filesystem failure', async () => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' })
    const remove = vi.fn().mockRejectedValue(denied)
    await expect(
      removeRuntimeDirectoryWithRetry(runtimeDirectory, {
        remove,
        wait: vi.fn()
      })
    ).rejects.toBe(denied)
    expect(remove).toHaveBeenCalledTimes(1)
  })
})
