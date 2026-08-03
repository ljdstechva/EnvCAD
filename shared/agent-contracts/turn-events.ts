import type {
  RecoverySummary,
  StructuredFailure
} from './failures'
import type { OperationReceipt } from './operation'
import type { SkillActivation } from './skill-manifest'
import type {
  WorkspaceRevision,
  WorkspaceRevisionTransitionKind
} from './workspace-revision'
import { z } from 'zod'
import {
  recoverySummarySchema,
  structuredFailureSchema
} from './failures'
import { operationReceiptSchema } from './operation'
import { skillActivationSchema } from './skill-manifest'
import {
  sameWorkspaceRevision,
  workspaceRevisionSchema
} from './workspace-revision'

export type TurnPhase =
  | 'draft'
  | 'accepted'
  | 'ingesting'
  | 'briefing'
  | 'planning'
  | 'inspecting'
  | 'executing'
  | 'verifying'
  | 'recovering'
  | 'retrying'
  | 'degraded'
  | 'needs-input'
  | 'completed'
  | 'cancelled'
  | 'failed'

export type TurnOutcome =
  | 'completed'
  | 'recovered'
  | 'needs-input'
  | 'cancelled'
  | 'failed'

export type TurnProgressPhase = Exclude<
  TurnPhase,
  'draft' | 'accepted' | 'completed' | 'needs-input' | 'cancelled' | 'failed'
>

export interface TurnMetrics {
  acceptedMs?: number
  firstProgressMs?: number
  providerReadyMs?: number
  conversationStartupMs?: number
  firstTextMs?: number
  firstToolCallMs?: number
  totalMs: number
  toolCalls: number
  retries?: number
  inputTokens?: number
  outputTokens?: number
}

export interface InstructionBreakdown {
  objective: string
  inputs: string[]
  constraints: string[]
  requiredDrawingContext: string[]
  plannedToolCategories: string[]
  expectedOutput: string
  riskLevel: 'low' | 'medium' | 'high'
}

export interface VerificationSummary {
  mode: 'database-and-visual' | 'database-only' | 'not-applicable'
  databaseChecks: string[]
  visualEvidenceIds: string[]
  warnings: string[]
  revision: WorkspaceRevision
}

export interface TurnTransition {
  turnId: string
  phase: TurnPhase
  revision: WorkspaceRevision
  revisionTransition: WorkspaceRevisionTransitionKind
  activeSkillIds: string[]
  provider: string
  elapsedMs: number
  status: string
}

export interface TurnAccepted extends TurnTransition {
  type: 'turn_accepted'
  messageId: string
  phase: 'accepted'
}

export interface TurnProgress extends TurnTransition {
  type: 'turn_progress'
  phase: TurnProgressPhase
}

export interface TurnFinished extends TurnTransition {
  type: 'turn_finished'
  phase: 'completed' | 'needs-input' | 'cancelled' | 'failed'
  outcome: TurnOutcome
  finalRevision: WorkspaceRevision
  recovery?: RecoverySummary
  error?: StructuredFailure
  verification?: VerificationSummary
  metrics: TurnMetrics
}

export type TurnEvent =
  | TurnAccepted
  | TurnProgress
  | { type: 'instruction_breakdown'; turnId: string; breakdown: InstructionBreakdown }
  | { type: 'skill_activated'; turnId: string; skill: SkillActivation }
  | { type: 'assistant_text_delta'; turnId: string; text: string }
  | { type: 'operation_receipt'; turnId: string; receipt: OperationReceipt }
  | TurnFinished

export const isTerminalTurnEvent = (
  event: TurnEvent
): event is TurnFinished => event.type === 'turn_finished'

