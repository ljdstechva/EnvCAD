import type { ProviderId } from '../../../src/agent/protocol'

export type ProviderHealthState =
  | 'checking'
  | 'healthy'
  | 'degraded'
  | 'unavailable'
  | 'circuit-open'

export interface ProviderHealth {
  providerId: ProviderId
  state: ProviderHealthState
  consecutiveFailures: number
  lastFailureAt?: string
  circuitOpenUntil?: string
}

export interface ProviderCircuitBreakerOptions {
  failureThreshold?: number
  failureWindowMs?: number
  cooldownMs?: number
  now?: () => number
}

export class ProviderCircuitBreaker {
  private readonly failureThreshold: number
  private readonly failureWindowMs: number
  private readonly cooldownMs: number
  private readonly now: () => number
  private failures: number[] = []
  private openUntil = 0
  private unavailable = false

  constructor(
    private readonly providerId: ProviderId,
    options: ProviderCircuitBreakerOptions = {}
  ) {
    this.failureThreshold = options.failureThreshold ?? 3
    this.failureWindowMs = options.failureWindowMs ?? 60_000
    this.cooldownMs = options.cooldownMs ?? 30_000
    this.now = options.now ?? Date.now
  }

  get health(): ProviderHealth {
    const now = this.now()
    this.prune(now)
    const circuitOpen = this.openUntil > now
    return {
      providerId: this.providerId,
      state: this.unavailable
        ? 'unavailable'
        : circuitOpen
          ? 'circuit-open'
          : this.failures.length > 0
            ? 'degraded'
            : 'healthy',
      consecutiveFailures: this.failures.length,
      ...(this.failures.at(-1) !== undefined
        ? { lastFailureAt: new Date(this.failures.at(-1)!).toISOString() }
        : {}),
      ...(circuitOpen
        ? { circuitOpenUntil: new Date(this.openUntil).toISOString() }
        : {})
    }
  }

  assertAvailable(): void {
    const health = this.health
    if (health.state === 'circuit-open') {
      throw new Error(
        `The ${this.providerId} provider recovery circuit is open until ${health.circuitOpenUntil}.`
      )
    }
    if (health.state === 'unavailable') {
      throw new Error(`The ${this.providerId} provider is unavailable.`)
    }
  }

  markAvailable(): void {
    this.unavailable = false
  }

  markUnavailable(): void {
    this.unavailable = true
  }

  recordSuccess(): void {
    this.failures = []
    this.openUntil = 0
    this.unavailable = false
  }

  recordFailure(): void {
    const now = this.now()
    this.prune(now)
    this.failures.push(now)
    if (this.failures.length >= this.failureThreshold) {
      this.openUntil = now + this.cooldownMs
    }
  }

  private prune(now: number): void {
    const cutoff = now - this.failureWindowMs
    this.failures = this.failures.filter((at) => at >= cutoff)
    if (this.openUntil <= now) this.openUntil = 0
  }
}
