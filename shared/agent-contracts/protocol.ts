import { z } from 'zod'
import {
  inputReferenceSchema,
  inputIngestionCommandSchema,
  type InputIngestionCommand,
  type InputReference
} from './input-reference'
import {
  cadOperationRequestSchema,
  operationStatusResultSchema,
  type CadOperationRequest,
  type OperationStatusResult
} from './operation'
import { turnEventSchema, type TurnEvent } from './turn-events'
import { workspaceRevisionSchema } from './workspace-revision'
import {
  toolInputJsonSchema,
  toolResultV2Schema,
  jsonUtf8ByteLength,
  utf8ByteLength,
  type JsonValue,
  type ToolResultV2
} from './tool-result'
import {
  CAD_TOOL_NAMES,
  getToolManifestEntry,
  toolCallMayMutate,
  type CadToolName
} from './tool-manifest'
import {
  agentConfigurationSchema,
  providerServerEventSchema,
  type AgentConfiguration,
  type ProviderServerEvent
} from './provider-contracts'

export const AGENT_PROTOCOL_VERSION = 2 as const
export const MAX_INLINE_TURN_TEXT_UTF8_BYTES = 128 * 1024

export interface MessageEnvelope<T> {
  protocolVersion: typeof AGENT_PROTOCOL_VERSION
  sessionId: string
  messageId: string
  turnId?: string
  sequence: number
  timestamp: string
  payload: T
}

export interface SubmitTurnCommand {
  type: 'submit_turn'
  text?: string
  instructionInputId?: string
  referenceInputIds: string[]
  configurationRevision: number
  selectionSnapshot: ProtocolSelectionSnapshot
  sheet: ProtocolSheetSnapshot
}

export interface ProtocolSelectionSnapshot {
  count: number
  units: string
  revision: z.infer<typeof workspaceRevisionSchema>
}

export interface ProtocolSheetSnapshot {
  paper: string
  orientation: 'portrait' | 'landscape'
  scaleDenominator: number
  drawingUnit: string
  templateId?: string
  fields?: Record<string, string>
}

export type AgentClientCommand =
  | SubmitTurnCommand
  | InputIngestionCommand
  | { type: 'cancel_turn'; turnId: string }
  | { type: 'resume_turn'; turnId: string; lastSequence: number }
  | {
      type: 'operation_status'
      turnId: string
      requestId: string
      result: OperationStatusResult
    }
  | {
      type: 'tool_result'
      turnId: string
      callId: string
      operationId?: string
      result: ToolResultV2
    }
  | { type: 'refresh_ai_capabilities' }
  | {
      type: 'set_ai_configuration'
      revision: number
      configuration: AgentConfiguration
    }
  | { type: 'reset_conversation'; revision: number }

export type AgentServerPayload =
  | TurnEvent
  | ProviderServerEvent
  | {
      type: 'tool_call'
      turnId: string
      callId: string
      name: CadToolName
      input: JsonValue
      operation?: CadOperationRequest
    }
  | {
      type: 'get_operation_status'
      turnId: string
      requestId: string
      operationId: string
    }
  | {
      type: 'input_progress'
      inputId: string
      receivedBytes: number
      receivedChunks: number
      status: 'receiving' | 'validating' | 'indexing'
    }
  | { type: 'input_committed'; reference: InputReference }
  | { type: 'input_aborted'; inputId: string }
  | {
      type: 'protocol_error'
      code: string
      message: string
      inputId?: string
    }

export type AgentClientEnvelope = MessageEnvelope<AgentClientCommand>
export type AgentServerEnvelope = MessageEnvelope<AgentServerPayload>

export type ContractParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; developerMessage: string }

const identifierSchema = z.string().min(1).max(200)
const cadToolNameSchema = z.enum(CAD_TOOL_NAMES)
const sequenceSchema = z.number().int().nonnegative().safe()
const revisionSchema = z.number().int().positive().safe()
const timestampSchema = z
  .string()
  .min(20)
  .max(40)
  .refine((value) => Number.isFinite(Date.parse(value)), 'Invalid timestamp')

