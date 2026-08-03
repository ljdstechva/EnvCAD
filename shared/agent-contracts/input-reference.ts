import { z } from 'zod'

export const MAX_INPUT_ARTIFACT_BYTES = 256 * 1024 * 1024
export const MAX_INPUT_CHUNK_BYTES = 256 * 1024
export const MAX_INPUT_CHUNKS = 4_096
export const MAX_INPUT_CHUNK_BASE64_CHARACTERS =
  Math.ceil(MAX_INPUT_CHUNK_BYTES / 3) * 4

export interface InputReference {
  inputId: string
  sha256: string
  mediaType: string
  byteLength: number
  characterLength?: number
  chunkCount: number
  sourceName?: string
}

export interface InputChunkReference {
  inputId: string
  chunkIndex: number
  byteStart: number
  byteEnd: number
  characterStart?: number
  characterEnd?: number
  sha256: string
}

export type InputIngestionCommand =
  | {
      type: 'input_begin'
      inputId: string
      mediaType: string
      sourceName?: string
      declaredByteLength?: number
    }
  | {
      type: 'input_chunk'
      inputId: string
      chunkIndex: number
      bytesBase64: string
      sha256: string
    }
  | { type: 'input_commit'; inputId: string; sha256: string }
  | { type: 'input_abort'; inputId: string }

const identifierSchema = z.string().min(1).max(200)
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const mediaTypeSchema = z
  .string()
  .min(3)
  .max(200)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/,
    'Invalid media type'
  )
const canonicalBase64Schema = z
  .string()
  .min(4)
  .max(MAX_INPUT_CHUNK_BASE64_CHARACTERS)
  .regex(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
    'Chunk data must be canonical base64'
  )
  .refine(
    (value) => decodedBase64ByteLength(value) <= MAX_INPUT_CHUNK_BYTES,
    `Decoded chunk exceeds ${MAX_INPUT_CHUNK_BYTES} bytes`
  )

export const inputReferenceSchema: z.ZodType<InputReference> = z
  .strictObject({
    inputId: identifierSchema,
    sha256: sha256Schema,
    mediaType: mediaTypeSchema,
    byteLength: z.number().int().nonnegative().max(MAX_INPUT_ARTIFACT_BYTES),
    characterLength: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_INPUT_ARTIFACT_BYTES)
      .optional(),
    chunkCount: z.number().int().nonnegative().max(MAX_INPUT_CHUNKS),
    sourceName: z.string().min(1).max(1_000).optional()
  })
  .superRefine((reference, context) => {
    if (
      reference.characterLength !== undefined &&
      reference.characterLength > reference.byteLength
    ) {
      context.addIssue({
        code: 'custom',
        path: ['characterLength'],
        message: 'characterLength cannot exceed byteLength.'
      })
    }
    if (
      (reference.byteLength === 0 && reference.chunkCount !== 0) ||
      (reference.byteLength > 0 && reference.chunkCount === 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['chunkCount'],
        message: 'chunkCount must agree with whether the input is empty.'
      })
    }
    if (
      reference.byteLength >
      reference.chunkCount * MAX_INPUT_CHUNK_BYTES
    ) {
      context.addIssue({
        code: 'custom',
        path: ['chunkCount'],
        message: 'chunkCount cannot contain the declared byteLength.'
      })
    }
  })

export const inputChunkReferenceSchema: z.ZodType<InputChunkReference> =
  z
    .strictObject({
      inputId: identifierSchema,
      chunkIndex: z.number().int().nonnegative().max(MAX_INPUT_CHUNKS - 1),
      byteStart: z.number().int().nonnegative().max(MAX_INPUT_ARTIFACT_BYTES),
      byteEnd: z.number().int().nonnegative().max(MAX_INPUT_ARTIFACT_BYTES),
      characterStart: z
        .number()
        .int()
        .nonnegative()
        .max(MAX_INPUT_ARTIFACT_BYTES)
        .optional(),
      characterEnd: z
        .number()
        .int()
        .nonnegative()
        .max(MAX_INPUT_ARTIFACT_BYTES)
        .optional(),
      sha256: sha256Schema
    })
    .superRefine((chunk, context) => {
      if (chunk.byteEnd <= chunk.byteStart) {
        context.addIssue({
          code: 'custom',
          path: ['byteEnd'],
          message: 'byteEnd must be greater than byteStart.'
        })
      }
      const characterOffsets = [
        chunk.characterStart !== undefined,
        chunk.characterEnd !== undefined
      ]
      if (characterOffsets.some(Boolean) && !characterOffsets.every(Boolean)) {
        context.addIssue({
          code: 'custom',
          path: ['characterStart'],
          message: 'Character offsets must be present as a pair.'
        })
      }
      if (
        chunk.characterStart !== undefined &&
        chunk.characterEnd !== undefined &&
        chunk.characterEnd < chunk.characterStart
      ) {
        context.addIssue({
          code: 'custom',
          path: ['characterEnd'],
          message: 'characterEnd cannot precede characterStart.'
        })
      }
    })

export const inputIngestionCommandSchema: z.ZodType<InputIngestionCommand> =
  z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('input_begin'),
      inputId: identifierSchema,
      mediaType: mediaTypeSchema,
      sourceName: z.string().min(1).max(1_000).optional(),
      declaredByteLength: z
        .number()
        .int()
        .nonnegative()
        .max(MAX_INPUT_ARTIFACT_BYTES)
        .optional()
    }),
    z.strictObject({
      type: z.literal('input_chunk'),
      inputId: identifierSchema,
      chunkIndex: z.number().int().nonnegative().max(MAX_INPUT_CHUNKS - 1),
      bytesBase64: canonicalBase64Schema,
      sha256: sha256Schema
    }),
    z.strictObject({
      type: z.literal('input_commit'),
      inputId: identifierSchema,
      sha256: sha256Schema
    }),
    z.strictObject({
      type: z.literal('input_abort'),
      inputId: identifierSchema
    })
  ])

function decodedBase64ByteLength(value: string): number {
  const padding =
    value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}
