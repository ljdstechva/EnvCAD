import {
  sameWorkspaceRevision,
  type VerificationSummary,
  type WorkspaceRevision
} from '../../../../shared/agent-contracts'
import type { TurnStateMachine } from '../../domain/turn/TurnStateMachine'
import type { DurableTurnEventSink } from './DurableTurnEventSink'
import { providerFailure } from './ProviderFailurePolicy'
import type { ProviderRecoveryController } from './ProviderRecoveryController'
import {
  TurnCancelledError,
  type TurnCancellation
} from './TurnCancellation'
import type {
  TurnExecutionContext,
  TurnExecutionResult
} from './TurnExecutionContracts'
import type { TurnExecutionMetrics } from './TurnExecutionMetrics'
import { revisionTransition } from './TurnExecutionRevision'

interface TurnTerminalWriterOptions {
  sink: DurableTurnEventSink
  machine: TurnStateMachine
  context: TurnExecutionContext
  metrics: TurnExecutionMetrics
  cancellation: TurnCancellation
  provider: ProviderRecoveryController
  progress(
    phase: 'recovering',
    status: string,
    revision: WorkspaceRevision
  ): Promise<void>
}

export class TurnTerminalWriter {
  constructor(private readonly options: TurnTerminalWriterOptions) {}

  async complete(
    turnId: string,
    verification: VerificationSummary
  ): Promise<TurnExecutionResult> {
    const recovery = this.options.provider.summary()
    const outcome = recovery ? 'recovered' : 'completed'
    await this.options.sink.append(
      turnId,
      'finished',
      this.options.machine.finish(
        outcome,
        recovery ? 'Turn recovered and completed.' : 'Turn completed.',
        {
          metrics: this.options.metrics.snapshot(),
          verification,
          ...(recovery ? { recovery } : {})
        }
      )
    )
    return { duplicate: false, outcome }
  }

  async fail(
    turnId: string,
    error: unknown
  ): Promise<TurnExecutionResult> {
    if (
      this.options.cancellation.requested ||
      error instanceof TurnCancelledError
    ) {
      return this.cancelled(turnId)
    }
    const revision = this.options.context.currentRevision()
    if (this.options.machine.currentPhase !== 'recovering') {
      await this.options.progress(
        'recovering',
        'The provider turn stopped; preserving a safe recovery point.',
        revision
      )
    }
    const machineRevision = this.options.machine.currentRevision
    const terminalUpdate = sameWorkspaceRevision(machineRevision, revision)
      ? {}
      : {
          revision,
          revisionTransition: revisionTransition(machineRevision, revision)
        }
    await this.options.sink.append(
      turnId,
      'finished-failed',
      this.options.machine.finish(
        'failed',
        'Turn stopped with an actionable recovery state.',
        {
          ...terminalUpdate,
          metrics: this.options.metrics.snapshot(),
          error: providerFailure(error)
        }
      )
    )
    return { duplicate: false, outcome: 'failed' }
  }

  private async cancelled(turnId: string): Promise<TurnExecutionResult> {
    const revision = this.options.context.currentRevision()
    await this.options.sink.append(
      turnId,
      'finished-cancelled',
      this.options.machine.finish('cancelled', 'Turn cancelled.', {
        revision,
        revisionTransition: revisionTransition(
          this.options.machine.currentRevision,
          revision
        ),
        metrics: this.options.metrics.snapshot()
      })
    )
    return { duplicate: false, outcome: 'cancelled' }
  }
}
