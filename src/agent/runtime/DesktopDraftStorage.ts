import type {
  DurableAgentStateKey,
  EnvCadDesktopApi
} from '../../../desktop/runtimeProtocol'
import type { KeyValueStorage } from './DurableTurnSession'

const SAVE_DEBOUNCE_MS = 150

/**
 * Mirrors drafts to origin storage for fast reloads and to encrypted
 * main-process storage for recovery across random renderer origins.
 */
export class DesktopDraftStorage implements KeyValueStorage {
  private pendingValue: string | undefined
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly key: DurableAgentStateKey,
    private readonly desktop: EnvCadDesktopApi,
    private readonly fallback: KeyValueStorage | undefined,
    private readonly onError: (error: Error) => void
  ) {
    globalThis.addEventListener?.('beforeunload', () => this.flushSync())
  }

  getItem(key: string): string | null {
    this.assertKey(key)
    try {
      return this.desktop.loadAgentState(this.key) ?? this.fallback?.getItem(key) ?? null
    } catch (error) {
      this.onError(asPersistenceError(error))
      return this.fallback?.getItem(key) ?? null
    }
  }

  setItem(key: string, value: string): void {
    this.assertKey(key)
    try {
      this.fallback?.setItem(key, value)
    } catch {
      // The encrypted desktop copy remains authoritative when origin quota is full.
    }
    this.pendingValue = value
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), SAVE_DEBOUNCE_MS)
  }

  private async flush(): Promise<void> {
    const value = this.pendingValue
    this.timer = undefined
    if (value === undefined) return
    try {
      await this.desktop.saveAgentState(this.key, value)
      if (this.pendingValue === value) this.pendingValue = undefined
    } catch (error) {
      this.onError(asPersistenceError(error))
    }
  }

  private flushSync(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (this.pendingValue === undefined) return
    try {
      this.desktop.saveAgentStateSync(this.key, this.pendingValue)
      this.pendingValue = undefined
    } catch (error) {
      this.onError(asPersistenceError(error))
    }
  }

  private assertKey(key: string): void {
    if (key !== this.key) throw new Error('Unsupported assistant draft key.')
  }
}

function asPersistenceError(error: unknown): Error {
  return new Error(
    'EnvCAD could not persist the protected assistant draft.',
    { cause: error }
  )
}
