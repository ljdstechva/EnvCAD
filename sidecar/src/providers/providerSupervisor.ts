import type {
  AgentConfiguration,
  ProviderCapability,
  ProviderId
} from '../../../src/agent/protocol'
import type { CadToolBridge } from '../cadToolSpecs'
import { sameConfiguration, validateConfiguration } from '../providerCatalog'
import { redactProviderDiagnostic } from './environment'
import {
  ProviderCircuitBreaker,
  type ProviderCircuitBreakerOptions,
  type ProviderHealth
} from './ProviderCircuitBreaker'
import type {
  AgentConversation,
  AgentProvider,
  ProviderLogger
} from './types'

export interface ProviderSupervisorOptions
  extends ProviderCircuitBreakerOptions {
  capabilityCacheTtlMs?: number
}

export class ProviderSupervisor {
  private readonly providers = new Map<ProviderId, AgentProvider>()
  private readonly circuits = new Map<ProviderId, ProviderCircuitBreaker>()
  private capabilities: ProviderCapability[]
  private activeConfiguration: AgentConfiguration | undefined
  private activeConversation: AgentConversation | undefined
  private discoveryPromise: Promise<ProviderCapability[]> | undefined
  private discoveryCompletedAt = 0
  private readonly discoveryListeners = new Set<
    (provider: ProviderCapability) => void
  >()
  private readonly now: () => number
  private readonly capabilityCacheTtlMs: number
  private closed = false

