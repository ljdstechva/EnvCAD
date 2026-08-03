import {
  cloneWorkspaceRevision,
  turnAcceptedSchema,
  turnFinishedSchema,
  turnProgressSchema,
  type RecoverySummary,
  type SkillActivation,
  type StructuredFailure,
  type TurnAccepted,
  type TurnFinished,
  type TurnMetrics,
  type TurnOutcome,
  type TurnPhase,
  type TurnProgress,
  type VerificationSummary,
  type WorkspaceRevision,
  type WorkspaceRevisionTransitionKind
} from '../../../../shared/agent-contracts'
import {
  canTransition,
  isActivePhase,
  prepareTurnState,
  transitionSnapshot,
  type PreparedTurnState
} from './TurnTransitionRules'

export interface TurnStateMachineOptions {
  turnId: string
  messageId: string
  revision: WorkspaceRevision
  activeSkills: readonly SkillActivation[]
  provider: string
  startedAtMs?: number
  monotonicNow?: () => number
}

export interface TurnTransitionUpdate {
  revision?: WorkspaceRevision
  revisionTransition?: WorkspaceRevisionTransitionKind
  activeSkills?: readonly SkillActivation[]
  provider?: string
}

export interface FinishTurnOptions extends TurnTransitionUpdate {
  metrics: TurnMetrics
  recovery?: RecoverySummary
  error?: StructuredFailure
  verification?: VerificationSummary
}

export class TurnStateMachine {
  private phase: TurnPhase = 'draft'
  private state: PreparedTurnState
  private terminal: TurnFinished | undefined
  private recoveryObserved = false
  private readonly startedAtMs: number
  private readonly monotonicNow: () => number

  constructor(private readonly options: TurnStateMachineOptions) {
    if (
      !options.activeSkills.some((skill) => skill.skillId === 'cad-core') ||
      !options.activeSkills.some((skill) => skill.skillId === 'dxf-core')
    ) {
      throw new Error('Every turn requires verified cad-core and dxf-core skills.')
    }
    this.state = prepareTurnState(
      {
        revision: options.revision,
        revisionTransition: 'same-document',
        activeSkills: options.activeSkills.map((skill) => ({ ...skill })),
        provider: options.provider
      },
      {
        revision: options.revision,
        activeSkills: options.activeSkills
      }
    )
    this.monotonicNow = options.monotonicNow ?? performance.now.bind(performance)
    this.startedAtMs = options.startedAtMs ?? this.monotonicNow()
  }

  accept(status: string): TurnAccepted {
    this.assertPhase('draft')
    const event = turnAcceptedSchema.parse({
      type: 'turn_accepted',
      turnId: this.options.turnId,
      messageId: this.options.messageId,
      phase: 'accepted',
      ...transitionSnapshot(
        this.state,
        status,
        0,
        'same-document'
      )
    })
    this.phase = 'accepted'
    return event
  }

  transition(
    nextPhase: Exclude<
      TurnPhase,
      'draft' | 'accepted' | 'completed' | 'needs-input' | 'cancelled' | 'failed'
    >,
    status: string,
    update: TurnTransitionUpdate = {}
  ): TurnProgress {
    this.assertActive()
    if (!canTransition(this.phase, nextPhase)) {
      throw new Error(`Invalid turn transition from "${this.phase}" to "${nextPhase}".`)
    }
    const nextState = prepareTurnState(this.state, update)
    const event = turnProgressSchema.parse({
      type: 'turn_progress',
      turnId: this.options.turnId,
      phase: nextPhase,
      ...this.snapshot(status, nextState, nextState.revisionTransition)
    })
    this.state = nextState
    this.phase = nextPhase
    if (nextPhase === 'recovering') this.recoveryObserved = true
    return event
  }

  finish(
    outcome: TurnOutcome,
    status: string,
    options: FinishTurnOptions
  ): TurnFinished {
    this.assertActive()
    this.validateTerminalDetails(outcome, options)
    const nextState = prepareTurnState(this.state, options)
    const phase = this.terminalPhase(outcome)
    const finished = turnFinishedSchema.parse({
      type: 'turn_finished',
      turnId: this.options.turnId,
      phase,
      outcome,
      ...this.snapshot(status, nextState, nextState.revisionTransition),
      finalRevision: nextState.revision,
      ...(options.recovery ? { recovery: options.recovery } : {}),
      ...(options.error ? { error: options.error } : {}),
      ...(options.verification
        ? { verification: options.verification }
        : {}),
      metrics: { ...options.metrics }
    })
    this.state = nextState
    this.phase = phase
    this.terminal = finished
    return finished
  }

  get currentPhase(): TurnPhase {
    return this.phase
  }

  get currentRevision(): WorkspaceRevision {
    return cloneWorkspaceRevision(this.state.revision)
  }

  get finished(): TurnFinished | undefined {
    return this.terminal
  }

  private snapshot(
    status: string,
    state = this.state,
    revisionTransition: WorkspaceRevisionTransitionKind = 'same-document'
  ) {
    return transitionSnapshot(
      state,
      status,
      this.monotonicNow() - this.startedAtMs,
      revisionTransition
    )
  }

  private validateTerminalDetails(
    outcome: TurnOutcome,
    options: FinishTurnOptions
  ): void {
    if (
      (outcome === 'completed' || outcome === 'recovered') &&
      this.phase !== 'verifying'
    ) {
      throw new Error('A successful turn requires the verifying phase.')
    }
    if (outcome === 'completed' && this.recoveryObserved) {
      throw new Error('A turn that used recovery must finish as recovered.')
    }
    if (outcome === 'failed' && !options.error) {
      throw new Error('A failed turn requires a structured failure.')
    }
    if (outcome === 'recovered' && (!options.recovery || !this.recoveryObserved)) {
      throw new Error('A recovered turn requires a recovery summary.')
    }
    if (outcome === 'needs-input' && !this.recoveryObserved) {
      throw new Error('A needs-input outcome requires a visible recovery path.')
    }
  }

  private terminalPhase(
    outcome: TurnOutcome
  ): 'completed' | 'needs-input' | 'cancelled' | 'failed' {
    return outcome === 'completed' || outcome === 'recovered'
      ? 'completed'
      : outcome
  }

  private assertActive(): void {
    if (this.terminal) throw new Error('Turn already has a terminal outcome.')
    if (!isActivePhase(this.phase)) {
      throw new Error(`Turn is not active while in "${this.phase}".`)
    }
  }

  private assertPhase(expected: TurnPhase): void {
    if (this.phase !== expected) {
      throw new Error(`Expected turn phase "${expected}", received "${this.phase}".`)
    }
  }
}
