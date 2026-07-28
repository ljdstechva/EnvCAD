import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeLegacyEnvCadClaudeTranscripts } from '../claudeTranscriptCleanup'

const temporaryRoots: string[] = []

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'envcad-claude-cleanup-'))
  temporaryRoots.push(root)
  const homeDirectory = path.join(root, 'home')
  const localAppData = path.join(root, 'local')
  const projectsRoot = path.join(homeDirectory, '.claude', 'projects')
  await mkdir(projectsRoot, { recursive: true })
  const encodedRuntime = path
    .resolve(localAppData, 'EnvCAD', 'ai-runtime')
    .replace(/[^A-Za-z0-9]/g, '-')
  return { homeDirectory, localAppData, projectsRoot, encodedRuntime }
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

describe('removeLegacyEnvCadClaudeTranscripts', () => {
  it('removes only exact EnvCAD runtime project directories', async () => {
    const { homeDirectory, localAppData, projectsRoot, encodedRuntime } =
      await fixture()
    const exact =
      `${encodedRuntime}-session-1234-0123456789abcdef01234567`
    const retained = [
      `${encodedRuntime}-other`,
      `${encodedRuntime}-session-1234-short`,
      'unrelated-project'
    ]
    await mkdir(path.join(projectsRoot, exact))
    await writeFile(path.join(projectsRoot, exact, 'transcript.jsonl'), 'image')
    for (const name of retained) await mkdir(path.join(projectsRoot, name))

    await expect(
      removeLegacyEnvCadClaudeTranscripts({
        homeDirectory,
        localAppData
      })
    ).resolves.toBe(1)
    await expect(readdir(projectsRoot)).resolves.toEqual(retained.sort())
  })

  it('retries transient Windows locks for the exact target', async () => {
    const { homeDirectory, localAppData, projectsRoot, encodedRuntime } =
      await fixture()
    const exact =
      `${encodedRuntime}-session-4321-fedcba987654321001234567`
    await mkdir(path.join(projectsRoot, exact))
    const busy = Object.assign(new Error('busy'), { code: 'EBUSY' })
    const remove = vi
      .fn()
      .mockRejectedValueOnce(busy)
      .mockResolvedValue(undefined)
    const wait = vi.fn(async () => undefined)

    await expect(
      removeLegacyEnvCadClaudeTranscripts({
        homeDirectory,
        localAppData,
        remove,
        wait
      })
    ).resolves.toBe(1)
    expect(remove).toHaveBeenCalledTimes(2)
    expect(wait).toHaveBeenCalledWith(50)
  })
})
