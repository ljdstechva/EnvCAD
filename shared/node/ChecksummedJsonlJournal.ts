import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, stat } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'

interface JournalPayload<T> {
  version: number
  sequence: number
  value: T
}

export interface ChecksummedJournalRecord<T> {
  sequence: number
  value: T
}

export interface LoadedChecksummedJournal<T> {
  records: ChecksummedJournalRecord<T>[]
  lastSequence: number
}

export interface ChecksummedJournalOptions<T> {
  version: number
  payloadKey: string
  maximumRecordBytes: number
  parsePayload(value: unknown): T
  corruptionError(message: string): Error
}

export async function loadChecksummedJsonlJournal<T>(
  filePath: string,
  options: ChecksummedJournalOptions<T>
): Promise<LoadedChecksummedJournal<T>> {
  const size = await fileSize(filePath)
  if (size === undefined || size === 0) {
    return { records: [], lastSequence: 0 }
  }
  await assertCompleteTail(filePath, size, options)

  const records: ChecksummedJournalRecord<T>[] = []
  let expectedSequence = 1
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })
  try {
    for await (const line of lines) {
      if (Buffer.byteLength(line, 'utf8') > options.maximumRecordBytes) {
        throw options.corruptionError('a record exceeds its byte limit')
      }
      const record = parseRecord(line, options)
      if (record.sequence !== expectedSequence) {
        throw options.corruptionError(
          `expected sequence ${expectedSequence}, received ${record.sequence}`
        )
      }
      records.push(record)
      expectedSequence += 1
    }
  } finally {
    lines.close()
  }
  return { records, lastSequence: expectedSequence - 1 }
}

export async function appendChecksummedJsonlRecord<T>(
  filePath: string,
  sequence: number,
  value: T,
  options: ChecksummedJournalOptions<T>
): Promise<void> {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error('Journal sequence must be a positive safe integer.')
  }
  const payload = createPayload(options.version, sequence, options.payloadKey, value)
  const line = `${JSON.stringify({
    ...payload,
    checksum: checksum(payload)
  })}\n`
  if (Buffer.byteLength(line, 'utf8') > options.maximumRecordBytes) {
    throw new Error('Journal record exceeds its byte limit.')
  }
  await mkdir(path.dirname(filePath), { recursive: true })
  const handle = await open(filePath, 'a', 0o600)
  try {
    await handle.writeFile(line, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function parseRecord<T>(
  line: string,
  options: ChecksummedJournalOptions<T>
): ChecksummedJournalRecord<T> {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    throw options.corruptionError('a record is not valid JSON')
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'version',
      'sequence',
      options.payloadKey,
      'checksum'
    ])
  ) {
    throw options.corruptionError('a record has an invalid envelope')
  }
  if (
    value.version !== options.version ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    typeof value.checksum !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.checksum)
  ) {
    throw options.corruptionError('a record has invalid metadata')
  }
  const payload = createPayload(
    options.version,
    value.sequence as number,
    options.payloadKey,
    value[options.payloadKey]
  )
  if (checksum(payload) !== value.checksum) {
    throw options.corruptionError('a record checksum does not match')
  }
  let parsedPayload: T
  try {
    parsedPayload = options.parsePayload(value[options.payloadKey])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw options.corruptionError(`a record payload is invalid: ${message}`)
  }
  return {
    sequence: value.sequence as number,
    value: parsedPayload
  }
}

function createPayload<T>(
  version: number,
  sequence: number,
  payloadKey: string,
  value: T
): Record<string, unknown> {
  return {
    version,
    sequence,
    [payloadKey]: value
  }
}

function checksum(payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

async function fileSize(filePath: string): Promise<number | undefined> {
  try {
    return (await stat(filePath)).size
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    throw error
  }
}

async function assertCompleteTail<T>(
  filePath: string,
  size: number,
  options: ChecksummedJournalOptions<T>
): Promise<void> {
  const handle = await open(filePath, 'r')
  try {
    const tail = Buffer.alloc(1)
    await handle.read(tail, 0, 1, size - 1)
    if (tail[0] !== 0x0a) {
      throw options.corruptionError('the final record is incomplete')
    }
  } finally {
    await handle.close()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  const expected = new Set(keys)
  return (
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key))
  )
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
