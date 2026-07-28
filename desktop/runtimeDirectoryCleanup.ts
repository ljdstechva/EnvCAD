import { rm } from 'node:fs/promises'
import path from 'node:path'

interface RuntimeDirectoryCleanupOptions {
  attempts?: number
  remove?: typeof rm
  wait?: (milliseconds: number) => Promise<void>
}

const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY'])

/**
 * Removes only EnvCAD's explicitly named per-process AI runtime directory.
 * Windows may hold a just-exited child process's cwd briefly, so retry the
 * narrow target instead of leaving temporary session buffers behind.
 */
export async function removeRuntimeDirectoryWithRetry(
  directory: string,
  options: RuntimeDirectoryCleanupOptions = {}
): Promise<void> {
  const resolved = path.resolve(directory)
  if (
    !path.isAbsolute(directory) ||
    path.basename(path.dirname(resolved)).toLowerCase() !== 'ai-runtime' ||
    !/^session-\d+-[a-f0-9]{24}$/i.test(path.basename(resolved))
  ) {
    throw new Error('Refusing to remove an invalid EnvCAD AI runtime directory.')
  }
  const attempts = options.attempts ?? 8
  const remove = options.remove ?? rm
  const wait =
    options.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 20) {
    throw new Error('AI runtime cleanup attempts must be from 1 to 20.')
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await remove(resolved, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!code || !RETRYABLE_CODES.has(code) || attempt === attempts - 1) {
        throw error
      }
      await wait(Math.min(50 * 2 ** attempt, 1_000))
    }
  }
}
