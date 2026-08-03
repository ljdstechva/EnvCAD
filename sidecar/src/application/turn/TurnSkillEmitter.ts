import type { SkillActivation } from '../../../../shared/agent-contracts'
import type { DurableTurnEventSink } from './DurableTurnEventSink'
import type { TurnCancellation } from './TurnCancellation'

export async function emitTurnSkills(
  sink: DurableTurnEventSink,
  cancellation: TurnCancellation,
  turnId: string,
  skills: readonly SkillActivation[]
): Promise<void> {
  for (const skill of skills) {
    cancellation.throwIfRequested()
    await sink.append(turnId, `skill-${skill.skillId}`, {
      type: 'skill_activated',
      turnId,
      skill
    })
  }
}
