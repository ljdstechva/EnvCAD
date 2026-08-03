import type { TurnMetrics } from '../../../../shared/agent-contracts'
import type { TurnToolMetrics } from './TurnExecutionContracts'

export interface TurnExecutionMetricOptions {
  startedAt: number
  monotonicNow(): number
  toolMetrics(): TurnToolMetrics
  providerReadyMs?: number
  conversationStartupMs?: number
}

export class TurnExecutionMetrics {
  private acceptedMs: number | undefined
  private firstProgressMs: number | undefined
  private firstTextMs: number | undefined
  private retries = 0
  private inputTokens: number | undefined
  private outputTokens: number | undefined

  constructor(private readonly options: TurnExecutionMetricOptions) {}

  markAccepted(): void {
    this.acceptedMs = this.elapsed()
  }

  markProgress(): void {
    this.firstProgressMs ??= this.elapsed()
  }

  markText(): void {
    this.firstTextMs ??= this.elapsed()
  }

  markRetry(): void {
    this.retries += 1
  }

  recordTokenUsage(inputTokens?: number, outputTokens?: number): void {
    this.inputTokens = inputTokens
    this.outputTokens = outputTokens
  }

  snapshot(): TurnMetrics {
    const tools = this.options.toolMetrics()
    return {
      ...(this.acceptedMs !== undefined ? { acceptedMs: this.acceptedMs } : {}),
      ...(this.firstProgressMs !== undefined
        ? { firstProgressMs: this.firstProgressMs }
        : {}),
      ...(this.options.providerReadyMs !== undefined
        ? { providerReadyMs: this.options.providerReadyMs }
        : {}),
      ...(this.options.conversationStartupMs !== undefined
        ? { conversationStartupMs: this.options.conversationStartupMs }
        : {}),
      ...(this.firstTextMs !== undefined ? { firstTextMs: this.firstTextMs } : {}),
      ...(tools.firstToolCallMs !== undefined
        ? { firstToolCallMs: tools.firstToolCallMs }
        : {}),
      totalMs: this.elapsed(),
      toolCalls: tools.toolCalls,
      ...(this.retries > 0 ? { retries: this.retries } : {}),
      ...(this.inputTokens !== undefined ? { inputTokens: this.inputTokens } : {}),
      ...(this.outputTokens !== undefined
        ? { outputTokens: this.outputTokens }
        : {})
    }
  }

  private elapsed(): number {
    return Math.max(
      0,
      this.options.monotonicNow() - this.options.startedAt
    )
  }
}
