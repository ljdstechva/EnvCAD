import type {
  JsonValue,
  OperationResultReference
} from '../../../shared/agent-contracts'

export interface OperationResultStore {
  write(result: JsonValue): Promise<{
    reference: OperationResultReference
    resultHash: string
  }>
  read(reference: OperationResultReference): Promise<JsonValue>
}

export const hashOperationResultBytes = async (
  bytes: Uint8Array
): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    bytes as BufferSource
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export class InMemoryOperationResultStore implements OperationResultStore {
  private readonly content = new Map<string, Uint8Array>()

  async write(result: JsonValue): Promise<{
    reference: OperationResultReference
    resultHash: string
  }> {
    const json = JSON.stringify(result)
    const bytes = new TextEncoder().encode(json)
    const resultHash = await hashOperationResultBytes(bytes)
    if (bytes.byteLength <= 32_000) {
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
    this.content.set(contentId, bytes)
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
    const bytes =
      reference.kind === 'inline-json'
        ? new TextEncoder().encode(reference.json)
        : this.content.get(reference.contentId)
    if (!bytes) throw new Error('Operation replay content is unavailable.')
    if (bytes.byteLength !== reference.byteLength) {
      throw new Error('Operation replay content length does not match its receipt.')
    }
    if ((await hashOperationResultBytes(bytes)) !== reference.sha256) {
      throw new Error('Operation replay content digest does not match its receipt.')
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as JsonValue
  }
}
