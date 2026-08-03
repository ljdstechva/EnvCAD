import type { WorkspaceRevision } from './workspace-revision'
import type { StructuredFailure } from './failures'
import { z } from 'zod'
import { structuredFailureSchema } from './failures'
import { jsonValueSchema, type JsonValue } from './tool-result'
import { workspaceRevisionSchema } from './workspace-revision'

export type OperationStatus =
  | 'pending'
  | 'committed'
  | 'rolled-back'
  | 'cancelled'
  | 'unknown'

export interface CadOperationRequest {
  turnId: string
  operationId: string
  operationGroupId: string
  idempotencyKey: string
  toolName: string
  argumentsHash: string
  expectedRevision: WorkspaceRevision
  deadline: string
}

export interface OperationReceipt {
  operationId: string
  operationGroupId: string
  idempotencyKey: string
  toolName: string
  argumentsHash: string
  status: OperationStatus
  revisionBefore: WorkspaceRevision
  revisionAfter?: WorkspaceRevision
  affectedEntityIds: string[]
  resultHash?: string
  resultReference?: OperationResultReference
  reconciliationFingerprint?: string
  committedAt?: string
  failureCode?: string
  failure?: StructuredFailure
}

export type OperationResultReference =
  | {
      kind: 'inline-json'
      sha256: string
      byteLength: number
      json: string
    }
  | {
      kind: 'content-store'
      sha256: string
      byteLength: number
      contentId: string
    }

export interface OperationCommit<T> {
  result: T
  revisionBefore: WorkspaceRevision
  revisionAfter: WorkspaceRevision
  affectedEntityIds: string[]
  resultHash?: string
  reconciliationFingerprint: string
}

export interface OperationExecution<T> {
  receipt: OperationReceipt
  result?: T
  duplicate: boolean
}

export interface OperationStatusResult {
  operationId: string
  receipt?: OperationReceipt
}

export const canonicalOperationJson = (value: JsonValue): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(canonicalOperationJson).join(',')}]`
  }
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0
  )
  return `{${entries
    .map(
      ([key, child]) =>
        `${JSON.stringify(key)}:${canonicalOperationJson(child)}`
    )
    .join(',')}}`
}

export const operationArgumentsPreimage = (
  toolName: string,
  input: JsonValue
): string => `${toolName}\n${canonicalOperationJson(input)}`

const identifierSchema = z.string().min(1).max(200)
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
export const MAX_OPERATION_RECEIPT_BYTES = 1_500_000
export const MAX_OPERATION_RESULT_BYTES = 2_000_000
const timestampSchema = z
  .string()
  .min(20)
  .max(40)
  .refine((value) => Number.isFinite(Date.parse(value)), 'Invalid timestamp')

export const cadOperationRequestSchema: z.ZodType<CadOperationRequest> =
  z.strictObject({
    turnId: identifierSchema,
    operationId: identifierSchema,
    operationGroupId: identifierSchema,
    idempotencyKey: identifierSchema,
    toolName: identifierSchema,
    argumentsHash: sha256Schema,
    expectedRevision: workspaceRevisionSchema,
    deadline: timestampSchema
  })

export const operationResultReferenceSchema: z.ZodType<OperationResultReference> =
  z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('inline-json'),
      sha256: sha256Schema,
      byteLength: z.number().int().nonnegative().max(32_000),
      json: z.string().max(32_000)
    }),
    z.strictObject({
      kind: z.literal('content-store'),
      sha256: sha256Schema,
      byteLength: z.number().int().nonnegative().max(MAX_OPERATION_RESULT_BYTES),
      contentId: identifierSchema
    })
  ])

export const operationResultJsonSchema: z.ZodType<JsonValue> =
  jsonValueSchema.refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <=
      MAX_OPERATION_RESULT_BYTES,
    `Operation result exceeds ${MAX_OPERATION_RESULT_BYTES} UTF-8 bytes`
  )

export const operationReceiptSchema: z.ZodType<OperationReceipt> =
  z.strictObject({
    operationId: identifierSchema,
    operationGroupId: identifierSchema,
    idempotencyKey: identifierSchema,
    toolName: identifierSchema,
    argumentsHash: sha256Schema,
    status: z.enum([
      'pending',
      'committed',
      'rolled-back',
      'cancelled',
      'unknown'
    ]),
    revisionBefore: workspaceRevisionSchema,
    revisionAfter: workspaceRevisionSchema.optional(),
    affectedEntityIds: z.array(identifierSchema).max(1_000),
    resultHash: sha256Schema.optional(),
    resultReference: operationResultReferenceSchema.optional(),
    reconciliationFingerprint: sha256Schema.optional(),
    committedAt: timestampSchema.optional(),
    failureCode: identifierSchema.optional(),
    failure: structuredFailureSchema.optional()
  })
    .superRefine((receipt, context) => {
      if (
        new TextEncoder().encode(JSON.stringify(receipt)).byteLength >
        MAX_OPERATION_RECEIPT_BYTES
      ) {
        context.addIssue({
          code: 'custom',
          path: [],
          message: 'Operation receipt exceeds its durable byte limit.'
        })
      }
      if (receipt.status === 'committed' && !receipt.revisionAfter) {
        context.addIssue({
          code: 'custom',
          path: ['revisionAfter'],
          message: 'Committed operations require revisionAfter.'
        })
      }
      if (receipt.status === 'committed' && !receipt.committedAt) {
        context.addIssue({
          code: 'custom',
          path: ['committedAt'],
          message: 'Committed operations require committedAt.'
        })
      }
      if (
        receipt.status === 'committed' &&
        (!receipt.resultHash ||
          !receipt.resultReference ||
          !receipt.reconciliationFingerprint)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['resultReference'],
          message:
            'Committed operations require a result hash, replay reference, and reconciliation fingerprint.'
        })
      }
      if (
        receipt.resultHash &&
        receipt.resultReference &&
        receipt.resultHash !== receipt.resultReference.sha256
      ) {
        context.addIssue({
          code: 'custom',
          path: ['resultHash'],
          message: 'resultHash must match the replay reference digest.'
        })
      }
      if (
        receipt.status !== 'committed' &&
        (receipt.committedAt || receipt.resultHash || receipt.resultReference)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['status'],
          message: 'Only committed operations may contain committed result fields.'
        })
      }
      if (receipt.resultReference?.kind === 'inline-json') {
        const bytes = new TextEncoder().encode(receipt.resultReference.json)
        if (bytes.byteLength !== receipt.resultReference.byteLength) {
          context.addIssue({
            code: 'custom',
            path: ['resultReference', 'byteLength'],
            message: 'Inline result byteLength does not match its JSON bytes.'
          })
        }
        try {
          JSON.parse(receipt.resultReference.json)
        } catch {
          context.addIssue({
            code: 'custom',
            path: ['resultReference', 'json'],
            message: 'Inline operation result is not valid JSON.'
          })
        }
      }
    })

export const operationStatusResultSchema: z.ZodType<OperationStatusResult> =
  z.strictObject({
    operationId: identifierSchema,
    receipt: operationReceiptSchema.optional()
  })

export const verifyOperationResultReference = async (
  reference: OperationResultReference,
  resolveContent?: (contentId: string) => Promise<Uint8Array | undefined>
): Promise<boolean> => {
  const bytes =
    reference.kind === 'inline-json'
      ? new TextEncoder().encode(reference.json)
      : await resolveContent?.(reference.contentId)
  if (!bytes) return false
  if (bytes.byteLength !== reference.byteLength) return false
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    Uint8Array.from(bytes).buffer
  )
  const actual = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return actual === reference.sha256
}
