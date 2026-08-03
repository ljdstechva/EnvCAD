import { skillManifestSchema } from '../../../../shared/agent-contracts'
import type { SkillInvocation } from '../../domain/skills/SkillInvocation'
import type {
  EnvCadSkillId,
  RegisteredSkill
} from '../../domain/skills/SkillManifest'
import { bundledSkillCatalog } from './BundledSkillCatalog'
import { SkillCompiler } from './SkillCompiler'
import {
  SkillIntegrityService,
  type SkillIntegrityResult
} from './SkillIntegrityService'
import { SkillRouter } from './SkillRouter'
import type { SubmitTurnCommand } from '../../../../shared/agent-contracts'

export interface SkillMutationCheck {
  allowed: boolean
  reason?: string
}

export class SkillRegistry {
  private readonly skills = new Map<EnvCadSkillId, RegisteredSkill>()
  private readonly integrity = new Map<string, SkillIntegrityResult>()
  private initialized = false

  constructor(
    catalog: readonly RegisteredSkill[] = bundledSkillCatalog(),
    private readonly integrityService = new SkillIntegrityService(),
    private readonly router = new SkillRouter(),
    private readonly compiler = new SkillCompiler()
  ) {
    for (const skill of catalog) this.register(skill)
  }

  initialize(): void {
    if (this.initialized) return
    for (const skill of this.skills.values()) {
      this.integrity.set(
        skill.manifest.id,
        this.integrityService.verify(skill, true)
      )
    }
    this.initialized = true
  }

  activate(
    command: SubmitTurnCommand,
    activatedAt = new Date().toISOString(),
    resolvedInstruction?: string
  ): SkillInvocation {
    this.initialize()
    const route = this.router.route(command, resolvedInstruction)
    const selected = route.skillIds.map((id) => this.requiredSkill(id))
    for (const skill of selected) {
      this.integrity.set(
        skill.manifest.id,
        this.integrityService.verify(skill, false)
      )
    }
    return this.compiler.compile({
      intent: route.intent,
      skills: selected,
      integrity: this.integrity,
      activatedAt
    })
  }

  verifyBeforeMutation(requiredSkillIds: readonly string[]): SkillMutationCheck {
    this.initialize()
    for (const id of requiredSkillIds) {
      const skill = this.skills.get(id as EnvCadSkillId)
      if (!skill) {
        return { allowed: false, reason: `Required skill "${id}" is unavailable.` }
      }
      const result = this.integrityService.verify(skill, true)
      this.integrity.set(id, result)
      if (!result.verified) {
        return {
          allowed: false,
          reason:
            result.reason ??
            `Required skill "${id}" failed its integrity check.`
        }
      }
    }
    return { allowed: true }
  }

  integrityOf(skillId: string): SkillIntegrityResult | undefined {
    const result = this.integrity.get(skillId)
    return result ? { ...result } : undefined
  }

  private register(skill: RegisteredSkill): void {
    skillManifestSchema.parse(skill.manifest)
    if (this.skills.has(skill.manifest.id)) {
      throw new Error(`Duplicate bundled skill "${skill.manifest.id}".`)
    }
    this.skills.set(skill.manifest.id, skill)
  }

  private requiredSkill(id: EnvCadSkillId): RegisteredSkill {
    const skill = this.skills.get(id)
    if (!skill) throw new Error(`Bundled skill "${id}" is not registered.`)
    return skill
  }
}
