import type {
  OpenTurnSummary,
  PersistedTurnEventEnvelope
} from '../../shared/agent-contracts'
import {
  applyTurnEvent,
  createAcceptedState,
  isTerminalEnvelope,
  openTurnSummary,
  type TurnReplayState
} from './TurnJournalReducer'
import {
  TurnJournalCorruptionError,
  type TurnJournalRecord
} from './TurnJournalRecordFile'

export class TurnJournalIndex {
  private readonly turns = new Map<string, TurnReplayState>()
  private readonly events = new Map<string, PersistedTurnEventEnvelope>()
  private readonly clientMessages = new Map<string, string>()
  private readonly sessionSequences = new Map<string, number>()
  private readonly sessionClientTurnSequences = new Map<string, number>()

  getTurn(turnId: string): TurnReplayState | undefined {
    return this.turns.get(turnId)
  }

  getEvent(messageId: string): PersistedTurnEventEnvelope | undefined {
    return this.events.get(messageId)
  }

  getClientMessageTurn(messageId: string): string | undefined {
    return this.clientMessages.get(messageId)
  }

  nextServerSequence(sessionId: string): number {
    const current = this.sessionSequences.get(sessionId) ?? 0
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Server event sequence exhausted its safe integer range.')
    }
    return current + 1
  }

  assertUnusedServerMessageId(messageId: string): void {
    if (this.events.has(messageId)) {
      throw new Error('server event messageId is bound more than once')
    }
  }

  assertFreshClientTurnSequence(
    sessionId: string,
    sequence: number
  ): void {
    const previous = this.sessionClientTurnSequences.get(sessionId) ?? -1
    if (sequence <= previous) {
      throw new Error(
        `session "${sessionId}" client turn sequence must exceed ${previous}`
      )
    }
  }

  prepareEvent(
    turnId: string,
    event: PersistedTurnEventEnvelope
  ): TurnReplayState {
    const current = this.turns.get(turnId)
    if (!current) throw new Error(`Unknown turn "${turnId}".`)
    return applyTurnEvent(current, event)
  }

  commitAcceptance(
    record: Extract<TurnJournalRecord, { kind: 'accepted' }>,
    state: TurnReplayState
  ): void {
    const turnId = record.draft.turnId
    if (!turnId) throw new Error('accepted draft has no turnId')
    this.turns.set(turnId, state)
    this.clientMessages.set(record.draft.messageId, turnId)
    this.events.set(record.event.messageId, record.event)
    this.sessionSequences.set(record.event.sessionId, record.event.sequence)
    this.sessionClientTurnSequences.set(
      record.draft.sessionId,
      record.draft.sequence
    )
  }

  commitEvent(
    turnId: string,
    event: PersistedTurnEventEnvelope,
    state: TurnReplayState
  ): void {
    this.turns.set(turnId, state)
    this.events.set(event.messageId, event)
    this.sessionSequences.set(event.sessionId, event.sequence)
  }

  replay(recordSequence: number, record: TurnJournalRecord): void {
    try {
      this.assertNextServerSequence(record.event)
      if (record.kind === 'accepted') {
        const turnId = record.draft.turnId
        if (!turnId) throw new Error('accepted draft has no turnId')
        if (this.turns.has(turnId)) {
          throw new Error(`turn "${turnId}" has multiple acceptance records`)
        }
        if (this.clientMessages.has(record.draft.messageId)) {
          throw new Error('client messageId is bound to multiple turns')
        }
        this.assertUnusedServerMessageId(record.event.messageId)
        this.assertFreshClientTurnSequence(
          record.draft.sessionId,
          record.draft.sequence
        )
        this.commitAcceptance(record, createAcceptedState(record))
        return
      }
      const turnId = record.event.turnId
      if (!turnId) throw new Error('turn event envelope has no turnId')
      this.assertUnusedServerMessageId(record.event.messageId)
      this.commitEvent(
        turnId,
        record.event,
        this.prepareEvent(turnId, record.event)
      )
    } catch (error) {
      throw new TurnJournalCorruptionError(
        `record ${recordSequence}: ${errorMessage(error)}`
      )
    }
  }

  listOpenTurns(): OpenTurnSummary[] {
    return [...this.turns.values()]
      .filter((state) => !isTerminalEnvelope(state.events.at(-1)))
      .map(openTurnSummary)
  }

  private assertNextServerSequence(
    event: PersistedTurnEventEnvelope
  ): void {
    const expected = this.nextServerSequence(event.sessionId)
    if (event.sequence !== expected) {
      throw new Error(
        `session "${event.sessionId}" expected server sequence ${expected}, ` +
          `received ${event.sequence}`
      )
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
