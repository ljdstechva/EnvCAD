import type { SkillActivation } from '../../../../shared/agent-contracts'
import type { SkillInvocation } from '../../domain/skills/SkillInvocation'
import type { RegisteredSkill } from '../../domain/skills/SkillManifest'
import type { TurnIntent } from '../../domain/turn/InstructionBreakdown'
import type { SkillIntegrityResult } from './SkillIntegrityService'

export interface SkillCompilationInput {
  intent: TurnIntent
  skills: RegisteredSkill[]
  integrity: ReadonlyMap<string, SkillIntegrityResult>
  activatedAt: string
}

export class SkillCompiler {
  compile(input: SkillCompilationInput): SkillInvocation {
    const activations = input.skills.map((skill) =>
      activation(skill, input.integrity.get(skill.manifest.id), input.activatedAt)
    )
    const verified = input.skills.filter(
      (skill) => input.integrity.get(skill.manifest.id)?.verified === true
    )
    const failed = input.skills.filter(
      (skill) => input.integrity.get(skill.manifest.id)?.verified !== true
    )
    return {
      intent: input.intent,
      activations,
      manifests: verified.map((skill) => ({ ...skill.manifest })),
      promptFragment: compilePrompt(input.intent, verified, failed),
      allowedTools: new Set(
        verified.flatMap((skill) => skill.manifest.allowedTools)
      ),
      activeSkillIds: new Set(input.skills.map((skill) => skill.manifest.id)),
      verifiedSkillIds: new Set(
        verified.map((skill) => skill.manifest.id)
      ),
      degradedBehaviors: failed.map(
        (skill) => skill.manifest.degradedBehavior
      ),
      ...(failed.some((skill) => skill.mandatory)
        ? {
            mutationBlockedReason:
              'A mandatory CAD skill failed its integrity check. AI drawing changes are disabled; manual CAD remains available.'
          }
        : {})
    }
  }
}

function activation(
  skill: RegisteredSkill,
  integrity: SkillIntegrityResult | undefined,
  activatedAt: string
): SkillActivation {
  return {
    skillId: skill.manifest.id,
    name: skill.displayName,
    version: skill.manifest.version,
    integrity: integrity?.verified === true ? 'verified' : 'failed',
    activatedAt
  }
}

function compilePrompt(
  intent: TurnIntent,
  verified: RegisteredSkill[],
  failed: RegisteredSkill[]
): string {
  const lines = [
    `<envcad-skill-manifest intent="${intent}">`,
    ...verified.map(
      (skill) =>
        `- ${skill.manifest.id}@${skill.manifest.version}: ${skill.manifest.promptFragment}`
    ),
    ...failed.map(
      (skill) =>
        `- ${skill.manifest.id}: INTEGRITY FAILED. ${skill.manifest.degradedBehavior}`
    ),
    '</envcad-skill-manifest>'
  ]
  return lines.join('\n')
}
