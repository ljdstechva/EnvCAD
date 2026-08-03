import type {
  OperationReceipt,
  PersistedTurnEventEnvelope,
  SubmitTurnEnvelope,
  TurnJournalPort
} from '../../../../shared/agent-contracts'
import {
  DurableTurnEventSink,
  type DurableTurnEventSinkOptions
} from './DurableTurnEventSink'
import {
  TurnExecution,
  type TurnExecutionContext,
  type TurnExecutionResult
} from './TurnExecution'

export interface TurnOrchestratorOptions {
  journal: TurnJournalPort
  emit(envelope: PersistedTurnEventEnvelope): void
  monotonicNow?: () => number
}

export class TurnOrchestrator {
  private readonly sink: DurableTurnEventSink
  private active:
    | { turnId: string; sessionId: string; execution: TurnExecution }
    | undefined

  constructor(private readonly options: TurnOrchestratorOptions) {
    const sinkOptions: DurableTurnEventSinkOptions = {
      journal: options.journal,
      emit: options.emit
    }
    this.sink = new DurableTurnEventSink(sinkOptions)
  }

  async submit(
    draft: SubmitTurnEnvelope,
    context: Omit<TurnExecutionContext, 'draft'>
  ): Promise<TurnExecutionResult> {
    const turnId = requiredTurnId(draft)
    if (this.active && this.active.turnId !== turnId) {
      throw new Error('Another durable turn is already active in this session.')
    }
    const execution = new TurnExecution(
      this.sink,
      { ...context, draft },
      this.options.monotonicNow
    )
    this.active = { turnId, sessionId: draft.sessionId, execution }
    try {
      return await execution.run()
    } finally {
      if (this.active?.execution === execution) this.active = undefined
    }
  }

  async resume(
    turnId: string,
    sessionId: string,
    afterSequence: number
  ): Promise<{ found: boolean; terminal: boolean; lastSequence: number }> {
    return this.sink.replay(turnId, sessionId, afterSequence)
  }

  cancel(turnId: string, sessionId: string): boolean {
    if (
      this.active?.turnId !== turnId ||
      this.active.sessionId !== sessionId
    ) {
      return false
    }
    this.active.execution.cancel()
    return true
  }

  async recordOperationReceipt(
    turnId: string,
    receipt: OperationReceipt
  ): Promise<void> {
    if (this.active?.turnId !== turnId) {
      throw new Error('Operation receipt does not belong to the active turn.')
    }
    await this.sink.append(
      turnId,
      `operation-${receipt.operationId}-${receipt.status}`,
      {
        type: 'operation_receipt',
        turnId,
        receipt
      }
    )
  }

  get activeTurnId(): string | undefined {
    return this.active?.turnId
  }
}

function requiredTurnId(draft: SubmitTurnEnvelope): string {
  if (!draft.turnId) throw new Error('Durable turn draft has no turnId.')
  return draft.turnId
}
