import { z } from 'zod'
import { structuredFailureSchema } from './failures'

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export const utf8ByteLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength

export const jsonUtf8ByteLength = (value: JsonValue): number =>
  utf8ByteLength(JSON.stringify(value))

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
)

const boundedJsonSchema = (maximumBytes: number) =>
  jsonValueSchema.refine(
    (value) => jsonUtf8ByteLength(value) <= maximumBytes,
    `JSON value exceeds ${maximumBytes} UTF-8 bytes`
  )

export const toolInputJsonSchema = boundedJsonSchema(64_000)

export const toolImagePayloadSchema = z.strictObject({
  mimeType: z.enum(['image/png', 'image/webp']),
  base64: z.string().max(1_600_000).regex(/^[A-Za-z0-9+/]*={0,2}$/),
  byteLength: z.number().int().positive().max(1_179_648),
  width: z.number().int().positive().max(4_096),
  height: z.number().int().positive().max(4_096),
  aspectRatio: z.number().positive().finite(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  captureId: z.string().min(1).max(200),
  renderRevision: z.number().int().positive().safe()
})

export type ToolImagePayload = z.infer<typeof toolImagePayloadSchema>

export const toolSuccessResultSchema = z.strictObject({
  ok: z.literal(true),
  data: boundedJsonSchema(64_000),
  image: toolImagePayloadSchema.optional()
})

export const toolFailureResultSchema = z.strictObject({
  ok: z.literal(false),
  failure: structuredFailureSchema
})

export const toolResultV2Schema = z.discriminatedUnion('ok', [
  toolSuccessResultSchema,
  toolFailureResultSchema
])

export type ToolResultV2 = z.infer<typeof toolResultV2Schema>