const selectionSnapshotSchema: z.ZodType<ProtocolSelectionSnapshot> =
  z.strictObject({
    count: z.number().int().nonnegative().safe(),
    units: z.string().min(1).max(100),
    revision: workspaceRevisionSchema
  })

const sheetSnapshotSchema: z.ZodType<ProtocolSheetSnapshot> = z.strictObject({
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

const submitTurnCommandSchema: z.ZodType<SubmitTurnCommand> = z
  .strictObject({
    type: z.literal('submit_turn'),
    text: z.string().min(1).max(1_000_000).optional(),
    instructionInputId: identifierSchema.optional(),
    referenceInputIds: z.array(identifierSchema).max(1_000),
    configurationRevision: revisionSchema,
    selectionSnapshot: selectionSnapshotSchema,
    sheet: sheetSnapshotSchema
  })
  .superRefine((command, context) => {
    const hasInlineText = command.text?.trim().length
    if (!hasInlineText && !command.instructionInputId) {
      context.addIssue({
        code: 'custom',
        path: ['text'],
        message: 'A turn requires inline text or an instruction input reference.'
      })
    }
    if (
      command.text !== undefined &&
      utf8ByteLength(command.text) > MAX_INLINE_TURN_TEXT_UTF8_BYTES
    ) {
      context.addIssue({
        code: 'custom',
        path: ['text'],
        message:
          `Inline turn text exceeds ${MAX_INLINE_TURN_TEXT_UTF8_BYTES} UTF-8 bytes; ` +
          'ingest it and use instructionInputId.'
      })
    }
  })

export const agentClientCommandSchema: z.ZodType<AgentClientCommand> = z.union([
  submitTurnCommandSchema,
  inputIngestionCommandSchema,
  z.strictObject({ type: z.literal('cancel_turn'), turnId: identifierSchema }),
  z.strictObject({
    type: z.literal('resume_turn'),
    turnId: identifierSchema,
    lastSequence: sequenceSchema
  }),
  z.strictObject({
    type: z.literal('operation_status'),
    turnId: identifierSchema,
    requestId: identifierSchema,
    result: operationStatusResultSchema
  }),
  z.strictObject({
    type: z.literal('tool_result'),
    turnId: identifierSchema,
    callId: identifierSchema,
    operationId: identifierSchema.optional(),
    result: toolResultV2Schema
  }),
  z.strictObject({ type: z.literal('refresh_ai_capabilities') }),
  z.strictObject({
    type: z.literal('set_ai_configuration'),
    revision: revisionSchema,
    configuration: agentConfigurationSchema
  }),
  z.strictObject({
    type: z.literal('reset_conversation'),
    revision: revisionSchema
  })
])

const toolCallSchema = z
  .strictObject({
    type: z.literal('tool_call'),
    turnId: identifierSchema,
    callId: identifierSchema,
    name: cadToolNameSchema,
    input: toolInputJsonSchema,
    operation: cadOperationRequestSchema.optional()
  })
  .superRefine((call, context) => {
    const manifest = getToolManifestEntry(call.name)
    if (
      manifest &&
      jsonUtf8ByteLength(call.input) > manifest.maximumInputBytes
    ) {
      context.addIssue({
        code: 'custom',
        path: ['input'],
        message:
          `Tool input exceeds the ${manifest.maximumInputBytes} UTF-8 byte ` +
          `limit for "${call.name}".`
      })
    }
    const requiresOperation = toolCallMayMutate(call.name, call.input)
    if (requiresOperation && !call.operation) {
      context.addIssue({
        code: 'custom',
        path: ['operation'],
        message: 'Mutating tool calls require operation metadata.'
      })
    }
    if (!requiresOperation && call.operation) {
      context.addIssue({
        code: 'custom',
        path: ['operation'],
        message: 'Read-only tool calls must not carry mutation metadata.'
      })
    }
    if (call.operation?.turnId !== undefined && call.operation.turnId !== call.turnId) {
      context.addIssue({
        code: 'custom',
        path: ['operation', 'turnId'],
        message: 'Operation turnId must match the tool call turnId.'
      })
    }
    if (call.operation?.toolName !== undefined && call.operation.toolName !== call.name) {
      context.addIssue({
        code: 'custom',
        path: ['operation', 'toolName'],
        message: 'Operation toolName must match the tool call name.'
      })
    }
  })

export const agentServerPayloadSchema: z.ZodType<AgentServerPayload> = z.union([
  turnEventSchema,
  providerServerEventSchema,
  toolCallSchema,
  z.strictObject({
    type: z.literal('get_operation_status'),
    turnId: identifierSchema,
    requestId: identifierSchema,
    operationId: identifierSchema
  }),
  z.strictObject({
    type: z.literal('input_progress'),
    inputId: identifierSchema,
    receivedBytes: z.number().int().nonnegative().safe(),
    receivedChunks: z.number().int().nonnegative().safe(),
    status: z.enum(['receiving', 'validating', 'indexing'])
  }),
  z.strictObject({
    type: z.literal('input_committed'),
    reference: inputReferenceSchema
  }),
  z.strictObject({
    type: z.literal('input_aborted'),
    inputId: identifierSchema
  }),
  z.strictObject({
    type: z.literal('protocol_error'),
    code: identifierSchema,
    message: z.string().min(1).max(4_000),
    inputId: identifierSchema.optional()
  })
])

const envelopeFields = {
  protocolVersion: z.literal(AGENT_PROTOCOL_VERSION),
  sessionId: identifierSchema,
  messageId: identifierSchema,
  turnId: identifierSchema.optional(),
  sequence: sequenceSchema,
  timestamp: timestampSchema
}

export const agentClientEnvelopeSchema: z.ZodType<AgentClientEnvelope> =
  z
    .strictObject({
      ...envelopeFields,
      payload: agentClientCommandSchema
    })
    .superRefine((envelope, context) => {
      validateEnvelopeTurnId(envelope, context)
      if (envelope.payload.type === 'submit_turn' && !envelope.turnId) {
        context.addIssue({
          code: 'custom',
          path: ['turnId'],
          message: 'submit_turn requires the renderer-assigned durable turnId.'
        })
      }
    })

export const agentServerEnvelopeSchema: z.ZodType<AgentServerEnvelope> =
  z
    .strictObject({
      ...envelopeFields,
      payload: agentServerPayloadSchema
    })
    .superRefine((envelope, context) => {
      validateEnvelopeTurnId(envelope, context)
    })

const validateEnvelopeTurnId = (
  envelope: {
    turnId?: string
    payload: AgentClientCommand | AgentServerPayload
  },
  context: z.RefinementCtx
): void => {
  const payloadTurnId =
    'turnId' in envelope.payload ? envelope.payload.turnId : undefined
  if (payloadTurnId === undefined) return
  if (envelope.turnId !== payloadTurnId) {
    context.addIssue({
      code: 'custom',
      path: ['turnId'],
      message: 'Envelope turnId must match the payload turnId.'
    })
  }
}

const parseContract = <T>(
  schema: z.ZodType<T>,
  value: unknown,
  code: string
): ContractParseResult<T> => {
  const parsed = schema.safeParse(value)
  if (parsed.success) return { ok: true, value: parsed.data }
  return {
    ok: false,
    code,
    developerMessage: parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'message'}: ${issue.message}`)
      .join('; ')
  }
}

export const parseAgentClientEnvelope = (
  value: unknown
): ContractParseResult<AgentClientEnvelope> =>
  parseContract(agentClientEnvelopeSchema, value, 'invalid-client-envelope')

export const parseAgentServerEnvelope = (
  value: unknown
): ContractParseResult<AgentServerEnvelope> =>
  parseContract(agentServerEnvelopeSchema, value, 'invalid-server-envelope')
