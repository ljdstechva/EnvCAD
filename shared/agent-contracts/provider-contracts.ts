import { z } from 'zod'
import { structuredFailureSchema, type StructuredFailure } from './failures'

export const PROVIDER_IDS = ['claude-code', 'openai-codex'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]
export type ProviderHealth =
  | 'checking'
  | 'ready'
  | 'degraded'
  | 'missing'
  | 'authentication-required'
  | 'incompatible'
  | 'failed'
  | 'circuit-open'

export interface AgentConfiguration {
  provider: ProviderId
  model: string
  effort?: string
}

export interface EffortCapability {
  value: string
  displayName: string
  description?: string
  isDefault: boolean
}

export interface ModelCapability {
  id: string
  invocationName: string
  resolvedModel?: string
  displayName: string
  description: string
  supportedEfforts: EffortCapability[]
  defaultEffort?: string
  inputModalities?: ('text' | 'image' | 'audio')[]
  isDefault: boolean
}

export interface ProviderCapability {
  id: ProviderId
  displayName: string
  status: ProviderHealth
  statusMessage: string
  executableVersion?: string
  models: ModelCapability[]
  discoveryMs?: number
}

export type ProviderServerEvent =
  | {
      type: 'ai_capabilities'
      providers: ProviderCapability[]
      refreshing: boolean
    }
  | { type: 'ai_provider_status'; provider: ProviderCapability }
  | {
      type: 'ai_configuration_applied'
      revision: number
      configuration: AgentConfiguration
      newConversation: boolean
    }
  | {
      type: 'ai_configuration_rejected'
      revision: number
      failure: StructuredFailure
    }

const identifierSchema = z.string().min(1).max(200)
const effortCapabilitySchema: z.ZodType<EffortCapability> = z.strictObject({
  value: identifierSchema.refine(
    (value) => value !== 'ultra',
    'Ultra effort is disabled because EnvCAD does not permit provider subagents.'
  ),
  displayName: z.string().min(1).max(500),
  description: z.string().min(1).max(4_000).optional(),
  isDefault: z.boolean()
})

const modelCapabilitySchema: z.ZodType<ModelCapability> = z
  .strictObject({
    id: identifierSchema,
    invocationName: identifierSchema,
    resolvedModel: identifierSchema.optional(),
    displayName: z.string().min(1).max(500),
    description: z.string().max(4_000),
    supportedEfforts: z.array(effortCapabilitySchema).max(20),
    defaultEffort: identifierSchema.optional(),
    inputModalities: z.array(z.enum(['text', 'image', 'audio'])).max(3).optional(),
    isDefault: z.boolean()
  })
  .superRefine((model, context) => {
    const values = model.supportedEfforts.map((effort) => effort.value)
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: 'custom',
        path: ['supportedEfforts'],
        message: 'Effort values must be unique.'
      })
    }
    const defaults = model.supportedEfforts.filter((effort) => effort.isDefault)
    if (defaults.length > 1) {
      context.addIssue({
        code: 'custom',
        path: ['supportedEfforts'],
        message: 'A model may advertise at most one default effort.'
      })
    }
    if (
      model.defaultEffort &&
      (defaults.length !== 1 || defaults[0].value !== model.defaultEffort)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['defaultEffort'],
        message: 'defaultEffort must reference the advertised default effort.'
      })
    }
    if (
      model.inputModalities &&
      new Set(model.inputModalities).size !== model.inputModalities.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['inputModalities'],
        message: 'Input modalities must be unique.'
      })
    }
  })

export const providerCapabilitySchema: z.ZodType<ProviderCapability> =
  z
    .strictObject({
      id: z.enum(PROVIDER_IDS),
      displayName: z.string().min(1).max(500),
      status: z.enum([
        'checking',
        'ready',
        'degraded',
        'missing',
        'authentication-required',
        'incompatible',
        'failed',
        'circuit-open'
      ]),
      statusMessage: z.string().min(1).max(4_000),
      executableVersion: identifierSchema.optional(),
      models: z.array(modelCapabilitySchema).max(100),
      discoveryMs: z.number().nonnegative().finite().optional()
    })
    .superRefine((provider, context) => {
      const modelIds = provider.models.map((model) => model.id)
      const invocationNames = provider.models.map((model) => model.invocationName)
      if (new Set(modelIds).size !== modelIds.length) {
        context.addIssue({
          code: 'custom',
          path: ['models'],
          message: 'Provider model IDs must be unique.'
        })
      }
      if (new Set(invocationNames).size !== invocationNames.length) {
        context.addIssue({
          code: 'custom',
          path: ['models'],
          message: 'Provider model invocation names must be unique.'
        })
      }
      const defaultModels = provider.models.filter((model) => model.isDefault)
      if (provider.status === 'ready' && provider.models.length === 0) {
        context.addIssue({
          code: 'custom',
          path: ['models'],
          message: 'A ready provider must advertise at least one model.'
        })
      }
      if (provider.models.length > 0 && defaultModels.length !== 1) {
        context.addIssue({
          code: 'custom',
          path: ['models'],
          message: 'A provider with models must advertise exactly one default model.'
        })
      }
    })

export const agentConfigurationSchema: z.ZodType<AgentConfiguration> =
  z.strictObject({
    provider: z.enum(PROVIDER_IDS),
    model: identifierSchema,
    effort: identifierSchema.optional()
  })

export const providerServerEventSchema: z.ZodType<ProviderServerEvent> =
  z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('ai_capabilities'),
      providers: z.array(providerCapabilitySchema).max(PROVIDER_IDS.length),
      refreshing: z.boolean()
    }),
    z.strictObject({
      type: z.literal('ai_provider_status'),
      provider: providerCapabilitySchema
    }),
    z.strictObject({
      type: z.literal('ai_configuration_applied'),
      revision: z.number().int().positive().safe(),
      configuration: agentConfigurationSchema,
      newConversation: z.boolean()
    }),
    z.strictObject({
      type: z.literal('ai_configuration_rejected'),
      revision: z.number().int().positive().safe(),
      failure: structuredFailureSchema
    })
  ])
