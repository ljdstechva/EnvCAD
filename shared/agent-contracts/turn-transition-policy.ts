import type { TurnPhase } from './turn-events'

const ACTIVE_PHASES = new Set<TurnPhase>([
  'accepted',
  'ingesting',
  'briefing',
  'planning',
  'inspecting',
  'executing',
  'verifying',
  'recovering',
  'retrying',
  'degraded'
])

const NORMAL_NEXT_PHASE: Partial<Record<TurnPhase, TurnPhase>> = {
  accepted: 'ingesting',
  ingesting: 'briefing',
  briefing: 'planning',
  planning: 'inspecting',
  inspecting: 'executing',
  executing: 'verifying',
  verifying: 'completed'
}

export function isActiveTurnPhase(phase: TurnPhase): boolean {
  return ACTIVE_PHASES.has(phase)
}

export function canTransitionTurnPhase(
  phase: TurnPhase,
  nextPhase: TurnPhase
): boolean {
  if (!isActiveTurnPhase(phase)) return false
  if (nextPhase === 'recovering') return phase !== 'recovering'
  if (phase === 'recovering') {
    return nextPhase === 'retrying' || nextPhase === 'degraded'
  }
  if (phase === 'retrying') {
    return [
      'planning',
      'inspecting',
      'executing',
      'verifying',
      'recovering'
    ].includes(nextPhase)
  }
  if (phase === 'degraded') return nextPhase === 'verifying'
  return NORMAL_NEXT_PHASE[phase] === nextPhase
}
