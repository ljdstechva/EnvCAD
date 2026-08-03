import {
  assertWorkspaceRevisionTransition,
  canTransitionTurnPhase,
  isActiveTurnPhase,
  isTerminalTurnEvent,
  sameWorkspaceRevision,
  type OpenTurnSummary,
  type PersistedTurnEventEnvelope,
  type OpenTurnPhase,
  type SubmitTurnEnvelope,
  type TurnEvent,
  type TurnPhase
} from '../../shared/agent-contracts'
import type { TurnJournalRecord } from './TurnJournalRecordFile'

export interface TurnReplayState {
  draft: SubmitTurnEnvelope
  events: PersistedTurnEventEnvelope[]
  phase: TurnPhase
  recoveryObserved: boolean
}

export function createAcceptedState(
  record: Extract<TurnJournalRecord, { kind: 'accepted' }>
): TurnReplayState {
  const turnId = record.draft.turnId
  if (!turnId) throw new Error('accepted draft has no turnId')
  if (
    record.event.sessionId !== record.draft.sessionId ||
    record.event.turnId !== turnId ||
    record.event.payload.type !== 'turn_accepted' ||
    record.event.payload.messageId !== record.draft.messageId
  ) {
    throw new Error('acceptance envelope does not match its durable draft')
  }
  if (
    !sameWorkspaceRevision(
      record.event.payload.revision,
      record.draft.payload.selectionSnapshot.revision
    )
  ) {
    throw new Error('acceptance revision does not match its durable draft')
  }
  assertActiveSkillIds(record.event.payload.activeSkillIds)
  return {
    draft: clone(record.draft),
    events: [clone(record.event)],
    phase: 'accepted',
    recoveryObserved: false
  }
}

export function applyTurnEvent(
  state: TurnReplayState,
  event: PersistedTurnEventEnvelope
): TurnReplayState {
  const last = state.events.at(-1)
  if (!last) throw new Error('turn journal state has no acceptance event')
  const turnId = state.draft.turnId
  if (
    !turnId ||
    event.turnId !== turnId ||
    event.sessionId !== state.draft.sessionId ||
    event.sequence <= last.sequence
  ) {
    throw new Error('turn event envelope breaks turn identity or sequence')
  }
  if (isTerminalEnvelope(last)) {
    throw new Error('turn event appears after the terminal event')
  }
  if (event.payload.type === 'turn_accepted') {
    throw new Error('turn has more than one acceptance event')
  }

  let phase = state.phase
  let recoveryObserved = state.recoveryObserved
  if (event.payload.type === 'turn_progress') {
    if (!canTransitionTurnPhase(phase, event.payload.phase)) {
      throw new Error(
        `invalid turn transition from "${phase}" to "${event.payload.phase}"`
      )
    }
    assertRevisionTransition(state.events, event.payload)
    assertActiveSkillIds(event.payload.activeSkillIds)
    phase = event.payload.phase
    recoveryObserved ||= phase === 'recovering'
  } else if (event.payload.type === 'turn_finished') {
    assertRevisionTransition(state.events, event.payload)
    assertActiveSkillIds(event.payload.activeSkillIds)
    if (
      (event.payload.outcome === 'completed' ||
        event.payload.outcome === 'recovered') &&
      phase !== 'verifying'
    ) {
      throw new Error('successful terminal event does not follow verifying')
    }
    if (event.payload.outcome === 'completed' && recoveryObserved) {
      throw new Error('a recovered lifecycle cannot finish as completed')
    }
    if (
      (event.payload.outcome === 'recovered' ||
        event.payload.outcome === 'needs-input') &&
      !recoveryObserved
    ) {
      throw new Error('recovery terminal outcome has no recovering transition')
    }
    phase = event.payload.phase
  }
  return {
    draft: state.draft,
    events: [...state.events, clone(event)],
    phase,
    recoveryObserved
  }
}

export function isTerminalEnvelope(
  event: PersistedTurnEventEnvelope | undefined
): boolean {
  return Boolean(event && isTerminalTurnEvent(event.payload))
}

export function openTurnSummary(state: TurnReplayState): OpenTurnSummary {
  const turnId = state.draft.turnId
  const last = state.events.at(-1)
  if (!turnId || !last) {
    throw new Error('Open turn state is missing durable identity.')
  }
  if (!isActiveTurnPhase(state.phase) || state.phase === 'draft') {
    throw new Error('Open turn state has a non-active phase.')
  }
  return {
    turnId,
    sessionId: state.draft.sessionId,
    clientMessageId: state.draft.messageId,
    lastSequence: last.sequence,
    phase: state.phase as OpenTurnPhase
  }
}

function assertRevisionTransition(
  events: readonly PersistedTurnEventEnvelope[],
  payload: Extract<TurnEvent, { type: 'turn_progress' | 'turn_finished' }>
): void {
  const previous = latestTransition(events)
  assertWorkspaceRevisionTransition(
    previous.payload.revision,
    payload.revision,
    payload.revisionTransition
  )
}

function latestTransition(
  events: readonly PersistedTurnEventEnvelope[]
): PersistedTurnEventEnvelope & {
  payload: Extract<
    TurnEvent,
    { type: 'turn_accepted' | 'turn_progress' | 'turn_finished' }
  >
} {
  const transition = [...events]
    .reverse()
    .find(
      (event) =>
        event.payload.type === 'turn_accepted' ||
        event.payload.type === 'turn_progress' ||
        event.payload.type === 'turn_finished'
    )
  if (!transition) throw new Error('turn has no transition event')
  return transition as ReturnType<typeof latestTransition>
}

function assertActiveSkillIds(skillIds: readonly string[]): void {
  const unique = new Set(skillIds)
  if (
    unique.size !== skillIds.length ||
    !unique.has('cad-core') ||
    !unique.has('dxf-core')
  ) {
    throw new Error('turn transition has invalid mandatory active skills')
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}
