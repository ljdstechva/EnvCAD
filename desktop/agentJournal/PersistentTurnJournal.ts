import path from 'node:path'
import {
  AGENT_PROTOCOL_VERSION,
  agentServerEnvelopeSchema,
  sameWorkspaceRevision,
  turnJournalCommandSchema,
  turnJournalResultSchema,
  type PersistedTurnEventEnvelope,
  type TurnEvent,
  type TurnJournalCommand,
  type TurnJournalPort,
  type TurnJournalResult
} from '../../shared/agent-contracts'
import { TurnJournalIndex } from './TurnJournalIndex'
import {
  createAcceptedState,
  isTerminalEnvelope
} from './TurnJournalReducer'
import {
  appendTurnJournalRecord,
  loadTurnJournalRecords,
  type TurnJournalRecord
} from './TurnJournalRecordFile'

export {
  appendTurnJournalRecord,
  TurnJournalCorruptionError,
  type TurnJournalRecord
} from './TurnJournalRecordFile'

const ACTIVE_TURN_JOURNAL_ROOTS = new Set<string>()

export interface PersistentTurnJournalOptions {
  appendRecord?: typeof appendTurnJournalRecord
  now?: () => Date
}

export class PersistentTurnJournal implements TurnJournalPort {
  private readonly index = new TurnJournalIndex()
  private readonly journalPath: string
  private readonly ownershipKey: string
  private readonly appendRecord: typeof appendTurnJournalRecord
  private readonly now: () => Date
  private loadPromise: Promise<void> | undefined
  private writerQueue: Promise<void> = Promise.resolve()
  private closePromise: Promise<void> | undefined
  private poisoned: Error | undefined
  private lastRecordSequence = 0
  private closing = false
  private closed = false

  constructor(
    rootDirectory: string,
    options: PersistentTurnJournalOptions = {}
  ) {
    const resolvedRoot = path.resolve(rootDirectory)
    this.ownershipKey =
      process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot
    if (ACTIVE_TURN_JOURNAL_ROOTS.has(this.ownershipKey)) {
      throw new Error('Turn journal already has an active process owner.')
    }
    ACTIVE_TURN_JOURNAL_ROOTS.add(this.ownershipKey)
    this.journalPath = path.join(resolvedRoot, 'turn-events.jsonl')
    this.appendRecord = options.appendRecord ?? appendTurnJournalRecord
    this.now = options.now ?? (() => new Date())
  }

