import type { TurnEvent } from '../../../../shared/agent-contracts'
import { DurableTurnEventSink } from './DurableTurnEventSink'

const DEFAULT_CHUNK_BYTES = 16 * 1024
const DEFAULT_FLUSH_MS = 40

export interface DurableTextEmitterOptions {
  sink: DurableTurnEventSink
  turnId: string
  maximumChunkBytes?: number
  flushMs?: number
}

export class DurableTextEmitter {
  private buffer = ''
  private chunkIndex = 0
  private firstChunk = true
  private timer: ReturnType<typeof setTimeout> | undefined
  private writes: Promise<void> = Promise.resolve()
  private closed = false

  constructor(private readonly options: DurableTextEmitterOptions) {}

  async push(text: string): Promise<void> {
    if (this.closed) throw new Error('Assistant text emitter is closed.')
    if (!text) return
    this.buffer += text
    if (
      this.firstChunk ||
      new TextEncoder().encode(this.buffer).byteLength >=
        (this.options.maximumChunkBytes ?? DEFAULT_CHUNK_BYTES)
    ) {
      await this.flush()
      return
    }
    this.timer ??= setTimeout(
      () => {
        void this.flush().catch(() => {
          // close() observes the same rejected write chain.
        })
      },
      this.options.flushMs ?? DEFAULT_FLUSH_MS
    )
    this.timer.unref?.()
  }

  async close(): Promise<void> {
    if (this.closed) return this.writes
    this.closed = true
    clearTimeout(this.timer)
    this.timer = undefined
    await this.flush()
    await this.writes
  }

  private flush(): Promise<void> {
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.buffer) return this.writes
    const text = this.buffer
    const index = this.chunkIndex++
    this.buffer = ''
    this.firstChunk = false
    const event: TurnEvent = {
      type: 'assistant_text_delta',
      turnId: this.options.turnId,
      text
    }
    this.writes = this.writes.then(async () => {
      await this.options.sink.append(
        this.options.turnId,
        `assistant-text-${index}`,
        event
      )
    })
    return this.writes
  }
}