  constructor(
    providers: readonly AgentProvider[],
    private readonly logger: ProviderLogger = console,
    options: ProviderSupervisorOptions = {}
  ) {
    this.now = options.now ?? Date.now
    this.capabilityCacheTtlMs = options.capabilityCacheTtlMs ?? 30_000
    for (const provider of providers) {
      if (this.providers.has(provider.id)) {
        throw new Error(`Duplicate AI provider "${provider.id}".`)
      }
      this.providers.set(provider.id, provider)
      this.circuits.set(provider.id, new ProviderCircuitBreaker(provider.id, options))
    }
    this.capabilities = providers.map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      status: 'checking',
      statusMessage: `Checking ${provider.displayName}…`,
      models: []
    }))
  }

  get catalog(): ProviderCapability[] {
    return this.capabilities.map(cloneCapability)
  }

  get health(): ProviderHealth[] {
    return [...this.circuits.values()].map((circuit) => circuit.health)
  }

  get configuration(): AgentConfiguration | undefined {
    return this.activeConfiguration ? { ...this.activeConfiguration } : undefined
  }

  get conversation(): AgentConversation | undefined {
    return this.activeConversation
  }

  discover(
    onUpdate?: (provider: ProviderCapability) => void,
    options: { force?: boolean } = {}
  ): Promise<ProviderCapability[]> {
    this.assertOpen()
    if (onUpdate) this.discoveryListeners.add(onUpdate)
    if (!options.force && this.hasFreshCapabilityCache()) {
      if (onUpdate) {
        for (const capability of this.catalog) onUpdate(capability)
        this.discoveryListeners.delete(onUpdate)
      }
      return Promise.resolve(this.catalog)
    }
    if (!this.discoveryPromise) {
      this.discoveryPromise = this.runDiscovery().finally(() => {
        this.discoveryPromise = undefined
        this.discoveryListeners.clear()
      })
    }
    const discovery = this.discoveryPromise
    return onUpdate
      ? discovery.finally(() => this.discoveryListeners.delete(onUpdate))
      : discovery
  }

  validate(configuration: AgentConfiguration): string | undefined {
    return validateConfiguration(this.capabilities, configuration)
  }

  async applyConfiguration(
    configuration: AgentConfiguration,
    tools: CadToolBridge
  ): Promise<{ configuration: AgentConfiguration; newConversation: boolean }> {
    this.assertOpen()
    const validationError = this.validate(configuration)
    if (validationError) throw new Error(validationError)
    const normalized = this.normalizeConfiguration(configuration)
    if (
      sameConfiguration(this.activeConfiguration, normalized) &&
      this.activeConversation
    ) {
      return { configuration: normalized, newConversation: false }
    }
    await this.replaceConversation(normalized, tools)
    return { configuration: normalized, newConversation: true }
  }

  async recreateConversation(
    tools: CadToolBridge,
    failure?: unknown,
    signal?: AbortSignal
  ): Promise<AgentConversation> {
    this.assertOpen()
    const configuration = this.activeConfiguration
    if (!configuration) throw new Error('No AI provider configuration is active.')
    if (failure !== undefined) {
      this.circuits.get(configuration.provider)?.recordFailure()
    }
    return this.replaceConversation(configuration, tools, signal)
  }

  async interrupt(): Promise<void> {
    await this.activeConversation?.interrupt()
  }

  async reset(): Promise<void> {
    await this.activeConversation?.reset()
  }

  async clearConversation(): Promise<void> {
    const previous = this.activeConversation
    this.activeConversation = undefined
    this.activeConfiguration = undefined
    await this.closeConversation(previous)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const previous = this.activeConversation
    this.activeConversation = undefined
    this.activeConfiguration = undefined
    await this.closeConversation(previous)
    await Promise.all([...this.providers.values()].map((provider) => provider.close()))
  }

  private async runDiscovery(): Promise<ProviderCapability[]> {
    const next = new Map(this.capabilities.map((item) => [item.id, item]))
    await Promise.all(
      [...this.providers.values()].map(async (provider) => {
        const startedAt = performance.now()
        const capability = await this.discoverProvider(provider, startedAt)
        next.set(provider.id, capability)
        this.capabilities = [...this.providers.keys()].map((id) => next.get(id)!)
        for (const listener of this.discoveryListeners) listener(cloneCapability(capability))
      })
    )
    this.discoveryCompletedAt = this.now()
    if (
      this.activeConfiguration &&
      this.validate(this.activeConfiguration) !== undefined
    ) {
      const invalidated = this.activeConversation
      this.activeConversation = undefined
      this.activeConfiguration = undefined
      await this.closeConversation(invalidated)
    }
    return this.catalog
  }

  private async discoverProvider(
    provider: AgentProvider,
    startedAt: number
  ): Promise<ProviderCapability> {
    try {
      const capability = await provider.discover()
      const circuit = this.circuits.get(provider.id)!
      if (capability.status === 'ready') circuit.markAvailable()
      else circuit.markUnavailable()
      return capability
    } catch (error) {
      this.circuits.get(provider.id)?.markUnavailable()
      const detail = redactProviderDiagnostic(
        error instanceof Error ? error.message : error
      )
      this.logger.error(
        `[sidecar] ${provider.displayName} discovery failed: ${detail}`
      )
      return {
        id: provider.id,
        displayName: provider.displayName,
        status: 'failed',
        statusMessage: `${provider.displayName} discovery failed: ${detail}`,
        models: [],
        discoveryMs: performance.now() - startedAt
      }
    }
  }

  private async replaceConversation(
    configuration: AgentConfiguration,
    tools: CadToolBridge,
    signal?: AbortSignal
  ): Promise<AgentConversation> {
    const provider = this.providers.get(configuration.provider)
    if (!provider) throw new Error(`Unknown AI provider "${configuration.provider}".`)
    const circuit = this.circuits.get(configuration.provider)!
    circuit.assertAvailable()
    let replacement: AgentConversation
    try {
      replacement = await provider.createConversation(configuration, tools)
    } catch (error) {
      circuit.recordFailure()
      throw error
    }
    if (signal?.aborted) {
      await this.closeConversation(replacement)
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error('Provider conversation recovery was cancelled.')
    }
    const previous = this.activeConversation
    this.activeConversation = replacement
    this.activeConfiguration = { ...configuration }
    circuit.recordSuccess()
    await this.closeConversation(previous)
    return replacement
  }

  private async closeConversation(
    conversation: AgentConversation | undefined
  ): Promise<void> {
    try {
      await conversation?.close()
    } catch (error) {
      this.logger.error('[sidecar] failed to close replaced provider conversation', error)
    }
  }

  private hasFreshCapabilityCache(): boolean {
    return (
      this.capabilities.every((capability) => capability.status === 'ready') &&
      this.now() - this.discoveryCompletedAt < this.capabilityCacheTtlMs
    )
  }

  private normalizeConfiguration(
    configuration: AgentConfiguration
  ): AgentConfiguration {
    const provider = this.capabilities.find(
      (candidate) => candidate.id === configuration.provider
    )
    const model = provider?.models.find(
      (candidate) =>
        candidate.id === configuration.model ||
        candidate.invocationName === configuration.model
    )
    if (!model) return { ...configuration }
    return {
      provider: configuration.provider,
      model: model.invocationName,
      ...(configuration.effort ? { effort: configuration.effort } : {})
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('AI provider supervisor is closed.')
  }
}

function cloneCapability(provider: ProviderCapability): ProviderCapability {
  return {
    ...provider,
    models: provider.models.map((model) => ({
      ...model,
      supportedEfforts: model.supportedEfforts.map((effort) => ({ ...effort }))
    }))
  }
}
