import {
  assertWorkspaceRevisionTransition,
  canTransitionTurnPhase,
  cloneWorkspaceRevision,
  isActiveTurnPhase,
  skillActivationSchema,
  workspaceRevisionSchema,
  type SkillActivation,
  type TurnPhase,
  type WorkspaceRevision,
  type WorkspaceRevisionTransitionKind
} from '../../../../shared/agent-contracts'
import type { TurnTransitionUpdate } from './TurnStateMachine'

export interface PreparedTurnState {
  revision: WorkspaceRevision
  revisionTransition: WorkspaceRevisionTransitionKind
  activeSkills: SkillActivation[]
  provider: string
}

export function prepareTurnState(
  current: PreparedTurnState,
  update: TurnTransitionUpdate
): PreparedTurnState {
  const revision = update.revision
    ? workspaceRevisionSchema.parse(update.revision)
    : cloneWorkspaceRevision(current.revision)
  const revisionTransition = update.revisionTransition ?? 'same-document'
  assertWorkspaceRevisionTransition(
    current.revision,
    revision,
    revisionTransition
  )
  const activeSkills = update.activeSkills
    ? parseActiveSkills(update.activeSkills)
    : current.activeSkills.map((skill) => ({ ...skill }))
  assertMandatorySkills(activeSkills)
  return {
    revision,
    revisionTransition,
    activeSkills,
    provider: update.provider ?? current.provider
  }
}

export function transitionSnapshot(
  state: PreparedTurnState,
  status: string,
  elapsedMs: number,
  revisionTransition: WorkspaceRevisionTransitionKind
) {
  if (status.trim() === '') throw new Error('Turn status must not be blank.')
  return {
    revision: cloneWorkspaceRevision(state.revision),
    revisionTransition,
    activeSkillIds: state.activeSkills.map((skill) => skill.skillId),
    provider: state.provider,
    elapsedMs: Math.max(0, elapsedMs),
    status
  }
}

export function isActivePhase(phase: TurnPhase): boolean {
  return isActiveTurnPhase(phase)
}

export function canTransition(
  phase: TurnPhase,
  nextPhase: TurnPhase
): boolean {
  return canTransitionTurnPhase(phase, nextPhase)
}

function parseActiveSkills(skills: readonly SkillActivation[]): SkillActivation[] {
  const parsed = skills.map((skill) => skillActivationSchema.parse(skill))
  const uniqueIds = new Set(parsed.map((skill) => skill.skillId))
  if (uniqueIds.size !== parsed.length) {
    throw new Error('Active skill ids must be unique.')
  }
  if (parsed.some((skill) => skill.integrity !== 'verified')) {
    throw new Error('Only integrity-verified skills may become active.')
  }
  return parsed
}

function assertMandatorySkills(skills: readonly SkillActivation[]): void {
  const skillIds = skills.map((skill) => skill.skillId)
  if (!skillIds.includes('cad-core') || !skillIds.includes('dxf-core')) {
    throw new Error('Active turns cannot remove mandatory CAD or DXF skills.')
  }
}
