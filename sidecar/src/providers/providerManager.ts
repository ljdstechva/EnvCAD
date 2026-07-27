import type {
  AgentConfiguration,
  ProviderCapability,
  ProviderId
} from '../../../src/agent/protocol'
import { sameConfiguration, validateConfiguration } from '../providerCatalog'
import type { CadToolBridge } from '../cadToolSpecs'
import { redactProviderDiagnostic } from './environment'
import type {
  AgentConversation,
  AgentProvider,
  ProviderLogger
} from './types'

export class ProviderManager {
  private readonly providers = new Map<ProviderId, AgentProvider>()
  private capabilities: ProviderCapability[]
  private activeConfiguration: AgentConfiguration | undefined
  private activeConversation: AgentConversation | undefined
  private discoveryPromise: Promise<ProviderCapability[]> | undefined
  private readonly discoveryListeners = new Set<
    (provider: ProviderCapability) => void
  >()
  private closed = false

  constructor(
    providers: readonly AgentProvider[],
    private readonly logger: ProviderLogger = console
  ) {
    for (const provider of providers) {
      if (this.providers.has(provider.id)) {
        throw new Error(`Duplicate AI provider "${provider.id}".`)
      }
      this.providers.set(provider.id, provider)
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
    return this.capabilities.map((provider) => ({
      ...provider,
      models: provider.models.map((model) => ({
        ...model,
        supportedEfforts: model.supportedEfforts.map((effort) => ({ ...effort }))
      }))
    }))
  }

  get configuration(): AgentConfiguration | undefined {
    return this.activeConfiguration ? { ...this.activeConfiguration } : undefined
  }

  get conversation(): AgentConversation | undefined {
    return this.activeConversation
  }

  discover(
    onUpdate?: (provider: ProviderCapability) => void
  ): Promise<ProviderCapability[]> {
    if (this.closed) {
      return Promise.reject(new Error('AI provider manager is closed.'))
    }
    if (onUpdate) this.discoveryListeners.add(onUpdate)
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

  private async runDiscovery(): Promise<ProviderCapability[]> {
    const next = new Map<ProviderId, ProviderCapability>(
      this.capabilities.map((capability) => [capability.id, capability])
    )
    await Promise.all(
      [...this.providers.values()].map(async (provider) => {
        const startedAt = performance.now()
        let capability: ProviderCapability
        try {
          capability = await provider.discover()
        } catch (error) {
          const detail = redactProviderDiagnostic(
            error instanceof Error ? error.message : error
          )
          this.logger.error(
            `[sidecar] ${provider.displayName} discovery failed: ${detail}`
          )
          capability = {
            id: provider.id,
            displayName: provider.displayName,
            status: 'failed',
            statusMessage: `${provider.displayName} discovery failed: ${detail}`,
            models: [],
            discoveryMs: performance.now() - startedAt
          }
        }
        next.set(provider.id, capability)
        this.capabilities = [...this.providers.keys()].map((id) => next.get(id)!)
        for (const listener of this.discoveryListeners) listener(capability)
      })
    )
    if (
      this.activeConfiguration &&
      this.validate(this.activeConfiguration)
    ) {
      await this.activeConversation?.close()
      this.activeConversation = undefined
      this.activeConfiguration = undefined
    }
    return this.catalog
  }

  validate(configuration: AgentConfiguration): string | undefined {
    return validateConfiguration(this.capabilities, configuration)
  }

  async applyConfiguration(
    configuration: AgentConfiguration,
    tools: CadToolBridge
  ): Promise<{ configuration: AgentConfiguration; newConversation: boolean }> {
    if (this.closed) throw new Error('AI provider manager is closed.')
    const validationError = this.validate(configuration)
    if (validationError) throw new Error(validationError)

    const normalized = this.normalizeConfiguration(configuration)
    if (
      sameConfiguration(this.activeConfiguration, normalized) &&
      this.activeConversation
    ) {
      return { configuration: normalized, newConversation: false }
    }

    await this.activeConversation?.close()
    this.activeConversation = undefined
    this.activeConfiguration = undefined

    const provider = this.providers.get(normalized.provider)
    if (!provider) throw new Error(`Unknown AI provider "${normalized.provider}".`)
    const conversation = await provider.createConversation(normalized, tools)
    this.activeConversation = conversation
    this.activeConfiguration = normalized
    return { configuration: normalized, newConversation: true }
  }

  async interrupt(): Promise<void> {
    await this.activeConversation?.interrupt()
  }

  async reset(): Promise<void> {
    await this.activeConversation?.reset()
  }

  async clearConversation(): Promise<void> {
    await this.activeConversation?.close()
    this.activeConversation = undefined
    this.activeConfiguration = undefined
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.activeConversation?.close()
    this.activeConversation = undefined
    this.activeConfiguration = undefined
    await Promise.all([...this.providers.values()].map((provider) => provider.close()))
  }

  private normalizeConfiguration(configuration: AgentConfiguration): AgentConfiguration {
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
}