  execute(command: TurnJournalCommand): Promise<TurnJournalResult> {
    const parsed = turnJournalCommandSchema.parse(command)
    return this.enqueue(async () => {
      if (parsed.type === 'accept-turn') return this.acceptTurn(parsed)
      if (parsed.type === 'append-event') return this.appendEvent(parsed)
      if (parsed.type === 'read-turn') return this.readTurn(parsed)
      return turnJournalResultSchema.parse({
        type: 'open-turns-listed',
        turns: this.index.listOpenTurns()
      })
    })
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.closing = true
      try {
        await this.writerQueue
        if (this.poisoned) throw this.poisoned
      } finally {
        this.closed = true
        ACTIVE_TURN_JOURNAL_ROOTS.delete(this.ownershipKey)
      }
    })()
    return this.closePromise
  }

  private async acceptTurn(
    command: Extract<TurnJournalCommand, { type: 'accept-turn' }>
  ): Promise<TurnJournalResult> {
    const turnId = command.draft.turnId
    if (!turnId) throw new Error('A durable turn draft requires turnId.')
    this.validateAcceptance(command, turnId)

    const existing = this.index.getTurn(turnId)
    if (existing) {
      if (JSON.stringify(existing.draft) !== JSON.stringify(command.draft)) {
        throw new Error(`Turn "${turnId}" was rebound to a different draft.`)
      }
      const accepted = existing.events[0]
      if (
        accepted.messageId !== command.eventId ||
        JSON.stringify(accepted.payload) !== JSON.stringify(command.accepted)
      ) {
        throw new Error(`Turn "${turnId}" acceptance changed during retry.`)
      }
      return turnJournalResultSchema.parse({
        type: 'turn-accepted',
        envelope: clone(accepted),
        duplicate: true
      })
    }
    const boundTurn = this.index.getClientMessageTurn(command.draft.messageId)
    if (boundTurn && boundTurn !== turnId) {
      throw new Error('Client messageId is bound to multiple turns.')
    }
    this.index.assertFreshClientTurnSequence(
      command.draft.sessionId,
      command.draft.sequence
    )
    this.index.assertUnusedServerMessageId(command.eventId)

    const envelope = this.createEnvelope(
      command.draft.sessionId,
      turnId,
      command.eventId,
      this.index.nextServerSequence(command.draft.sessionId),
      command.accepted
    )
    const record: Extract<TurnJournalRecord, { kind: 'accepted' }> = {
      kind: 'accepted',
      draft: clone(command.draft),
      event: envelope
    }
    const state = createAcceptedState(record)
    await this.append(record)
    this.index.commitAcceptance(record, state)
    return turnJournalResultSchema.parse({
      type: 'turn-accepted',
      envelope: clone(envelope),
      duplicate: false
    })
  }

  private async appendEvent(
    command: Extract<TurnJournalCommand, { type: 'append-event' }>
  ): Promise<TurnJournalResult> {
    const state = this.index.getTurn(command.turnId)
    if (!state) throw new Error(`Unknown turn "${command.turnId}".`)
    const duplicate = this.index.getEvent(command.eventId)
    if (duplicate) {
      if (
        duplicate.turnId !== command.turnId ||
        JSON.stringify(duplicate.payload) !== JSON.stringify(command.event)
      ) {
        throw new Error('Server eventId is bound to a different turn event.')
      }
      return turnJournalResultSchema.parse({
        type: 'event-appended',
        envelope: clone(duplicate),
        duplicate: true
      })
    }
    if (command.event.turnId !== command.turnId) {
      throw new Error('Turn event does not match append-event turnId.')
    }
    this.index.assertUnusedServerMessageId(command.eventId)
    const envelope = this.createEnvelope(
      state.draft.sessionId,
      command.turnId,
      command.eventId,
      this.index.nextServerSequence(state.draft.sessionId),
      command.event
    )
    const nextState = this.index.prepareEvent(command.turnId, envelope)
    const record: TurnJournalRecord = { kind: 'event', event: envelope }
    await this.append(record)
    this.index.commitEvent(command.turnId, envelope, nextState)
    return turnJournalResultSchema.parse({
      type: 'event-appended',
      envelope: clone(envelope),
      duplicate: false
    })
  }

  private readTurn(
    command: Extract<TurnJournalCommand, { type: 'read-turn' }>
  ): TurnJournalResult {
    const state = this.index.getTurn(command.turnId)
    const last = state?.events.at(-1)
    return turnJournalResultSchema.parse({
      type: 'turn-read',
      ...(state && last
        ? {
            draft: clone(state.draft),
            lastSequence: last.sequence,
            terminal: isTerminalEnvelope(last)
          }
        : {}),
      eventsAfterCursor: state
        ? state.events
            .filter((event) => event.sequence > command.afterSequence)
            .map(clone)
        : []
    })
  }

  private validateAcceptance(
    command: Extract<TurnJournalCommand, { type: 'accept-turn' }>,
    turnId: string
  ): void {
    if (
      command.accepted.turnId !== turnId ||
      command.accepted.messageId !== command.draft.messageId
    ) {
      throw new Error('Turn acceptance does not match its durable draft.')
    }
    if (
      !sameWorkspaceRevision(
        command.accepted.revision,
        command.draft.payload.selectionSnapshot.revision
      )
    ) {
      throw new Error('Turn acceptance revision does not match its durable draft.')
    }
  }

  private createEnvelope(
    sessionId: string,
    turnId: string,
    messageId: string,
    sequence: number,
    payload: TurnEvent
  ): PersistedTurnEventEnvelope {
    return agentServerEnvelopeSchema.parse({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      sessionId,
      messageId,
      turnId,
      sequence,
      timestamp: this.now().toISOString(),
      payload
    }) as PersistedTurnEventEnvelope
  }

  private async load(): Promise<void> {
    try {
      const loaded = await loadTurnJournalRecords(this.journalPath)
      for (const record of loaded.records) {
        this.index.replay(record.sequence, record.value)
      }
      this.lastRecordSequence = loaded.lastSequence
    } catch (error) {
      throw this.poison(error)
    }
  }

  private ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.load()
    return this.loadPromise
  }

  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    try {
      this.assertAccepting()
    } catch (error) {
      return Promise.reject(error)
    }
    const result = this.writerQueue.then(async () => {
      this.assertAvailable()
      await this.ensureLoaded()
      this.assertAvailable()
      return operation()
    })
    this.writerQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async append(record: TurnJournalRecord): Promise<void> {
    const sequence = this.lastRecordSequence + 1
    try {
      await this.appendRecord(this.journalPath, sequence, record)
    } catch (error) {
      throw this.poison(error)
    }
    this.lastRecordSequence = sequence
  }

  private assertAvailable(): void {
    if (this.poisoned) throw this.poisoned
    if (this.closed) throw new Error('Turn journal is closed.')
  }

  private assertAccepting(): void {
    this.assertAvailable()
    if (this.closing) throw new Error('Turn journal is closing.')
  }

  private poison(error: unknown): Error {
    this.poisoned ??=
      error instanceof Error
        ? error
        : new Error('Turn journal entered an uncertain state.')
    return this.poisoned
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}
