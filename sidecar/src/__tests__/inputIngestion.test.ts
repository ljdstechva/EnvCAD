import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_INPUT_CHUNK_BYTES } from '../../../shared/agent-contracts'
import {
  InputStoreCapacityError,
  LocalInputStore
} from '../application/input/LocalInputStore'
import { InputRetrievalService } from '../application/input/InputRetrievalService'

const temporaryDirectories: string[] = []

async function temporaryInputRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'envcad-input-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('LocalInputStore', () => {
  it('resumes durable chunk progress and commits exact UTF-8 content', async () => {
    const root = await temporaryInputRoot()
    const inputId = 'resume-input'
    const firstBytes = Buffer.from('start-α\n', 'utf8')
    const secondBytes = Buffer.from('middle-β\nend-γ', 'utf8')
    const complete = Buffer.concat([firstBytes, secondBytes])
    const first = new LocalInputStore(root)
    await first.begin({
      type: 'input_begin',
      inputId,
      mediaType: 'text/plain',
      sourceName: 'resume.txt',
      declaredByteLength: complete.length
    })
    await first.append(chunk(inputId, 0, firstBytes))
    await first.close()

    const resumed = new LocalInputStore(root)
    await expect(
      resumed.begin({
        type: 'input_begin',
        inputId,
        mediaType: 'text/plain',
        sourceName: 'resume.txt',
        declaredByteLength: complete.length
      })
    ).resolves.toEqual({
      receivedBytes: firstBytes.length,
      receivedChunks: 1
    })
    await resumed.append(chunk(inputId, 1, secondBytes))
    const reference = await resumed.commit({
      type: 'input_commit',
      inputId,
      sha256: sha256(complete)
    })

    expect(reference).toMatchObject({
      byteLength: complete.length,
      characterLength: Array.from(complete.toString('utf8')).length,
      chunkCount: 2,
      sourceName: 'resume.txt'
    })
    const retrieval = new InputRetrievalService(resumed)
    await expect(retrieval.classificationText(inputId)).resolves.toBe(
      complete.toString('utf8')
    )
    const range = await retrieval.readRange(inputId, 0, complete.length)
    expect(range).toMatchObject({
      text: complete.toString('utf8'),
      sha256: sha256(complete)
    })
    expect(range).not.toHaveProperty('bytesBase64')
    await resumed.close()
  })

  it('returns base64 instead of lossy text for non-UTF-8 byte ranges', async () => {
    const root = await temporaryInputRoot()
    const store = new LocalInputStore(root)
    const bytes = Buffer.from([0xff, 0xfe, 0xfd, 0x00])
    await store.begin({
      type: 'input_begin',
      inputId: 'binary-range',
      mediaType: 'application/octet-stream',
      declaredByteLength: bytes.length
    })
    await store.append(chunk('binary-range', 0, bytes))
    await store.commit({
      type: 'input_commit',
      inputId: 'binary-range',
      sha256: sha256(bytes)
    })

    const range = await new InputRetrievalService(store).readRange(
      'binary-range',
      0,
      bytes.length
    )
    expect(range).toMatchObject({ bytesBase64: bytes.toString('base64') })
    expect(range).not.toHaveProperty('text')
    await store.close()
  })

  it('rejects corrupt chunks and quota exhaustion before provider execution', async () => {
    const root = await temporaryInputRoot()
    const store = new LocalInputStore(root, {
      quotaBytes: 1024,
      freeSpaceReserveBytes: 0
    })
    await expect(
      store.begin({
        type: 'input_begin',
        inputId: 'too-large',
        mediaType: 'text/plain',
        declaredByteLength: 1025
      })
    ).rejects.toBeInstanceOf(InputStoreCapacityError)

    await store.begin({
      type: 'input_begin',
      inputId: 'corrupt',
      mediaType: 'text/plain',
      declaredByteLength: 4
    })
    await expect(
      store.append({
        type: 'input_chunk',
        inputId: 'corrupt',
        chunkIndex: 0,
        bytesBase64: Buffer.from('test').toString('base64'),
        sha256: '0'.repeat(64)
      })
    ).rejects.toThrow('digest')
    await store.close()
  })

  it('deletes an explicitly cleared committed input and releases its quota', async () => {
    const root = await temporaryInputRoot()
    const store = new LocalInputStore(root, {
      quotaBytes: 8,
      freeSpaceReserveBytes: 0
    })
    const bytes = Buffer.from('12345678')
    await store.begin({
      type: 'input_begin',
      inputId: 'clear-me',
      mediaType: 'text/plain',
      declaredByteLength: bytes.length
    })
    await store.append(chunk('clear-me', 0, bytes))
    await store.commit({
      type: 'input_commit',
      inputId: 'clear-me',
      sha256: sha256(bytes)
    })

    await store.abort('clear-me')
    await expect(store.metadata('clear-me')).rejects.toThrow('not committed')
    await expect(
      store.begin({
        type: 'input_begin',
        inputId: 'replacement',
        mediaType: 'text/plain',
        declaredByteLength: bytes.length
      })
    ).resolves.toMatchObject({ receivedBytes: 0, receivedChunks: 0 })
    await store.close()
  })

  it(
    'ingests 100 MiB and retrieves exact beginning, middle, and end sentinels',
    async () => {
      const root = await temporaryInputRoot()
      const store = new LocalInputStore(root)
      const inputId = 'fixture-100-mib'
      const totalBytes = 100 * 1024 * 1024
      const chunkBytes = MAX_INPUT_CHUNK_BYTES
      const chunkCount = totalBytes / chunkBytes
      const beginning = Buffer.from('BEGIN-SENTINEL-ENV-CAD-0001')
      const middle = Buffer.from('MIDDLE-SENTINEL-ENV-CAD-5000')
      const ending = Buffer.from('END-SENTINEL-ENV-CAD-9999')
      const middleOffset = totalBytes / 2
      const endOffset = totalBytes - ending.length
      const completeHash = createHash('sha256')

      await store.begin({
        type: 'input_begin',
        inputId,
        mediaType: 'text/plain',
        sourceName: 'large-reference.txt',
        declaredByteLength: totalBytes
      })
      for (let index = 0; index < chunkCount; index += 1) {
        const bytes = Buffer.alloc(chunkBytes, 0x61)
        const absoluteStart = index * chunkBytes
        writeSentinel(bytes, absoluteStart, 0, beginning)
        writeSentinel(bytes, absoluteStart, middleOffset, middle)
        writeSentinel(bytes, absoluteStart, endOffset, ending)
        completeHash.update(bytes)
        await store.append(chunk(inputId, index, bytes))
      }
      const reference = await store.commit({
        type: 'input_commit',
        inputId,
        sha256: completeHash.digest('hex')
      })
      expect(reference).toMatchObject({
        byteLength: totalBytes,
        characterLength: totalBytes,
        chunkCount,
        sourceName: 'large-reference.txt'
      })

      const retrieval = new InputRetrievalService(store)
      await expect(
        retrieval.readRange(inputId, 0, beginning.length)
      ).resolves.toMatchObject({ text: beginning.toString('utf8') })
      await expect(
        retrieval.readRange(inputId, middleOffset, middle.length)
      ).resolves.toMatchObject({ text: middle.toString('utf8') })
      await expect(
        retrieval.readRange(inputId, endOffset, ending.length)
      ).resolves.toMatchObject({ text: ending.toString('utf8') })
      await store.close()
    },
    120_000
  )
})

function chunk(inputId: string, chunkIndex: number, bytes: Buffer) {
  return {
    type: 'input_chunk' as const,
    inputId,
    chunkIndex,
    bytesBase64: bytes.toString('base64'),
    sha256: sha256(bytes)
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function writeSentinel(
  chunkBytes: Buffer,
  chunkAbsoluteStart: number,
  sentinelAbsoluteStart: number,
  sentinel: Buffer
): void {
  const localStart = sentinelAbsoluteStart - chunkAbsoluteStart
  if (
    localStart >= 0 &&
    localStart + sentinel.length <= chunkBytes.length
  ) {
    sentinel.copy(chunkBytes, localStart)
  }
}
