import { z } from 'zod'
import {
  MAX_INLINE_TURN_TEXT_UTF8_BYTES,
  agentConfigurationSchema,
  instructionBreakdownSchema,
  operationReceiptSchema,
  skillActivationSchema,
  workspaceRevisionSchema,
  type AgentConfiguration,
  type InstructionBreakdown,
  type OperationReceipt,
  type SkillActivation,
  type TurnPhase,
  type WorkspaceRevision
} from '../../../shared/agent-contracts'
import type { SelectionSnapshot, SheetSnapshot } from '../protocol'

export const DURABLE_TURN_SESSION_STORAGE_KEY =
  'envcad.agent.turn-session.v2'
export const DURABLE_TURN_SESSION_STORAGE_VERSION = 1 as const

export interface DurableActiveTurn {
  turnId: string
  messageId: string
  clientSequence: number
  timestamp: string
  text: string
  instructionInputId?: string
  referenceInputIds?: string[]
  originalInputByteLength?: number
  selectionSnapshot: SelectionSnapshot
  workspaceRevision: WorkspaceRevision
  sheet: SheetSnapshot
  configurationRevision: number
  configuration: AgentConfiguration
  lastServerSequence: number
  streamingText: string
  accepted: boolean
  projection?: DurableTurnProjectionState
}

export interface DurableTurnProjectionState {
  phase?: TurnPhase
  status: string
  activeSkills: SkillActivation[]
  instructionBreakdown?: InstructionBreakdown
  operationReceipts: OperationReceipt[]
}

export interface StoredTurnSession {
  version: typeof DURABLE_TURN_SESSION_STORAGE_VERSION
  sessionId: string
  nextClientSequence: number
  activeTurn?: DurableActiveTurn
}

const identifierSchema = z.string().min(1).max(1_000)
const safeNonnegativeInteger = z.number().int().nonnegative().safe()
const safePositiveInteger = z.number().int().positive().safe()
const timestampSchema = z
  .string()
  .min(20)
  .max(40)
  .refine((value) => Number.isFinite(Date.parse(value)), 'Invalid timestamp')

export const selectionSnapshotSchema: z.ZodType<SelectionSnapshot> = z
  .strictObject({
    ids: z.array(identifierSchema).max(100_000),
    count: safeNonnegativeInteger,
    units: z.string().min(1).max(100),
    revision: z.strictObject({
      documentRevision: safeNonnegativeInteger,
      contentRevision: safeNonnegativeInteger
    })
  })
  .superRefine((selection, context) => {
    if (selection.count !== selection.ids.length) {
      context.addIssue({
        code: 'custom',
        path: ['count'],
        message: 'Frozen selection count must match its entity ids.'
      })
    }
  })

export const sheetSnapshotSchema: z.ZodType<SheetSnapshot> = z.strictObject({
  paper: z.string().min(1).max(100),
  orientation: z.enum(['portrait', 'landscape']),
  scaleDenominator: z.number().positive().finite(),
  drawingUnit: z.string().min(1).max(100),
  templateId: identifierSchema.optional(),
  fields: z
    .record(identifierSchema, z.string().max(4_000))
    .refine((fields) => Object.keys(fields).length <= 100, 'Too many sheet fields')
    .optional()
})

const projectionStateSchema: z.ZodType<DurableTurnProjectionState> =
  z.strictObject({
    phase: z
      .enum([
        'draft',
        'accepted',
        'ingesting',
        'briefing',
        'planning',
        'inspecting',
        'executing',
        'verifying',
        'recovering',
        'retrying',
        'degraded',
        'needs-input',
        'completed',
        'cancelled',
        'failed'
      ])
      .optional(),
    status: z.string().max(1_000),
    activeSkills: z.array(skillActivationSchema).max(50),
    instructionBreakdown: instructionBreakdownSchema.optional(),
    operationReceipts: z.array(operationReceiptSchema).max(1_000)
  })

const durableActiveTurnSchema: z.ZodType<DurableActiveTurn> = z
  .strictObject({
    turnId: identifierSchema,
    messageId: identifierSchema,
    clientSequence: safePositiveInteger,
    timestamp: timestampSchema,
    text: z
      .string()
      .min(1)
      .max(1_000_000)
      .refine(
        (text) =>
          new TextEncoder().encode(text).byteLength <=
          MAX_INLINE_TURN_TEXT_UTF8_BYTES,
        'Durable inline instruction exceeds the protocol limit.'
      ),
    instructionInputId: identifierSchema.optional(),
    referenceInputIds: z.array(identifierSchema).max(1_000).optional(),
    originalInputByteLength: safeNonnegativeInteger.optional(),
    selectionSnapshot: selectionSnapshotSchema,
    workspaceRevision: workspaceRevisionSchema,
    sheet: sheetSnapshotSchema,
    configurationRevision: safePositiveInteger,
    configuration: agentConfigurationSchema,
    lastServerSequence: safeNonnegativeInteger,
    streamingText: z.string().max(20_000_000),
    accepted: z.boolean(),
    projection: projectionStateSchema.optional()
  })
  .superRefine((turn, context) => {
    const selectionRevision = turn.selectionSnapshot.revision
    if (
      selectionRevision.documentRevision !==
        turn.workspaceRevision.documentRevision ||
      selectionRevision.contentRevision !== turn.workspaceRevision.contentRevision
    ) {
      context.addIssue({
        code: 'custom',
        path: ['selectionSnapshot', 'revision'],
        message: 'Frozen selection revision must match the workspace revision.'
      })
    }
  })

const storedTurnSessionSchema: z.ZodType<StoredTurnSession> = z
  .strictObject({
    version: z.literal(DURABLE_TURN_SESSION_STORAGE_VERSION),
    sessionId: identifierSchema,
    nextClientSequence: safeNonnegativeInteger,
    activeTurn: durableActiveTurnSchema.optional()
  })
  .superRefine((session, context) => {
    if (
      session.activeTurn &&
      session.nextClientSequence < session.activeTurn.clientSequence
    ) {
      context.addIssue({
        code: 'custom',
        path: ['nextClientSequence'],
        message: 'Client sequence cannot precede the active turn command.'
      })
    }
  })

export function parseStoredTurnSession(value: unknown): StoredTurnSession {
  return storedTurnSessionSchema.parse(value)
}
