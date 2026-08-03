import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PersistentRendererAgentState,
  type RendererStateCipher
} from '../agentJournal/PersistentRendererAgentState'

const roots: string[] = []
const cipher: RendererStateCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (value) =>
    Buffer.from(`protected:${Buffer.from(value, 'utf8').toString('base64')}`),
  decryptString: (value) => {
    const text = value.toString('utf8')
    if (!text.startsWith('protected:')) throw new Error('Invalid cipher text')
    return Buffer.from(text.slice('protected:'.length), 'base64').toString(
      'utf8'
    )
  }
}

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'envcad-state-'))
  roots.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((value) =>
      rm(value, { recursive: true, force: true })
    )
  )
})

describe('PersistentRendererAgentState', () => {
  it('atomically restores protected turn and draft state across owners', async () => {
    const directory = await root()
    const first = new PersistentRendererAgentState(directory, cipher)
    first.saveSync('envcad.agent.turn-session.v2', '{"turn":"active"}')
    await first.save('envcad.agent.drafts.v1', '{"composer":"exact"}')

    const reopened = new PersistentRendererAgentState(directory, cipher)
    expect(reopened.load('envcad.agent.turn-session.v2')).toBe(
      '{"turn":"active"}'
    )
    expect(reopened.load('envcad.agent.drafts.v1')).toBe(
      '{"composer":"exact"}'
    )
    const bytes = await readFile(path.join(directory, 'assistant-drafts.bin'))
    expect(bytes.toString('utf8')).not.toContain('{"composer":"exact"}')
  })

  it('serializes asynchronous writes so the latest draft wins', async () => {
    const directory = await root()
    const store = new PersistentRendererAgentState(directory, cipher)

    await Promise.all([
      store.save('envcad.agent.drafts.v1', 'first'),
      store.save('envcad.agent.drafts.v1', 'second'),
      store.save('envcad.agent.drafts.v1', 'third')
    ])

    expect(store.load('envcad.agent.drafts.v1')).toBe('third')
  })

  it('fails closed for unavailable encryption and corrupt files', async () => {
    const directory = await root()
    const unavailable = new PersistentRendererAgentState(directory, {
      ...cipher,
      isEncryptionAvailable: () => false
    })
    expect(() =>
      unavailable.saveSync('envcad.agent.drafts.v1', 'private')
    ).toThrow('protected storage')

    const store = new PersistentRendererAgentState(directory, cipher)
    store.saveSync('envcad.agent.drafts.v1', 'valid')
    await writeFile(
      path.join(directory, 'assistant-drafts.bin'),
      Buffer.from('corrupt')
    )
    expect(() => store.load('envcad.agent.drafts.v1')).toThrow('corrupt')
  })
})
