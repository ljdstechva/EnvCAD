import type {
  AgentConfiguration,
  EffortCapability,
  ModelCapability,
  ProviderCapability
} from '../../src/agent/protocol'

const EFFORT_LABELS: Record<string, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max'
}

export function effortDisplayName(value: string): string {
  return EFFORT_LABELS[value] ?? value
}

export function createEffortCapabilities(
  values: readonly string[],
  defaultValue?: string,
  descriptions: ReadonlyMap<string, string> = new Map()
): EffortCapability[] {
  const unique = [...new Set(values)].filter((value) => value !== 'ultra')
  const effectiveDefault =
    defaultValue && unique.includes(defaultValue) ? defaultValue : undefined
  return unique.map((value) => ({
    value,
    displayName: effortDisplayName(value),
    ...(descriptions.get(value) ? { description: descriptions.get(value) } : {}),
    isDefault: value === effectiveDefault
  }))
}

export function defaultModel(capability: ProviderCapability): ModelCapability | undefined {
  return capability.models.find((model) => model.isDefault) ?? capability.models[0]
}

export function sameConfiguration(
  left: AgentConfiguration | undefined,
  right: AgentConfiguration | undefined
): boolean {
  return (
    left?.provider === right?.provider &&
    left?.model === right?.model &&
    left?.effort === right?.effort
  )
}

export function validateConfiguration(
  capabilities: readonly ProviderCapability[],
  configuration: AgentConfiguration
): string | undefined {
  const provider = capabilities.find((candidate) => candidate.id === configuration.provider)
  if (!provider) return `Unknown AI provider "${configuration.provider}".`
  if (provider.status !== 'ready') {
    return `${provider.displayName} is unavailable: ${provider.statusMessage}`
  }
  const model = provider.models.find(
    (candidate) =>
      candidate.id === configuration.model ||
      candidate.invocationName === configuration.model
  )
  if (!model) {
    return `${provider.displayName} does not currently advertise model "${configuration.model}".`
  }
  if (
    configuration.effort !== undefined &&
    !model.supportedEfforts.some((effort) => effort.value === configuration.effort)
  ) {
    return `${model.displayName} does not support effort "${configuration.effort}".`
  }
  return undefined
}
