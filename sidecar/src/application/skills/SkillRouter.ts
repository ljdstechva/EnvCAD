import type { SubmitTurnCommand } from '../../../../shared/agent-contracts'
import {
  classifyInstruction,
  type TurnIntent
} from '../../domain/turn/InstructionBreakdown'
import { skillsForInstruction } from '../../domain/skills/SkillPolicy'
import type { EnvCadSkillId } from '../../domain/skills/SkillManifest'

export interface SkillRoute {
  intent: TurnIntent
  skillIds: EnvCadSkillId[]
}

export class SkillRouter {
  route(
    command: SubmitTurnCommand,
    resolvedInstruction?: string
  ): SkillRoute {
    const source = command.text ?? resolvedInstruction ?? ''
    const { intent } = classifyInstruction(command, resolvedInstruction)
    return {
      intent,
      skillIds: skillsForInstruction(
        intent,
        source,
        command.instructionInputId !== undefined
      )
    }
  }
}
