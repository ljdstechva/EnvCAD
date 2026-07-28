import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EXPECTED_CODEX_CLI_VERSION,
  discoverCodexExecutable,
  isCodexAuthenticatedWithChatGpt
} from '../codexExecutable'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function fakeExecutable(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'envcad-codex-'))
  directories.push(directory)
  const executable = path.join(directory, 'codex.exe')
  await writeFile(executable, '')
  return executable
}

describe('Codex executable discovery', () => {
  it('canonicalizes a native executable and requires version 0.145.0 exactly', async () => {
    const executable = await fakeExecutable()
    const runner = vi.fn(async () => ({
      exitCode: 0,
      output: `codex-cli ${EXPECTED_CODEX_CLI_VERSION}`
    }))
    await expect(
      discoverCodexExecutable({
        environment: { PATH: path.dirname(executable) },
        runner
      })
    ).resolves.toEqual({
      status: 'ready',
      executablePath: executable,
      version: EXPECTED_CODEX_CLI_VERSION
    })
    expect(runner).toHaveBeenCalledWith(executable, ['--version'], undefined)
  })

  it('marks a different version incompatible without falling back', async () => {
    const executable = await fakeExecutable()
    await expect(
      discoverCodexExecutable({
        environment: { PATH: path.dirname(executable) },
        runner: vi.fn(async () => ({
          exitCode: 0,
          output: 'codex-cli 0.999.0'
        }))
      })
    ).resolves.toMatchObject({
      status: 'incompatible',
      version: '0.999.0',
      expectedVersion: EXPECTED_CODEX_CLI_VERSION
    })
  })

  it('accepts only the existing ChatGPT login mode', async () => {
    const executable = await fakeExecutable()
    await expect(
      isCodexAuthenticatedWithChatGpt(executable, {
        runner: vi.fn(async () => ({
          exitCode: 0,
          output: 'Logged in using ChatGPT'
        }))
      })
    ).resolves.toBe(true)
    await expect(
      isCodexAuthenticatedWithChatGpt(executable, {
        runner: vi.fn(async () => ({
          exitCode: 0,
          output: 'Logged in using API key'
        }))
      })
    ).resolves.toBe(false)
  })
})
