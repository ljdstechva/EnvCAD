import type { SkillActivation } from '../../../../shared/agent-contracts'
import {
  invokeTextToCadSkillForTurn,
  TEXT_TO_CAD_SKILL
} from '../../textToCadSkill'

export interface MandatoryCadSkillActivation {
  activations: SkillActivation[]
  promptFragment: string
}

export function activateMandatoryCadSkills(
  activatedAt: string
): MandatoryCadSkillActivation {
  const promptFragment = invokeTextToCadSkillForTurn()
  return {
    activations: [
      {
        skillId: 'cad-core',
        name: 'CAD Core',
        version: TEXT_TO_CAD_SKILL.version,
        integrity: 'verified',
        activatedAt
      },
      {
        skillId: 'dxf-core',
        name: 'DXF Core',
        version: TEXT_TO_CAD_SKILL.version,
        integrity: 'verified',
        activatedAt
      }
    ],
    promptFragment
  }
}
