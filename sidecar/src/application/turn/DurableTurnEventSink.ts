import {
  type PersistedTurnEventEnvelope,
  type SubmitTurnEnvelope,
  type TurnAccepted,
  type TurnEvent,
  type TurnJournalCommand,
  type TurnJournalPort
} from '../../../../shared/agent-contracts'
import { turnEventId } from './TurnEventIdentity'

export interface DurableTurnEventSinkOptions {
  journal: TurnJournalPort
  emit(envelope: PersistedTurnEventEnvelope): void
}

export class DurableTurnEventSink {
  constructor(private readonly options: DurableTurnEventSinkOptions) {}

  async accept(
    draft: SubmitTurnEnvelope,
    event: TurnAccepted
  ): Promise<{ duplicate: boolean; envelope: PersistedTurnEventEnvelope }> {
    const result = await this.execute({
      type: 'accept-turn',
      eventId: turnEventId(event.turnId, 'accepted'),
      draft,
      accepted: event
    })
    if (result.type !== 'turn-accepted') {
      throw new Error('Turn journal returned the wrong acceptance result.')
    }
    this.options.emit(result.envelope)
    return result
  }

  async append(
    turnId: string,
    logicalId: string,
    event: TurnEvent
  ): Promise<PersistedTurnEventEnvelope> {
    const result = await this.execute({
      type: 'append-event',
      eventId: turnEventId(turnId, logicalId),
      turnId,
      event
    })
    if (result.type !== 'event-appended') {
      throw new Error('Turn journal returned the wrong append result.')
    }
    this.options.emit(result.envelope)
    return result.envelope
  }

  async replay(
    turnId: string,
    sessionId: string,
    afterSequence: number
  ): Promise<{ found: boolean; terminal: boolean; lastSequence: number }> {
    const result = await this.execute({
      type: 'read-turn',
      turnId,
      afterSequence
    })
    if (result.type !== 'turn-read') {
      throw new Error('Turn journal returned the wrong read result.')
    }
    if (!result.draft) {
      return { found: false, terminal: false, lastSequence: afterSequence }
    }
    if (result.draft.sessionId !== sessionId) {
      throw new Error('Turn resume session does not own the durable turn.')
    }
    for (const event of result.eventsAfterCursor) this.options.emit(event)
    return {
      found: true,
      terminal: result.terminal!,
      lastSequence: result.lastSequence!
    }
  }

  private async execute(command: TurnJournalCommand) {
    try {
      return await this.options.journal.execute(command)
    } catch {
      return this.options.journal.execute(command)
    }
  }
}
