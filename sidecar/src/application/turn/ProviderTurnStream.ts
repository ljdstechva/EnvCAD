import { DurableTextEmitter } from './DurableTextEmitter'
import type { DurableTurnEventSink } from './DurableTurnEventSink'
import {
  TurnCancelledError,
  type TurnCancellation
} from './TurnCancellation'
import type { TurnExecutionMetrics } from './TurnExecutionMetrics'
import type {
  NeutralProviderEvent,
  ProviderTurnPort
} from './TurnExecutionContracts'

export class ProviderTurnInterruptedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'ProviderTurnInterruptedError'
  }
}

export interface ProviderTurnStreamOptions {
  sink: DurableTurnEventSink
  turnId: string
  cancellation: TurnCancellation
  metrics: TurnExecutionMetrics
}

export class ProviderTurnStream {
  constructor(private readonly options: ProviderTurnStreamOptions) {}

  async run(conversation: ProviderTurnPort, prompt: string): Promise<void> {
    const text = new DurableTextEmitter({
      sink: this.options.sink,
      turnId: this.options.turnId
    })
    let iterator: AsyncIterator<NeutralProviderEvent>
    try {
      iterator = conversation.runTurn({ prompt })[Symbol.asyncIterator]()
    } catch (error) {
      throw new ProviderTurnInterruptedError(error)
    }
    try {
      await this.consume(iterator, text)
    } finally {
      await text.close()
    }
  }

  private async consume(
    iterator: AsyncIterator<NeutralProviderEvent>,
    text: DurableTextEmitter
  ): Promise<void> {
    while (true) {
      let result: IteratorResult<NeutralProviderEvent>
      try {
        result = await this.options.cancellation.race(iterator.next())
      } catch (error) {
        if (error instanceof TurnCancelledError) {
          void iterator.return?.().catch(() => {})
          throw error
        }
        throw new ProviderTurnInterruptedError(error)
      }
      if (result.done) return
      await this.consumeEvent(result.value, text)
    }
  }

  private async consumeEvent(
    event: NeutralProviderEvent,
    text: DurableTextEmitter
  ): Promise<void> {
    if (event.type === 'text_delta') {
      this.options.metrics.markText()
      await text.push(event.text)
    } else if (event.type === 'retry') {
      this.options.metrics.markRetry()
    } else if (event.type === 'token_usage') {
      this.options.metrics.recordTokenUsage(
        event.inputTokens,
        event.outputTokens
      )
    }
  }
}
