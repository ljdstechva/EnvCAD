import {
  AGENT_PROTOCOL_VERSION,
  type AgentClientCommand,
  type AgentClientEnvelope,
  type AgentConfiguration,
  type WorkspaceRevision
} from '../../../shared/agent-contracts'
import type { SelectionSnapshot, SheetSnapshot } from '../protocol'
import {
  DURABLE_TURN_SESSION_STORAGE_KEY,
  DURABLE_TURN_SESSION_STORAGE_VERSION,
  parseStoredTurnSession,
  type DurableActiveTurn,
  type StoredTurnSession
} from './DurableTurnSessionStorage'

export type {
  DurableActiveTurn,
  DurableTurnProjectionState
} from './DurableTurnSessionStorage'

export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface DurableTurnSessionOptions {
  storage?: KeyValueStorage
  idFactory?: () => string
  now?: () => Date
  onPersistenceError?: (error: Error) => void
}

export class DurableTurnSession {
  private state: StoredTurnSession
  private readonly storage: KeyValueStorage | undefined
  private readonly idFactory: () => string
  private readonly now: () => Date
  private readonly onPersistenceError: (error: Error) => void

  constructor(options: DurableTurnSessionOptions = {}) {
    this.storage = options.storage ?? browserStorage()
    this.idFactory = options.idFactory ?? randomId
    this.now = options.now ?? (() => new Date())
    this.onPersistenceError =
      options.onPersistenceError ??
      ((error) => console.error('[agent-durability]', error))
    this.state = this.load() ?? {
      version: DURABLE_TURN_SESSION_STORAGE_VERSION,
      sessionId: this.idFactory(),
      nextClientSequence: 0
    }
    this.persist(false)
  }

  beginTurn(input: Omit<
    DurableActiveTurn,
    | 'turnId'
    | 'messageId'
    | 'clientSequence'
    | 'timestamp'
    | 'lastServerSequence'
    | 'streamingText'
    | 'accepted'
  >, identifiers?: { turnId: string; messageId: string }): {
    active: DurableActiveTurn
    envelope: AgentClientEnvelope
  } {
    if (this.state.activeTurn) {
      throw new Error('A durable turn is already active.')
    }
    const previous = structuredClone(this.state)
    const active: DurableActiveTurn = {
      ...structuredClone(input),
      turnId: identifiers?.turnId ?? this.idFactory(),
      messageId: identifiers?.messageId ?? this.idFactory(),
      clientSequence: this.allocateSequence(),
      timestamp: this.now().toISOString(),
      lastServerSequence: 0,
      streamingText: '',
      accepted: false,
      projection: {
        status: '',
        activeSkills: [],
        operationReceipts: []
      }
    }
    this.state.activeTurn = active
    try {
      this.persist(true)
    } catch (error) {
      this.state = previous
      throw error
    }
    return {
      active: structuredClone(active),
      envelope: this.submitEnvelope(active)
    }
  }

  submitEnvelope(active = this.state.activeTurn): AgentClientEnvelope {
    if (!active) throw new Error('There is no durable turn draft to submit.')
    return {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      sessionId: this.state.sessionId,
      messageId: active.messageId,
      turnId: active.turnId,
      sequence: active.clientSequence,
      timestamp: active.timestamp,
      payload: {
        type: 'submit_turn',
        ...(active.instructionInputId
          ? { instructionInputId: active.instructionInputId }
          : { text: active.text }),
        referenceInputIds: [...(active.referenceInputIds ?? [])],
        configurationRevision: active.configurationRevision,
        selectionSnapshot: {
          count: active.selectionSnapshot.count,
          units: active.selectionSnapshot.units,
          revision: structuredClone(active.workspaceRevision)
        },
        sheet: structuredClone(active.sheet)
      }
    }
  }

  command(
    payload: AgentClientCommand,
    turnId?: string
  ): AgentClientEnvelope {
    const previousSequence = this.state.nextClientSequence
    const envelope: AgentClientEnvelope = {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      sessionId: this.state.sessionId,
      messageId: this.idFactory(),
      ...(turnId ? { turnId } : {}),
      sequence: this.allocateSequence(),
      timestamp: this.now().toISOString(),
      payload
    }
    try {
      this.persist(true)
      return envelope
    } catch (error) {
      this.state.nextClientSequence = previousSequence
      throw error
    }
  }

  recordServerEvent(
    sequence: number,
    update: {
      accepted?: boolean
      streamingText?: string
      projection?: DurableActiveTurn['projection']
    } = {}
  ): boolean {
    const active = this.state.activeTurn
    if (!active || sequence <= active.lastServerSequence) return true
    active.lastServerSequence = sequence
    if (update.accepted !== undefined) active.accepted = update.accepted
    if (update.streamingText !== undefined) {
      active.streamingText = update.streamingText
    }
    if (update.projection !== undefined) {
      active.projection = structuredClone(update.projection)
    }
    return this.persist(false)
  }

  finishTurn(turnId: string): boolean {
    if (this.state.activeTurn?.turnId !== turnId) return true
    delete this.state.activeTurn
    return this.persist(false)
  }

  get sessionId(): string {
    return this.state.sessionId
  }

  get activeTurn(): DurableActiveTurn | undefined {
    return this.state.activeTurn
      ? structuredClone(this.state.activeTurn)
      : undefined
  }

  private allocateSequence(): number {
    if (this.state.nextClientSequence >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Durable client command sequence is exhausted.')
    }
    this.state.nextClientSequence += 1
    return this.state.nextClientSequence
  }

  private load(): StoredTurnSession | undefined {
    const value = this.storage?.getItem(DURABLE_TURN_SESSION_STORAGE_KEY)
    if (!value) return undefined
    try {
      const parsed = JSON.parse(value) as unknown
      return parseStoredTurnSession(parsed)
    } catch (error) {
      this.onPersistenceError(
        new Error('Stored durable turn state is invalid and cannot be restored.', {
          cause: error
        })
      )
      return undefined
    }
  }

  private persist(required: boolean): boolean {
    if (!this.storage) return true
    try {
      this.storage.setItem(
        DURABLE_TURN_SESSION_STORAGE_KEY,
        JSON.stringify(this.state)
      )
      return true
    } catch (error) {
      const persistenceError = new Error(
        'EnvCAD could not persist durable turn state in protected local storage.',
        { cause: error }
      )
      this.onPersistenceError(persistenceError)
      if (required) throw persistenceError
      return false
    }
  }
}

function browserStorage(): KeyValueStorage | undefined {
  try {
    const desktop = globalThis.window?.envcadDesktop
    if (desktop) {
      return {
        getItem(key) {
          if (key !== DURABLE_TURN_SESSION_STORAGE_KEY) return null
          return desktop.loadAgentState(key)
        },
        setItem(key, value) {
          if (key !== DURABLE_TURN_SESSION_STORAGE_KEY) {
            throw new Error('Unsupported durable turn state key.')
          }
          desktop.saveAgentStateSync(key, value)
        }
      }
    }
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

function randomId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
}
