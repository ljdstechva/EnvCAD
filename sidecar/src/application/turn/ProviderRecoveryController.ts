import {
  sameWorkspaceRevision,
  type RecoveryAttempt,
  type RecoverySummary,
  type WorkspaceRevision
} from '../../../../shared/agent-contracts'
import { providerFailure } from './ProviderFailurePolicy'
import type { TurnCancellation } from './TurnCancellation'
import type { TurnExecutionMetrics } from './TurnExecutionMetrics'
import {
  ProviderTurnInterruptedError,
  type ProviderTurnStream
} from './ProviderTurnStream'
import type {
  ProviderTurnPort,
  TurnToolMetrics
} from './TurnExecutionContracts'

interface ProviderRecoveryOptions {
  conversation: ProviderTurnPort
  stream: ProviderTurnStream
  cancellation: TurnCancellation
  metrics: TurnExecutionMetrics
  initialRevision: WorkspaceRevision
  currentRevision(): WorkspaceRevision
  machineRevision(): WorkspaceRevision
  toolMetrics(): TurnToolMetrics
  unresolvedMutation?(): string | undefined
  recoverProvider?(
    failure: unknown,
    signal: AbortSignal
  ): Promise<ProviderTurnPort>
  recoveryTimeoutMs?: number
  progress(
    phase: 'recovering' | 'retrying' | 'executing',
    status: string,
    revision?: WorkspaceRevision
  ): Promise<void>
  wallClockNow?(): Date
}

export class ProviderRecoveryController {
  private activeConversation: ProviderTurnPort
  private recoveryAbort: AbortController | undefined
  private readonly attempts: RecoveryAttempt[] = []

  constructor(private readonly options: ProviderRecoveryOptions) {
    this.activeConversation = options.conversation
  }

  async run(prompt: string): Promise<void> {
    try {
      await this.options.stream.run(this.activeConversation, prompt)
    } catch (error) {
      if (!this.canRecover(error)) throw error
      await this.recoverAndRetry(prompt, error)
    }
  }

  cancel(): void {
    const error = new Error('Turn cancelled.')
    this.recoveryAbort?.abort(error)
    void this.activeConversation.interrupt().catch(() => {})
  }

  summary(): RecoverySummary | undefined {
    if (!this.attempts.some((attempt) => attempt.succeeded)) return undefined
    return {
      attempts: this.attempts.map((attempt) => ({ ...attempt })),
      drawingChanged: sameWorkspaceRevision(
        this.options.initialRevision,
        this.options.currentRevision()
      )
        ? false
        : 'unknown',
      resumedFromJournal: false
    }
  }

  private async recoverAndRetry(
    prompt: string,
    failure: unknown
  ): Promise<void> {
    const attempt: RecoveryAttempt = {
      strategy: 'recreate-same-provider-conversation',
      attempt: this.attempts.length + 1,
      startedAt: this.isoNow()
    }
    this.attempts.push(attempt)
    await this.options.progress(
      'recovering',
      'The provider connection stopped before any drawing operation; recreating it safely.',
      this.options.currentRevision()
    )
    try {
      this.activeConversation = await this.recover(failure)
      this.options.metrics.markRetry()
      await this.options.progress(
        'retrying',
        'Retrying once with the same provider.'
      )
      await this.options.progress(
        'executing',
        'Executing the recovered provider turn.'
      )
      await this.options.stream.run(this.activeConversation, prompt)
      Object.assign(attempt, {
        completedAt: this.isoNow(),
        succeeded: true
      })
    } catch (error) {
      Object.assign(attempt, {
        completedAt: this.isoNow(),
        succeeded: false
      })
      throw error
    }
  }

  private async recover(failure: unknown): Promise<ProviderTurnPort> {
    const recover = this.options.recoverProvider
    if (!recover) throw failure
    const controller = new AbortController()
    this.recoveryAbort = controller
    const timeoutMs = this.options.recoveryTimeoutMs ?? 8_000
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new ProviderRecoveryTimeoutError(timeoutMs)
        controller.abort(error)
        reject(error)
      }, timeoutMs)
      timer.unref?.()
    })
    try {
      return await this.options.cancellation.race(
        Promise.race([recover(failure, controller.signal), timeout])
      )
    } finally {
      if (timer) clearTimeout(timer)
      if (this.recoveryAbort === controller) this.recoveryAbort = undefined
    }
  }

  private canRecover(error: unknown): boolean {
    const mutations =
      this.options.toolMetrics().mutationCalls ??
      this.options.toolMetrics().toolCalls
    if (
      this.options.cancellation.requested ||
      !(error instanceof ProviderTurnInterruptedError) ||
      !this.options.recoverProvider ||
      this.attempts.length > 0 ||
      mutations > 0 ||
      this.options.unresolvedMutation?.()
    ) {
      return false
    }
    if (
      !sameWorkspaceRevision(
        this.options.machineRevision(),
        this.options.currentRevision()
      )
    ) {
      return false
    }
    const failure = providerFailure(error)
    return failure.kind === 'transient-provider' && failure.retryable
  }

  private isoNow(): string {
    return (this.options.wallClockNow?.() ?? new Date()).toISOString()
  }
}

class ProviderRecoveryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Provider conversation recovery exceeded ${timeoutMs} ms.`)
    this.name = 'ProviderRecoveryTimeoutError'
  }
}
