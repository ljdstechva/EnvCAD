import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'

interface ClaudeTranscriptCleanupOptions {
  homeDirectory: string
  localAppData: string
  attempts?: number
  remove?: typeof rm
  wait?: (milliseconds: number) => Promise<void>
}

const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY'])

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function claudeProjectKey(directory: string): string {
  return path.resolve(directory).replace(/[^A-Za-z0-9]/g, '-')
}

export function envCadClaudeProjectDirectoryPattern(
  localAppData: string
): RegExp {
  const runtimeRoot = path.resolve(localAppData, 'EnvCAD', 'ai-runtime')
  return new RegExp(
    `^${escapeRegExp(claudeProjectKey(runtimeRoot))}` +
      '-session-[0-9]+-[a-f0-9]{24}$',
    'i'
  )
}

/**
 * Removes only legacy Claude transcripts whose project key is an EnvCAD-owned
 * ephemeral AI runtime directory. EnvCAD 0.2.3 disables SDK persistence; this
 * narrow migration clears payloads written by earlier acceptance/dev builds.
 */
export async function removeLegacyEnvCadClaudeTranscripts(
  options: ClaudeTranscriptCleanupOptions
): Promise<number> {
  const homeDirectory = path.resolve(options.homeDirectory)
  const projectsRoot = path.resolve(homeDirectory, '.claude', 'projects')
  if (
    path.dirname(path.dirname(projectsRoot)) !== homeDirectory ||
    path.basename(path.dirname(projectsRoot)).toLowerCase() !== '.claude' ||
    path.basename(projectsRoot).toLowerCase() !== 'projects'
  ) {
    throw new Error('Refusing an invalid Claude projects cleanup root.')
  }

  const projectPattern = envCadClaudeProjectDirectoryPattern(
    options.localAppData
  )
  let entries
  try {
    entries = await readdir(projectsRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  const targets = entries
    .filter((entry) => entry.isDirectory() && projectPattern.test(entry.name))
    .map((entry) => path.resolve(projectsRoot, entry.name))
    .filter((target) => path.dirname(target) === projectsRoot)

  const attempts = options.attempts ?? 8
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 20) {
    throw new Error('Claude transcript cleanup attempts must be from 1 to 20.')
  }
  const remove = options.remove ?? rm
  const wait =
    options.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))

  for (const target of targets) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await remove(target, { recursive: true, force: true })
        break
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (!code || !RETRYABLE_CODES.has(code) || attempt === attempts - 1) {
          throw error
        }
        await wait(Math.min(50 * 2 ** attempt, 1_000))
      }
    }
  }
  return targets.length
}
