import {
  MAX_INPUT_ARTIFACT_BYTES,
  type AgentClientEnvelope,
  type AgentServerPayload,
  type InputIngestionCommand,
  type InputReference
} from '../../../shared/agent-contracts'

const RENDERER_INPUT_CHUNK_BYTES = 192 * 1024
const INPUT_RESPONSE_TIMEOUT_MS = 30_000

export interface InputIngestionProgress {
  inputId: string
  receivedBytes: number
  totalBytes: number
  receivedChunks: number
  status: 'receiving' | 'validating' | 'indexing'
}

export interface InputIngestionClientOptions {
  command(payload: InputIngestionCommand): AgentClientEnvelope
  send(envelope: AgentClientEnvelope): boolean
  onProgress?(progress: InputIngestionProgress): void
  responseTimeoutMs?: number
}

interface PendingResponse {
  accept(payload: AgentServerPayload): boolean
  resolve(payload: AgentServerPayload): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export class InputIngestionClient {
  private readonly pending = new Map<string, PendingResponse>()

  constructor(private readonly options: InputIngestionClientOptions) {}

  async ingestText(
    text: string,
    sourceName = 'composer-instruction.txt'
  ): Promise<InputReference> {
    const bytes = new TextEncoder().encode(text)
    if (bytes.byteLength > MAX_INPUT_ARTIFACT_BYTES) {
      throw new Error(
        `This input exceeds the ${MAX_INPUT_ARTIFACT_BYTES.toLocaleString()}-byte local artifact limit.`
      )
    }
    const completeSha256 = await sha256(bytes)
    const inputId = `input-${completeSha256}`
    const begin = await this.exchange(
      inputId,
      {
        type: 'input_begin',
        inputId,
        mediaType: 'text/plain',
        sourceName,
        declaredByteLength: bytes.byteLength
      },
      (payload) =>
        payload.type === 'input_committed' ||
        (payload.type === 'input_progress' &&
          payload.status === 'receiving')
    )
    if (begin.type === 'input_committed') return begin.reference
    if (begin.type !== 'input_progress') {
      throw new Error('The local input store returned an invalid begin response.')
    }
    this.reportProgress(begin, bytes.byteLength)
    let chunkIndex = begin.receivedChunks
    let byteOffset = begin.receivedBytes
    if (
      byteOffset !==
      Math.min(chunkIndex * RENDERER_INPUT_CHUNK_BYTES, bytes.byteLength)
    ) {
      throw new Error(
        'The durable input cursor does not match the renderer chunk boundary.'
      )
    }
    while (byteOffset < bytes.byteLength) {
      const chunkBytes = bytes.subarray(
        byteOffset,
        byteOffset + RENDERER_INPUT_CHUNK_BYTES
      )
      const expectedChunks = chunkIndex + 1
      const progress = await this.exchange(
        inputId,
        {
          type: 'input_chunk',
          inputId,
          chunkIndex,
          bytesBase64: bytesToBase64(chunkBytes),
          sha256: await sha256(chunkBytes)
        },
        (payload) =>
          payload.type === 'input_progress' &&
          payload.status === 'receiving' &&
          payload.receivedChunks >= expectedChunks
      )
      if (progress.type !== 'input_progress') {
        throw new Error('The local input store returned an invalid chunk response.')
      }
      byteOffset = progress.receivedBytes
      chunkIndex = progress.receivedChunks
      this.reportProgress(progress, bytes.byteLength)
    }
    const committed = await this.exchange(
      inputId,
      { type: 'input_commit', inputId, sha256: completeSha256 },
      (payload) => payload.type === 'input_committed'
    )
    if (committed.type !== 'input_committed') {
      throw new Error('The local input store did not commit the artifact.')
    }
    return committed.reference
  }

  receive(payload: AgentServerPayload): boolean {
    const inputId =
      payload.type === 'input_committed'
        ? payload.reference.inputId
        : 'inputId' in payload
          ? payload.inputId
          : undefined
    if (!inputId) return false
    const pending = this.pending.get(inputId)
    if (!pending) return false
    if (payload.type === 'protocol_error') {
      clearTimeout(pending.timer)
      this.pending.delete(inputId)
      pending.reject(new Error(payload.message))
      return true
    }
    if (payload.type === 'input_aborted') {
      clearTimeout(pending.timer)
      this.pending.delete(inputId)
      pending.reject(new Error('The local input ingestion was aborted.'))
      return true
    }
    if (!pending.accept(payload)) return true
    clearTimeout(pending.timer)
    this.pending.delete(inputId)
    pending.resolve(payload)
    return true
  }

  failPending(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(message))
    }
    this.pending.clear()
  }

  async delete(inputId: string): Promise<void> {
    const response = await this.exchange(
      inputId,
      { type: 'input_abort', inputId },
      (payload) => payload.type === 'input_aborted'
    )
    if (response.type !== 'input_aborted') {
      throw new Error('The local input store did not confirm deletion.')
    }
  }

  private exchange(
    inputId: string,
    command: InputIngestionCommand,
    accept: (payload: AgentServerPayload) => boolean
  ): Promise<AgentServerPayload> {
    if (this.pending.has(inputId)) {
      return Promise.reject(
        new Error('Another local input command is still awaiting confirmation.')
      )
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(inputId)
        reject(new Error('Local input ingestion confirmation timed out.'))
      }, this.options.responseTimeoutMs ?? INPUT_RESPONSE_TIMEOUT_MS)
      const pending: PendingResponse = { accept, resolve, reject, timer }
      this.pending.set(inputId, pending)
      let envelope: AgentClientEnvelope
      try {
        envelope = this.options.command(command)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(inputId)
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      if (!this.options.send(envelope)) {
        clearTimeout(timer)
        this.pending.delete(inputId)
        reject(
          new Error(
            'AI Assistant is offline; the local input was not fully ingested.'
          )
        )
      }
    })
  }

  private reportProgress(
    progress: Extract<AgentServerPayload, { type: 'input_progress' }>,
    totalBytes: number
  ): void {
    this.options.onProgress?.({
      inputId: progress.inputId,
      receivedBytes: progress.receivedBytes,
      totalBytes,
      receivedChunks: progress.receivedChunks,
      status: progress.status
    })
  }
}

export function localInputDisplayText(
  text: string,
  reference: InputReference
): string {
  const prefix = text.slice(0, 1_000)
  const suffix = text.length > 2_000 ? text.slice(-1_000) : ''
  const omission = Math.max(0, text.length - prefix.length - suffix.length)
  return [
    `[Large instruction stored locally: ${reference.byteLength.toLocaleString()} bytes, SHA-256 ${reference.sha256.slice(0, 12)}…]`,
    prefix,
    ...(omission > 0 ? [`\n… ${omission.toLocaleString()} characters not rendered …\n`] : []),
    ...(suffix ? [suffix] : [])
  ].join('')
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    bytes as BufferSource
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const batch = 32 * 1024
  for (let offset = 0; offset < bytes.length; offset += batch) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + batch))
  }
  return btoa(binary)
}
