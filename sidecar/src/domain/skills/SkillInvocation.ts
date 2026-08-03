import type {
  SkillActivation,
  SkillManifest
} from '../../../../shared/agent-contracts'
import type { TurnIntent } from '../turn/InstructionBreakdown'

export interface SkillInvocation {
  intent: TurnIntent
  activations: SkillActivation[]
  manifests: SkillManifest[]
  promptFragment: string
  allowedTools: ReadonlySet<string>
  activeSkillIds: ReadonlySet<string>
  verifiedSkillIds: ReadonlySet<string>
  degradedBehaviors: string[]
  mutationBlockedReason?: string
}
