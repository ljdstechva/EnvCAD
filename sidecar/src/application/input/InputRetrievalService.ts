import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import {
  MAX_INPUT_CHUNK_BYTES,
  type InputChunkReference,
  type InputReference
} from '../../../../shared/agent-contracts'
import { LocalInputStore } from './LocalInputStore'
import {
  inputArtifactPaths,
  type StoredInputArtifact
} from './InputStoreMetadata'

export const MAX_INPUT_RANGE_BYTES = 64 * 1024
const SEARCH_BLOCK_BYTES = 256 * 1024
const SEARCH_PREVIEW_RADIUS_BYTES = 96

export interface InputByteRange {
  inputId: string
  byteStart: number
  byteEnd: number
  sha256: string
  bytesBase64?: string
  text?: string
}

export interface InputSearchMatch {
  byteStart: number
  byteEnd: number
  previewByteStart: number
  previewByteEnd: number
  preview: string
}

export class InputRetrievalService {
  private readonly verified = new Map<string, string>()

  constructor(private readonly store: LocalInputStore) {}

  async metadata(inputId: string): Promise<InputReference> {
    const artifact = await this.verifiedArtifact(inputId)
    return { ...artifact.reference }
  }

  async classificationText(inputId: string): Promise<string | undefined> {
    const artifact = await this.store.metadata(inputId)
    return artifact.classificationText
  }

  async outline(inputId: string): Promise<{
    reference: InputReference
    textEncoding?: 'utf-8'
    chunkRanges: InputChunkReference[]
    chunkRangesTruncated: boolean
  }> {
    const artifact = await this.verifiedArtifact(inputId)
    const chunks =
      artifact.chunks.length <= 12
        ? artifact.chunks
        : [...artifact.chunks.slice(0, 6), ...artifact.chunks.slice(-6)]
    return {
      reference: { ...artifact.reference },
      ...(artifact.textEncoding
        ? { textEncoding: artifact.textEncoding }
        : {}),
      chunkRanges: chunks.map((chunk) => ({ ...chunk })),
      chunkRangesTruncated: chunks.length !== artifact.chunks.length
    }
  }

  async readChunk(
    inputId: string,
    chunkIndex: number
  ): Promise<InputByteRange> {
    const artifact = await this.verifiedArtifact(inputId)
    const chunk = artifact.chunks[chunkIndex]
    if (!chunk) {
      throw new InputRetrievalRequestError(
        `Input "${inputId}" has no chunk at index ${chunkIndex}.`
      )
    }
    if (chunk.byteEnd - chunk.byteStart > MAX_INPUT_RANGE_BYTES) {
      throw new InputRetrievalRequestError(
        `Input chunk ${chunkIndex} exceeds the bounded retrieval envelope; read it with adjacent read_input_range calls.`
      )
    }
    const range = await this.readRange(
      inputId,
      chunk.byteStart,
      chunk.byteEnd - chunk.byteStart
    )
    if (range.sha256 !== chunk.sha256) {
      this.verified.delete(inputId)
      throw new Error('Stored input chunk failed its integrity check.')
    }
    return range
  }

  async readRange(
    inputId: string,
    byteStart: number,
    byteLength: number
  ): Promise<InputByteRange> {
    const artifact = await this.verifiedArtifact(inputId)
    if (
      !Number.isSafeInteger(byteStart) ||
      byteStart < 0 ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 1 ||
      byteLength > MAX_INPUT_RANGE_BYTES ||
      byteStart + byteLength > artifact.reference.byteLength
    ) {
      throw new InputRetrievalRequestError(
        `Input byte range must be within the artifact and at most ${MAX_INPUT_RANGE_BYTES} bytes.`
      )
    }
    const paths = inputArtifactPaths(this.store.rootDirectory, inputId)
    const handle = await open(paths.committedData, 'r')
    try {
      const bytes = Buffer.allocUnsafe(byteLength)
      const read = await handle.read(bytes, 0, byteLength, byteStart)
      if (read.bytesRead !== byteLength) {
        throw new Error('Stored input ended before the requested byte range.')
      }
      const digest = createHash('sha256').update(bytes).digest('hex')
      const text = artifact.textEncoding ? decodeUtf8(bytes) : undefined
      return {
        inputId,
        byteStart,
        byteEnd: byteStart + byteLength,
        sha256: digest,
        ...(text !== undefined
          ? { text }
          : { bytesBase64: bytes.toString('base64') })
      }
    } finally {
      await handle.close()
    }
  }

