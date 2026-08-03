import { createHash, randomBytes } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink
} from 'node:fs/promises'
import path from 'node:path'
import {
  MAX_OPERATION_RESULT_BYTES,
  operationResultJsonSchema,
  type JsonValue,
  type OperationResultReference
} from '../../shared/agent-contracts'

const INLINE_RESULT_BYTES = 32_000
const CONTENT_ID = /^operation-result-([a-f0-9]{64})$/

export class PersistentOperationResultStore {
  private readonly rootDirectory: string

  constructor(rootDirectory: string) {
    this.rootDirectory = path.resolve(rootDirectory)
  }

  async write(result: JsonValue): Promise<{
    reference: OperationResultReference
    resultHash: string
  }> {
    if (!operationResultJsonSchema.safeParse(result).success) {
      throw new Error('Operation result is not valid bounded JSON.')
    }
    const json = JSON.stringify(result)
    const bytes = Buffer.from(json, 'utf8')
    if (bytes.byteLength > MAX_OPERATION_RESULT_BYTES) {
      throw new Error('Operation result exceeds the durable byte limit.')
    }
    const resultHash = sha256(bytes)
    if (bytes.byteLength <= INLINE_RESULT_BYTES) {
      return {
        reference: {
          kind: 'inline-json',
          sha256: resultHash,
          byteLength: bytes.byteLength,
          json
        },
        resultHash
      }
    }
    const contentId = `operation-result-${resultHash}`
    await this.writeContent(contentId, bytes)
    return {
      reference: {
        kind: 'content-store',
        sha256: resultHash,
        byteLength: bytes.byteLength,
        contentId
      },
      resultHash
    }
  }

  async read(reference: OperationResultReference): Promise<JsonValue> {
    if (reference.byteLength > MAX_OPERATION_RESULT_BYTES) {
      throw new Error('Operation replay content exceeds the durable byte limit.')
    }
    let bytes: Buffer
    if (reference.kind === 'inline-json') {
      bytes = Buffer.from(reference.json, 'utf8')
    } else {
      const contentPath = this.contentPath(reference.contentId)
      const metadata = await stat(contentPath)
      if (
        !metadata.isFile() ||
        metadata.size > MAX_OPERATION_RESULT_BYTES ||
        metadata.size !== reference.byteLength
      ) {
        throw new Error('Operation replay content size does not match its receipt.')
      }
      bytes = await readFile(contentPath)
    }
    if (
      bytes.byteLength !== reference.byteLength ||
      sha256(bytes) !== reference.sha256
    ) {
      throw new Error('Operation replay content does not match its receipt.')
    }
    let result: unknown
    try {
      result = JSON.parse(bytes.toString('utf8'))
    } catch {
      throw new Error('Operation replay content is not valid JSON.')
    }
    const parsed = operationResultJsonSchema.safeParse(result)
    if (!parsed.success) {
      throw new Error('Operation replay content violates its JSON contract.')
    }
    return parsed.data
  }

  private async writeContent(contentId: string, bytes: Buffer): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true })
    const target = this.contentPath(contentId)
    const priorContent = await readExistingContent(target, bytes.byteLength)
    if (priorContent) {
      if (!priorContent.equals(bytes)) {
        throw new Error('Operation result digest collision or store corruption.')
      }
      return
    }
    const temporary = path.join(
      this.rootDirectory,
      `.${contentId}.${randomBytes(8).toString('hex')}.tmp`
    )
    const handle = await open(temporary, 'wx', 0o600)
    let writeError: unknown
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } catch (error) {
      writeError = error
    } finally {
      try {
        await handle.close()
      } catch (error) {
        writeError ??= error
      }
    }
    if (writeError) {
      await unlink(temporary).catch(() => undefined)
      throw writeError
    }
    try {
      await rename(temporary, target)
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      const existing = await readExistingContent(target, bytes.byteLength)
      if (!existing?.equals(bytes)) throw error
    }
  }

  private contentPath(contentId: string): string {
    if (!CONTENT_ID.test(contentId)) {
      throw new Error('Invalid operation result content id.')
    }
    return path.join(this.rootDirectory, `${contentId}.json`)
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readExistingContent(
  filePath: string,
  expectedBytes: number
): Promise<Buffer | undefined> {
  try {
    const metadata = await stat(filePath)
    if (
      !metadata.isFile() ||
      metadata.size > MAX_OPERATION_RESULT_BYTES ||
      metadata.size !== expectedBytes
    ) {
      throw new Error('Operation result store contains invalid existing content.')
    }
    return readFile(filePath)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}
