import type { WorkspaceRevision } from '../../../../shared/agent-contracts'
import { TurnStateMachine } from '../../domain/turn/TurnStateMachine'
import { TurnBriefing } from './TurnBriefing'
import { DurableTurnEventSink } from './DurableTurnEventSink'
import {
  TurnMutationUnresolvedError
} from './ProviderFailurePolicy'
import { ProviderRecoveryController } from './ProviderRecoveryController'
import { ProviderTurnStream } from './ProviderTurnStream'
import { TurnCancellation } from './TurnCancellation'
import type { TurnExecutionContext, TurnExecutionResult } from './TurnExecutionContracts'
import { TurnExecutionMetrics } from './TurnExecutionMetrics'
import { emitTurnSkills } from './TurnSkillEmitter'
import { TurnTerminalWriter } from './TurnTerminalWriter'
import {
  defaultVerification,
  requiredTurnId,
  revisionTransition
} from './TurnExecutionRevision'

export type {
  NeutralProviderEvent,
  ProviderTurnPort,
  TurnExecutionContext,
  TurnExecutionResult,
  TurnToolMetrics
} from './TurnExecutionContracts'

export class TurnExecution {
  private readonly machine: TurnStateMachine
  private readonly cancellation = new TurnCancellation()
  private readonly metrics: TurnExecutionMetrics
  private readonly briefing: TurnBriefing
  private readonly provider: ProviderRecoveryController
  private readonly terminal: TurnTerminalWriter
  private readonly phaseOrdinals = new Map<string, number>()

  constructor(
    private readonly sink: DurableTurnEventSink,
    private readonly context: TurnExecutionContext,
    private readonly monotonicNow: () => number = performance.now.bind(performance)
  ) {
    const startedAt = this.monotonicNow()
    const turnId = requiredTurnId(context.draft)
    this.machine = new TurnStateMachine({
      turnId,
      messageId: context.draft.messageId,
      revision: context.draft.payload.selectionSnapshot.revision,
      activeSkills: context.activeSkills,
      provider: context.provider,
      startedAtMs: startedAt,
      monotonicNow: this.monotonicNow
    })
    this.metrics = new TurnExecutionMetrics({
      startedAt,
      monotonicNow: this.monotonicNow,
      toolMetrics: context.toolMetrics,
      ...(context.providerReadyMs !== undefined
        ? { providerReadyMs: context.providerReadyMs }
        : {}),
      ...(context.conversationStartupMs !== undefined
        ? { conversationStartupMs: context.conversationStartupMs }
        : {})
    })
    this.briefing = new TurnBriefing({
      sink,
      context,
      cancellation: this.cancellation,
      progress: (phase, status) => this.progress(phase, status)
    })
    const stream = new ProviderTurnStream({
      sink,
      turnId,
      cancellation: this.cancellation,
      metrics: this.metrics
    })
    this.provider = new ProviderRecoveryController({
      conversation: context.conversation,
      stream,
      cancellation: this.cancellation,
      metrics: this.metrics,
      initialRevision: context.draft.payload.selectionSnapshot.revision,
      currentRevision: context.currentRevision,
      machineRevision: () => this.machine.currentRevision,
      toolMetrics: context.toolMetrics,
      ...(context.unresolvedMutation
        ? { unresolvedMutation: context.unresolvedMutation }
        : {}),
      ...(context.recoverProvider
        ? { recoverProvider: context.recoverProvider }
        : {}),
      ...(context.providerRecoveryTimeoutMs !== undefined
        ? { recoveryTimeoutMs: context.providerRecoveryTimeoutMs }
        : {}),
      progress: (phase, status, revision) =>
        this.progress(phase, status, revision),
      ...(context.wallClockNow
        ? { wallClockNow: context.wallClockNow }
        : {})
    })
    this.terminal = new TurnTerminalWriter({
      sink,
      machine: this.machine,
      context,
      metrics: this.metrics,
      cancellation: this.cancellation,
      provider: this.provider,
      progress: (phase, status, revision) =>
        this.progress(phase, status, revision)
    })
  }

  async run(): Promise<TurnExecutionResult> {
    const turnId = requiredTurnId(this.context.draft)
    const acceptance = await this.sink.accept(
      this.context.draft,
      this.machine.accept('Turn accepted and safely recorded.')
    )
    this.metrics.markAccepted()
    if (acceptance.duplicate) {
      await this.sink.replay(
        turnId,
        this.context.draft.sessionId,
        acceptance.envelope.sequence
      )
      return { duplicate: true }
    }
    try {
      await emitTurnSkills(
        this.sink,
        this.cancellation,
        turnId,
        this.context.activeSkills
      )
      const prompt = await this.briefing.prepare(turnId)
      await this.progress('planning', 'Preparing the provider plan.')
      await this.progress('inspecting', 'Inspecting the required drawing context.')
      await this.progress('executing', 'Executing the provider turn.')
      await this.provider.run(prompt)
      this.cancellation.throwIfRequested()
      this.assertNoUnresolvedMutation()
      const verification = await this.verify()
      await this.progress(
        'verifying',
        'Recording the final workspace revision and available checks.',
        this.context.currentRevision()
      )
      return this.terminal.complete(turnId, verification)
    } catch (error) {
      return this.terminal.fail(turnId, error)
    }
  }

  cancel(): void {
    if (this.machine.finished || !this.cancellation.request()) return
    this.provider.cancel()
  }

  private assertNoUnresolvedMutation(): void {
    const operationId = this.context.unresolvedMutation?.()
    if (operationId) throw new TurnMutationUnresolvedError(operationId)
  }

  private async verify() {
    return (
      (await this.cancellation.race(
        this.context.performVerification?.() ?? Promise.resolve(undefined)
      )) ?? defaultVerification(this.context.currentRevision())
    )
  }

  private async progress(
    phase: Parameters<TurnStateMachine['transition']>[0],
    status: string,
    revision?: WorkspaceRevision
  ): Promise<void> {
    this.cancellation.throwIfRequested()
    const update = revision
      ? {
          revision,
          revisionTransition: revisionTransition(
            this.machine.currentRevision,
            revision
          )
        }
      : undefined
    const ordinal = (this.phaseOrdinals.get(phase) ?? 0) + 1
    this.phaseOrdinals.set(phase, ordinal)
    await this.sink.append(
      requiredTurnId(this.context.draft),
      `progress-${phase}-${ordinal}`,
      this.machine.transition(phase, status, update)
    )
    this.metrics.markProgress()
  }

}
