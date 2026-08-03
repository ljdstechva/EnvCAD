export type FailureKind =
  | 'validation'
  | 'domain'
  | 'stale-workspace'
  | 'transient-tool'
  | 'transient-provider'
  | 'rate-limit'
  | 'authentication'
  | 'permission'
  | 'security'
  | 'cancelled'
  | 'unknown-operation'

export type RecoveryActionKind =
  | 'retry'
  | 'resume'
  | 'replan'
  | 'undo'
  | 'choose-provider'
  | 'free-space'
  | 'open-drawing'
  | 'export-diagnostics'

export interface RecoveryAction {
  id: string
  kind: RecoveryActionKind
  label: string
  enabled: boolean
  requiresApproval?: boolean
}

export interface StructuredFailure {
  kind: FailureKind
  code: string
  userMessage: string
  developerMessage?: string
  retryable: boolean
  retryAfterMs?: number
  fieldErrors?: Record<string, string>
  recoveryActions: RecoveryAction[]
}

export interface RecoveryAttempt {
  strategy: string
  attempt: number
  startedAt: string
  completedAt?: string
  succeeded?: boolean
}

export interface RecoverySummary {
  attempts: RecoveryAttempt[]
  drawingChanged: boolean | 'unknown'
  resumedFromJournal: boolean
}

const identifierSchema = z.string().min(1).max(200)
const timestampSchema = z
  .string()
  .min(20)
  .max(40)
  .refine((value) => Number.isFinite(Date.parse(value)), 'Invalid timestamp')

export const recoveryActionSchema: z.ZodType<RecoveryAction> = z.strictObject({
  id: identifierSchema,
  kind: z.enum([
    'retry',
    'resume',
    'replan',
    'undo',
    'choose-provider',
    'free-space',
    'open-drawing',
    'export-diagnostics'
  ]),
  label: z.string().min(1).max(500),
  enabled: z.boolean(),
  requiresApproval: z.boolean().optional()
})

export const structuredFailureSchema: z.ZodType<StructuredFailure> =
  z.strictObject({
    kind: z.enum([
      'validation',
      'domain',
      'stale-workspace',
      'transient-tool',
      'transient-provider',
      'rate-limit',
      'authentication',
      'permission',
      'security',
      'cancelled',
      'unknown-operation'
    ]),
    code: identifierSchema,
    userMessage: z.string().min(1).max(4_000),
    developerMessage: z.string().min(1).max(8_000).optional(),
    retryable: z.boolean(),
    retryAfterMs: z.number().int().nonnegative().safe().optional(),
    fieldErrors: z.record(identifierSchema, z.string().min(1).max(2_000)).optional(),
    recoveryActions: z.array(recoveryActionSchema).max(20)
  })

export const recoveryAttemptSchema: z.ZodType<RecoveryAttempt> = z.strictObject({
  strategy: identifierSchema,
  attempt: z.number().int().positive().safe(),
  startedAt: timestampSchema,
  completedAt: timestampSchema.optional(),
  succeeded: z.boolean().optional()
})

export const recoverySummarySchema: z.ZodType<RecoverySummary> = z.strictObject({
  attempts: z.array(recoveryAttemptSchema).max(50),
  drawingChanged: z.union([z.boolean(), z.literal('unknown')]),
  resumedFromJournal: z.boolean()
})
import { z } from 'zod'
