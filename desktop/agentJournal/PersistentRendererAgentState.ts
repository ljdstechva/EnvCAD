import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync
} from 'node:fs'
import path from 'node:path'
import type { DurableAgentStateKey } from '../runtimeProtocol'

const FILE_HEADER = Buffer.from('ENVCAD-AGENT-STATE-V1\0', 'ascii')
const STATE_FILES: Record<DurableAgentStateKey, string> = {
  'envcad.agent.turn-session.v2': 'renderer-turn-session.bin',
  'envcad.agent.drafts.v1': 'assistant-drafts.bin'
}
const STATE_QUOTAS: Record<DurableAgentStateKey, number> = {
  'envcad.agent.turn-session.v2': 64 * 1024 * 1024,
  'envcad.agent.drafts.v1': 512 * 1024 * 1024
}

export interface RendererStateCipher {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

/**
 * Main-process owner for renderer recovery state. Known keys map to fixed files
 * and Windows safeStorage encryption is mandatory before any content is saved.
 */
export class PersistentRendererAgentState {
  private writeQueue = Promise.resolve()
  private temporaryOrdinal = 0

  constructor(
    private readonly directory: string,
    private readonly cipher: RendererStateCipher
  ) {}

  load(key: DurableAgentStateKey): string | null {
    const file = this.filePath(key)
    if (!existsSync(file)) return null
    this.requireEncryption()
    const bytes = readFileSync(file)
    if (
      bytes.length <= FILE_HEADER.length ||
      !bytes.subarray(0, FILE_HEADER.length).equals(FILE_HEADER)
    ) {
      throw new Error('Persisted assistant recovery state is corrupt.')
    }
    const value = this.cipher.decryptString(bytes.subarray(FILE_HEADER.length))
    this.validateValue(key, value)
    return value
  }

  saveSync(key: DurableAgentStateKey, value: string): void {
    this.validateValue(key, value)
    this.requireEncryption()
    mkdirSync(this.directory, { recursive: true })
    const encrypted = this.cipher.encryptString(value)
    const bytes = Buffer.concat([FILE_HEADER, encrypted])
    const target = this.filePath(key)
    const temporary = `${target}.tmp-${process.pid}-${++this.temporaryOrdinal}`
    let handle: number | undefined
    try {
      handle = openSync(temporary, 'wx', 0o600)
      writeAll(handle, bytes)
      fsyncSync(handle)
      closeSync(handle)
      handle = undefined
      renameSync(temporary, target)
    } finally {
      if (handle !== undefined) closeSync(handle)
      rmSync(temporary, { force: true })
    }
  }

  save(key: DurableAgentStateKey, value: string): Promise<void> {
    const pending = this.writeQueue.then(() => this.saveSync(key, value))
    this.writeQueue = pending.catch(() => undefined)
    return pending
  }

  private filePath(key: DurableAgentStateKey): string {
    return path.join(this.directory, STATE_FILES[key])
  }

  private validateValue(key: DurableAgentStateKey, value: string): void {
    if (typeof value !== 'string') {
      throw new Error('Assistant recovery state must be serialized text.')
    }
    if (Buffer.byteLength(value, 'utf8') > STATE_QUOTAS[key]) {
      throw new Error(
        'Assistant recovery state exceeds its disclosed local safety quota.'
      )
    }
  }

  private requireEncryption(): void {
    if (!this.cipher.isEncryptionAvailable()) {
      throw new Error(
        'Windows protected storage is unavailable; assistant recovery state was not written.'
      )
    }
  }
}

function writeAll(handle: number, bytes: Buffer): void {
  let offset = 0
  while (offset < bytes.length) {
    const written = writeSync(handle, bytes, offset, bytes.length - offset)
    if (written <= 0) throw new Error('Assistant recovery state write stalled.')
    offset += written
  }
}
