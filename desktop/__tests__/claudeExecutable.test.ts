import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EXPECTED_CLAUDE_CODE_VERSION,
  discoverClaudeExecutable,
  isClaudeAuthenticated
} from '../claudeExecutable'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

async function fakeExecutable(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'envcad-claude-'))
  directories.push(directory)
  const executable = path.join(directory, process.platform === 'win32' ? 'claude.exe' : 'claude')
  await writeFile(executable, '')
  return executable
}

describe('Claude executable discovery', () => {
  it('keeps the expected version synchronized with the installed Agent SDK', async () => {
    const packageJson = JSON.parse(
      await readFile(
        path.join(process.cwd(), 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'),
        'utf8'
      )
    ) as { claudeCodeVersion: string }
    expect(EXPECTED_CLAUDE_CODE_VERSION).toBe(packageJson.claudeCodeVersion)
  })

  it('canonicalizes a PATH executable and requires the exact SDK version', async () => {
    const executable = await fakeExecutable()
    const runner = vi.fn(async () => ({
      exitCode: 0,
      stdout: `${EXPECTED_CLAUDE_CODE_VERSION} (Claude Code)`
    }))
    const result = await discoverClaudeExecutable({
      environment: { PATH: path.dirname(executable) },
      runner
    })
    expect(result).toEqual({
      status: 'ready',
      executablePath: executable,
      version: EXPECTED_CLAUDE_CODE_VERSION
    })
    expect(runner).toHaveBeenCalledWith(executable, ['--version'], undefined)
  })

  it('reports an incompatible executable and parses auth status without exposing its fields', async () => {
    const executable = await fakeExecutable()
    const versionRunner = vi.fn(async () => ({ exitCode: 0, stdout: '9.9.9 (Claude Code)' }))
    await expect(
      discoverClaudeExecutable({
        environment: { PATH: path.dirname(executable) },
        runner: versionRunner
      })
    ).resolves.toMatchObject({ status: 'incompatible', version: '9.9.9' })

    const authRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ loggedIn: true, email: 'must-not-be-returned@example.invalid' })
    }))
    await expect(isClaudeAuthenticated(executable, { runner: authRunner })).resolves.toBe(true)
  })
})