const identifierSchema = z.string().min(1).max(200)
const phaseSchema = z.enum([
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
const transitionFields = {
  turnId: identifierSchema,
  revision: workspaceRevisionSchema,
  revisionTransition: z.enum(['same-document', 'document-replaced']),
  activeSkillIds: z.array(identifierSchema).max(50),
  provider: identifierSchema,
  elapsedMs: z.number().nonnegative().finite(),
  status: z.string().min(1).max(1_000)
}

export const turnMetricsSchema: z.ZodType<TurnMetrics> = z.strictObject({
  acceptedMs: z.number().nonnegative().finite().optional(),
  firstProgressMs: z.number().nonnegative().finite().optional(),
  providerReadyMs: z.number().nonnegative().finite().optional(),
  conversationStartupMs: z.number().nonnegative().finite().optional(),
  firstTextMs: z.number().nonnegative().finite().optional(),
  firstToolCallMs: z.number().nonnegative().finite().optional(),
  totalMs: z.number().nonnegative().finite(),
  toolCalls: z.number().int().nonnegative().safe(),
  retries: z.number().int().nonnegative().safe().optional(),
  inputTokens: z.number().int().nonnegative().safe().optional(),
  outputTokens: z.number().int().nonnegative().safe().optional()
})

export const instructionBreakdownSchema: z.ZodType<InstructionBreakdown> =
  z.strictObject({
    objective: z.string().min(1).max(2_000),
    inputs: z.array(z.string().min(1).max(1_000)).max(100),
    constraints: z.array(z.string().min(1).max(1_000)).max(100),
    requiredDrawingContext: z.array(z.string().min(1).max(1_000)).max(100),
    plannedToolCategories: z.array(identifierSchema).max(50),
    expectedOutput: z.string().min(1).max(2_000),
    riskLevel: z.enum(['low', 'medium', 'high'])
  })

export const verificationSummarySchema: z.ZodType<VerificationSummary> =
  z.strictObject({
    mode: z.enum([
      'database-and-visual',
      'database-only',
      'not-applicable'
    ]),
    databaseChecks: z.array(z.string().min(1).max(1_000)).max(100),
    visualEvidenceIds: z.array(identifierSchema).max(50),
    warnings: z.array(z.string().min(1).max(2_000)).max(50),
    revision: workspaceRevisionSchema
  })

export const turnAcceptedSchema = z.strictObject({
  type: z.literal('turn_accepted'),
  ...transitionFields,
  messageId: identifierSchema,
  phase: z.literal('accepted'),
  revisionTransition: z.literal('same-document')
})

export const turnProgressSchema = z.strictObject({
  type: z.literal('turn_progress'),
  ...transitionFields,
  phase: phaseSchema
})

export const turnFinishedSchema = z
  .strictObject({
    type: z.literal('turn_finished'),
    ...transitionFields,
    phase: z.enum(['completed', 'needs-input', 'cancelled', 'failed']),
    outcome: z.enum([
      'completed',
      'recovered',
      'needs-input',
      'cancelled',
      'failed'
    ]),
    finalRevision: workspaceRevisionSchema,
    recovery: recoverySummarySchema.optional(),
    error: structuredFailureSchema.optional(),
    verification: verificationSummarySchema.optional(),
    metrics: turnMetricsSchema
  })
  .superRefine((event, context) => {
    const expectedPhase =
      event.outcome === 'completed' || event.outcome === 'recovered'
        ? 'completed'
        : event.outcome
    if (event.phase !== expectedPhase) {
      context.addIssue({
        code: 'custom',
        path: ['phase'],
        message: `Outcome "${event.outcome}" requires phase "${expectedPhase}".`
      })
    }
    if (!sameWorkspaceRevision(event.revision, event.finalRevision)) {
      context.addIssue({
        code: 'custom',
        path: ['finalRevision'],
        message: 'finalRevision must match the terminal transition revision.'
      })
    }
    if (
      event.verification &&
      !sameWorkspaceRevision(
        event.verification.revision,
        event.finalRevision
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['verification', 'revision'],
        message: 'Verification must be bound to the final workspace revision.'
      })
    }
    if (
      event.verification?.mode === 'database-and-visual' &&
      event.verification.visualEvidenceIds.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        path: ['verification', 'visualEvidenceIds'],
        message: 'Visual verification requires at least one evidence id.'
      })
    }
    if (event.outcome === 'failed' && !event.error) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'Failed turns require a structured error.'
      })
    }
    if (event.outcome === 'recovered' && !event.recovery) {
      context.addIssue({
        code: 'custom',
        path: ['recovery'],
        message: 'Recovered turns require a recovery summary.'
      })
    }
    if (event.outcome !== 'failed' && event.error) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'Only failed turns may carry a structured error.'
      })
    }
    if (event.outcome !== 'recovered' && event.recovery) {
      context.addIssue({
        code: 'custom',
        path: ['recovery'],
        message: 'Only recovered turns may carry a recovery summary.'
      })
    }
  })

export const turnEventSchema = z.discriminatedUnion(
  'type',
  [
    turnAcceptedSchema,
    turnProgressSchema,
    z.strictObject({
      type: z.literal('instruction_breakdown'),
      turnId: identifierSchema,
      breakdown: instructionBreakdownSchema
    }),
    z.strictObject({
      type: z.literal('skill_activated'),
      turnId: identifierSchema,
      skill: skillActivationSchema
    }),
    z.strictObject({
      type: z.literal('assistant_text_delta'),
      turnId: identifierSchema,
      text: z.string().min(1).max(100_000)
    }),
    z.strictObject({
      type: z.literal('operation_receipt'),
      turnId: identifierSchema,
      receipt: operationReceiptSchema
    }),
    turnFinishedSchema
  ]
)
