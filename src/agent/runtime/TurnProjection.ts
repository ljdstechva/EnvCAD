import type {
  InstructionBreakdown,
  OperationReceipt,
  PersistedTurnEventEnvelope,
  SkillActivation,
  TurnFinished,
  TurnPhase
} from '../../../shared/agent-contracts'

export interface TurnProjectionSnapshot {
  turnId: string
  lastSequence: number
  accepted: boolean
  phase?: TurnPhase
  status: string
  assistantText: string
  activeSkills: SkillActivation[]
  operationReceipts: OperationReceipt[]
  instructionBreakdown?: InstructionBreakdown
  terminal?: TurnFinished
}

export class TurnProjection {
  private snapshot: TurnProjectionSnapshot

  constructor(
    turnId: string,
    initial: {
      lastSequence?: number
      assistantText?: string
      accepted?: boolean
      phase?: TurnPhase
      status?: string
      activeSkills?: SkillActivation[]
      instructionBreakdown?: InstructionBreakdown
      operationReceipts?: OperationReceipt[]
    } = {}
  ) {
    this.snapshot = {
      turnId,
      lastSequence: initial.lastSequence ?? 0,
      accepted: initial.accepted ?? false,
      ...(initial.phase ? { phase: initial.phase } : {}),
      status: initial.status ?? '',
      assistantText: initial.assistantText ?? '',
      activeSkills: structuredClone(initial.activeSkills ?? []),
      operationReceipts: structuredClone(initial.operationReceipts ?? []),
      ...(initial.instructionBreakdown
        ? {
            instructionBreakdown: structuredClone(
              initial.instructionBreakdown
            )
          }
        : {})
    }
  }

  apply(envelope: PersistedTurnEventEnvelope): 'applied' | 'duplicate' {
    if (envelope.turnId !== this.snapshot.turnId) {
      throw new Error('Durable event belongs to a different turn.')
    }
    if (envelope.sequence <= this.snapshot.lastSequence) return 'duplicate'
    if (this.snapshot.terminal) {
      throw new Error('Durable event arrived after the terminal outcome.')
    }
    const payload = envelope.payload
    if (payload.type === 'turn_accepted') {
      this.snapshot.accepted = true
      this.snapshot.phase = payload.phase
      this.snapshot.status = payload.status
    } else if (payload.type === 'turn_progress') {
      this.snapshot.phase = payload.phase
      this.snapshot.status = payload.status
    } else if (payload.type === 'skill_activated') {
      const index = this.snapshot.activeSkills.findIndex(
        (skill) => skill.skillId === payload.skill.skillId
      )
      if (index < 0) this.snapshot.activeSkills.push(payload.skill)
      else this.snapshot.activeSkills.splice(index, 1, payload.skill)
    } else if (payload.type === 'instruction_breakdown') {
      this.snapshot.instructionBreakdown = payload.breakdown
    } else if (payload.type === 'assistant_text_delta') {
      this.snapshot.assistantText += payload.text
    } else if (payload.type === 'operation_receipt') {
      const index = this.snapshot.operationReceipts.findIndex(
        (receipt) => receipt.operationId === payload.receipt.operationId
      )
      if (index < 0) this.snapshot.operationReceipts.push(payload.receipt)
      else this.snapshot.operationReceipts.splice(index, 1, payload.receipt)
    } else if (payload.type === 'turn_finished') {
      this.snapshot.phase = payload.phase
      this.snapshot.status = payload.status
      this.snapshot.terminal = payload
    }
    this.snapshot.lastSequence = envelope.sequence
    return 'applied'
  }

  get value(): TurnProjectionSnapshot {
    return structuredClone(this.snapshot)
  }
}
