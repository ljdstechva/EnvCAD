import { z } from 'zod'

export type SkillRetrySafety = 'safe' | 'idempotent-required' | 'never'

export interface SkillManifest {
  id: string
  version: string
  sourceProvenance: string
  sha256: string
  signature?: string
  supportedIntents: string[]
  requiredCapabilities: string[]
  allowedTools: string[]
  preconditions: string[]
  validationRules: string[]
  dataAccessScope: string[]
  retrySafety: SkillRetrySafety
  promptFragment: string
  degradedBehavior: string
}

export interface SkillActivation {
  skillId: string
  name: string
  version: string
  integrity: 'verified' | 'failed'
  activatedAt: string
}

export const MANDATORY_SKILL_IDS = ['cad-core', 'dxf-core'] as const
export type MandatorySkillId = (typeof MANDATORY_SKILL_IDS)[number]

const skillIdentifierSchema = z.string().min(1).max(200)
const skillStringListSchema = z.array(z.string().min(1).max(2_000)).max(500)

export const skillManifestSchema: z.ZodType<SkillManifest> = z.strictObject({
  id: skillIdentifierSchema,
  version: z.string().min(1).max(100),
  sourceProvenance: z.string().min(1).max(2_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  signature: z.string().min(1).max(8_192).optional(),
  supportedIntents: skillStringListSchema,
  requiredCapabilities: z.array(skillIdentifierSchema).max(100),
  allowedTools: z.array(skillIdentifierSchema).max(100),
  preconditions: skillStringListSchema,
  validationRules: skillStringListSchema,
  dataAccessScope: skillStringListSchema,
  retrySafety: z.enum(['safe', 'idempotent-required', 'never']),
  promptFragment: z.string().min(1).max(100_000),
  degradedBehavior: z.string().min(1).max(10_000)
})

export const skillActivationSchema: z.ZodType<SkillActivation> = z.strictObject({
  skillId: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(100),
  integrity: z.enum(['verified', 'failed']),
  activatedAt: z
    .string()
    .min(20)
    .max(40)
    .refine((value) => Number.isFinite(Date.parse(value)), 'Invalid timestamp')
})
