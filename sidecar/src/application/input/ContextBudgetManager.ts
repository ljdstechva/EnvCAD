const DEFAULT_CONTEXT_WINDOW_TOKENS = 96 * 1024
const DEFAULT_OUTPUT_RESERVE_TOKENS = 8 * 1024
const CONSERVATIVE_UTF8_BYTES_PER_TOKEN = 3
const DEFAULT_IMAGE_RESERVE_BYTES = 24 * 1024

export interface ContextBudgetManagerOptions {
  staticContextBytes: number
  contextWindowTokens?: number
  outputReserveTokens?: number
  bytesPerToken?: number
  imageReserveBytes?: number
}

export interface ContextBudgetSnapshot {
  capacityBytes: number
  usedBytes: number
  remainingBytes: number
  promptBytes: number
  toolResultBytes: number
}

export interface ContextBudgetDecision {
  allowed: boolean
  requiredBytes: number
  remainingBytes: number
}

/**
 * Conservative byte-based guard for provider context. It is not a tokenizer:
 * using three UTF-8 bytes per token intentionally overestimates common text.
 */
export class ContextBudgetManager {
  private readonly capacityBytes: number
  private readonly imageReserveBytes: number
  private usedBytes = 0
  private promptBytes = 0
  private toolResultBytes = 0
  private active = false

  constructor(private readonly options: ContextBudgetManagerOptions) {
    if (!Number.isSafeInteger(options.staticContextBytes) ||
        options.staticContextBytes < 0) {
      throw new Error('Context budget static byte count is invalid.')
    }
    const windowTokens =
      options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS
    const reserveTokens =
      options.outputReserveTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS
    const bytesPerToken =
      options.bytesPerToken ?? CONSERVATIVE_UTF8_BYTES_PER_TOKEN
    if (
      !Number.isSafeInteger(windowTokens) ||
      !Number.isSafeInteger(reserveTokens) ||
      reserveTokens >= windowTokens ||
      bytesPerToken <= 0
    ) {
      throw new Error('Context budget token limits are invalid.')
    }
    this.capacityBytes = Math.floor(
      (windowTokens - reserveTokens) * bytesPerToken
    )
    if (options.staticContextBytes >= this.capacityBytes) {
      throw new Error('Static provider context leaves no turn input budget.')
    }
    this.imageReserveBytes =
      options.imageReserveBytes ?? DEFAULT_IMAGE_RESERVE_BYTES
  }

  beginTurn(): void {
    this.active = true
    this.usedBytes = this.options.staticContextBytes
    this.promptBytes = 0
    this.toolResultBytes = 0
  }

  endTurn(): void {
    this.active = false
    this.usedBytes = 0
    this.promptBytes = 0
    this.toolResultBytes = 0
  }

  registerPrompt(prompt: string): void {
    const bytes = utf8Bytes(prompt)
    const decision = this.reserve(bytes)
    if (!decision.allowed) {
      throw new ContextBudgetExceededError(bytes, decision.remainingBytes)
    }
    this.promptBytes += bytes
  }

  reserveToolResult(
    value: unknown,
    options: { hasImage?: boolean; maximumBytes?: number } = {}
  ): ContextBudgetDecision {
    const serialized = JSON.stringify(value)
    const actual = utf8Bytes(serialized ?? 'null')
    const bounded =
      options.maximumBytes === undefined
        ? actual
        : Math.min(actual, options.maximumBytes)
    const required =
      bounded + (options.hasImage ? this.imageReserveBytes : 0)
    const decision = this.reserve(required)
    if (decision.allowed) this.toolResultBytes += required
    return decision
  }

  reserveMaximumToolResult(
    maximumBytes: number
  ): ContextBudgetDecision {
    const decision = this.reserve(maximumBytes)
    if (decision.allowed) this.toolResultBytes += maximumBytes
    return decision
  }

  snapshot(): ContextBudgetSnapshot {
    return {
      capacityBytes: this.capacityBytes,
      usedBytes: this.usedBytes,
      remainingBytes: Math.max(0, this.capacityBytes - this.usedBytes),
      promptBytes: this.promptBytes,
      toolResultBytes: this.toolResultBytes
    }
  }

  private reserve(requiredBytes: number): ContextBudgetDecision {
    if (!this.active) {
      return {
        allowed: true,
        requiredBytes,
        remainingBytes: Number.MAX_SAFE_INTEGER
      }
    }
    const remainingBytes = Math.max(
      0,
      this.capacityBytes - this.usedBytes
    )
    if (requiredBytes > remainingBytes) {
      return { allowed: false, requiredBytes, remainingBytes }
    }
    this.usedBytes += requiredBytes
    return {
      allowed: true,
      requiredBytes,
      remainingBytes: remainingBytes - requiredBytes
    }
  }
}

export class ContextBudgetExceededError extends Error {
  constructor(
    readonly requiredBytes: number,
    readonly remainingBytes: number
  ) {
    super(
      'The provider context window cannot safely fit this request. ' +
      'Use stored input references and targeted retrieval.'
    )
    this.name = 'ContextBudgetExceededError'
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}
