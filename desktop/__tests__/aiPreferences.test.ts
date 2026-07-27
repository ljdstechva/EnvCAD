import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AiPreferencesStore,
  defaultAiPreferences,
  parseAiPreferences
} from '../aiPreferences'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'envcad-preferences-'))
  directories.push(directory)
  const filePath = path.join(directory, 'settings', 'ai-preferences.json')
  const logger = { warn: vi.fn() }
  return { directory, filePath, logger, store: new AiPreferencesStore(filePath, logger) }
}

describe('AI preferences', () => {
  it('uses Claude as the safe existing-user default when no file exists', async () => {
    const { store } = await fixture()
    await expect(store.load()).resolves.toEqual(defaultAiPreferences())
    expect(defaultAiPreferences().selectedProvider).toBe('claude-code')
  })

  it('atomically saves and replaces only strict non-secret preferences', async () => {
    const { filePath, store } = await fixture()
    const first = {
      schemaVersion: 1 as const,
      selectedProvider: 'openai-codex' as const,
      lastSelectedModels: { 'openai-codex': 'gpt-test' },
      lastSelectedEfforts: {
        'openai-codex': { 'gpt-test': 'medium' }
      }
    }
    await expect(store.save(first)).resolves.toEqual(first)
    await expect(store.load()).resolves.toEqual(first)

    const second = {
      ...first,
      selectedProvider: 'claude-code' as const,
      lastSelectedModels: { 'claude-code': 'default' }
    }
    await store.save(second)
    await expect(store.load()).resolves.toEqual(second)
    expect(
      (await readdir(path.dirname(filePath))).filter((name) =>
        name.endsWith('.tmp')
      )
    ).toEqual([])
  })

  it('recovers from corrupt settings without exposing their contents', async () => {
    const { filePath, logger, store } = await fixture()
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, '{not-json')

    await expect(store.load()).resolves.toEqual(defaultAiPreferences())
    expect(logger.warn).toHaveBeenCalledWith(
      'AI preferences were invalid and safe defaults were restored.'
    )
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('not-json')
  })

  it('rejects unknown keys, unknown providers, unbounded values, and secret-like values', () => {
    expect(() =>
      parseAiPreferences({
        ...defaultAiPreferences(),
        credentials: 'not allowed'
      })
    ).toThrow('strict object')
    expect(() =>
      parseAiPreferences({
        ...defaultAiPreferences(),
        selectedProvider: 'other'
      })
    ).toThrow('selectedProvider')
    expect(() =>
      parseAiPreferences({
        ...defaultAiPreferences(),
        lastSelectedModels: {
          'openai-codex': 'sk-proj-never-persist'
        }
      })
    ).toThrow('invalid provider or value')
  })
})