  async search(
    inputId: string,
    query: string,
    limit = 10
  ): Promise<{ query: string; matches: InputSearchMatch[]; truncated: boolean }> {
    if (!query || Buffer.byteLength(query, 'utf8') > 4_096) {
      throw new InputRetrievalRequestError(
        'Input search query must contain 1 through 4,096 UTF-8 bytes.'
      )
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new InputRetrievalRequestError(
        'Input search limit must be from 1 through 20.'
      )
    }
    const artifact = await this.verifiedArtifact(inputId)
    const needle = Buffer.from(query, 'utf8')
    const paths = inputArtifactPaths(this.store.rootDirectory, inputId)
    const matches: Array<{ byteStart: number; byteEnd: number }> = []
    let carry = Buffer.alloc(0)
    let offset = 0
    for await (const value of createReadStream(paths.committedData, {
      highWaterMark: SEARCH_BLOCK_BYTES
    })) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
      const combined = Buffer.concat([carry, bytes])
      const combinedStart = offset - carry.length
      let cursor = 0
      while (matches.length <= limit) {
        const found = combined.indexOf(needle, cursor)
        if (found < 0) break
        const byteStart = combinedStart + found
        if (matches.at(-1)?.byteStart !== byteStart) {
          matches.push({ byteStart, byteEnd: byteStart + needle.length })
        }
        cursor = found + Math.max(1, needle.length)
      }
      if (matches.length > limit) break
      const carryLength = Math.min(
        combined.length,
        Math.max(0, needle.length - 1)
      )
      carry = combined.subarray(combined.length - carryLength)
      offset += bytes.length
    }
    const truncated = matches.length > limit
    const bounded = matches.slice(0, limit)
    return {
      query,
      matches: await Promise.all(
        bounded.map(async (match) => {
          const previewByteStart = Math.max(
            0,
            match.byteStart - SEARCH_PREVIEW_RADIUS_BYTES
          )
          const previewByteEnd = Math.min(
            artifact.reference.byteLength,
            match.byteEnd + SEARCH_PREVIEW_RADIUS_BYTES
          )
          const preview = await this.readRawRange(
            inputId,
            previewByteStart,
            previewByteEnd - previewByteStart
          )
          return {
            ...match,
            previewByteStart,
            previewByteEnd,
            preview: new TextDecoder('utf-8').decode(preview)
          }
        })
      ),
      truncated
    }
  }

  private async verifiedArtifact(
    inputId: string
  ): Promise<StoredInputArtifact> {
    const artifact = await this.store.metadata(inputId)
    const paths = inputArtifactPaths(this.store.rootDirectory, inputId)
    const file = await stat(paths.committedData)
    const evidence = `${file.size}:${file.mtimeMs}:${artifact.reference.sha256}`
    if (
      file.size !== artifact.reference.byteLength ||
      this.verified.get(inputId) !== evidence
    ) {
      const digest = createHash('sha256')
      for await (const value of createReadStream(paths.committedData)) {
        digest.update(value)
      }
      if (digest.digest('hex') !== artifact.reference.sha256) {
        throw new Error('Stored input failed its complete integrity check.')
      }
      this.verified.set(inputId, evidence)
    }
    return artifact
  }

  private async readRawRange(
    inputId: string,
    byteStart: number,
    byteLength: number
  ): Promise<Buffer> {
    const paths = inputArtifactPaths(this.store.rootDirectory, inputId)
    const handle = await open(paths.committedData, 'r')
    try {
      const bytes = Buffer.allocUnsafe(byteLength)
      const read = await handle.read(bytes, 0, byteLength, byteStart)
      if (read.bytesRead !== byteLength) {
        throw new Error('Stored input preview was incomplete.')
      }
      return bytes
    } finally {
      await handle.close()
    }
  }
}

export class InputRetrievalRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InputRetrievalRequestError'
  }
}

function decodeUtf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}
