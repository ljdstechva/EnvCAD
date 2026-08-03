import { createHash } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import {
  inputChunkReferenceSchema,
  inputReferenceSchema,
  type InputChunkReference,
  type InputReference
} from '../../../../shared/agent-contracts'

export interface StoredInputArtifact {
  reference: InputReference
  chunks: InputChunkReference[]
  textEncoding?: 'utf-8'
  classificationText?: string
  committedAt: string
}

export interface StagedInputArtifact {
  inputId: string
  mediaType: string
  sourceName?: string
  declaredByteLength?: number
  receivedBytes: number
  chunks: InputChunkReference[]
  textEncoding?: 'utf-8'
  characterLength?: number
  classificationText?: string
}

export const MAX_INPUT_CLASSIFICATION_CHARACTERS = 32_768

const stagedInputArtifactSchema: z.ZodType<StagedInputArtifact> =
  z
    .strictObject({
      inputId: z.string().min(1).max(200),
      mediaType: z.string().min(3).max(200),
      sourceName: z.string().min(1).max(1_000).optional(),
      declaredByteLength: z.number().int().nonnegative().optional(),
      receivedBytes: z.number().int().nonnegative(),
      chunks: z.array(inputChunkReferenceSchema),
      textEncoding: z.literal('utf-8').optional(),
      characterLength: z.number().int().nonnegative().optional(),
      classificationText: z
        .string()
        .max(MAX_INPUT_CLASSIFICATION_CHARACTERS)
        .optional()
    })
    .superRefine((artifact, context) => {
      let byteCursor = 0
      for (const [index, chunk] of artifact.chunks.entries()) {
        if (
          chunk.inputId !== artifact.inputId ||
          chunk.chunkIndex !== index ||
          chunk.byteStart !== byteCursor
        ) {
          context.addIssue({
            code: 'custom',
            path: ['chunks', index],
            message: 'Staged chunks are not contiguous or correctly identified.'
          })
        }
        byteCursor = chunk.byteEnd
      }
      if (byteCursor !== artifact.receivedBytes) {
        context.addIssue({
          code: 'custom',
          path: ['receivedBytes'],
          message: 'Staged chunk ranges do not match receivedBytes.'
        })
      }
    })

const storedInputArtifactSchema: z.ZodType<StoredInputArtifact> =
  z
    .strictObject({
      reference: inputReferenceSchema,
      chunks: z.array(inputChunkReferenceSchema),
      textEncoding: z.literal('utf-8').optional(),
      classificationText: z
        .string()
        .max(MAX_INPUT_CLASSIFICATION_CHARACTERS)
        .optional(),
      committedAt: z.string().datetime()
    })
    .superRefine((artifact, context) => {
      if (artifact.chunks.length !== artifact.reference.chunkCount) {
        context.addIssue({
          code: 'custom',
          path: ['chunks'],
          message: 'Stored chunk count does not match the input reference.'
        })
      }
      let byteCursor = 0
      for (const [index, chunk] of artifact.chunks.entries()) {
        if (
          chunk.inputId !== artifact.reference.inputId ||
          chunk.chunkIndex !== index ||
          chunk.byteStart !== byteCursor
        ) {
          context.addIssue({
            code: 'custom',
            path: ['chunks', index],
            message: 'Stored chunks are not contiguous or correctly identified.'
          })
        }
        byteCursor = chunk.byteEnd
      }
      if (byteCursor !== artifact.reference.byteLength) {
        context.addIssue({
          code: 'custom',
          path: ['chunks'],
          message: 'Stored chunks do not cover the complete input.'
        })
      }
    })

export function inputArtifactKey(inputId: string): string {
  return createHash('sha256').update(inputId, 'utf8').digest('hex')
}

export function inputArtifactPaths(root: string, inputId: string) {
  const key = inputArtifactKey(inputId)
  const stagedDirectory = path.join(root, 'staging', key)
  const committedDirectory = path.join(root, 'committed', key)
  return {
    stagedDirectory,
    stagedData: path.join(stagedDirectory, 'content.bin'),
    stagedState: path.join(stagedDirectory, 'state.json'),
    stagedMetadata: path.join(stagedDirectory, 'metadata.json'),
    committedDirectory,
    committedData: path.join(committedDirectory, 'content.bin'),
    committedMetadata: path.join(committedDirectory, 'metadata.json')
  }
}

export function parseStagedInputArtifact(value: unknown): StagedInputArtifact {
  return stagedInputArtifactSchema.parse(value)
}

export function parseStoredInputArtifact(value: unknown): StoredInputArtifact {
  return storedInputArtifactSchema.parse(value)
}

export function isTextMediaType(mediaType: string): boolean {
  return (
    mediaType.startsWith('text/') ||
    /\/(?:json|xml|csv|yaml|x-yaml)$/i.test(mediaType)
  )
}
