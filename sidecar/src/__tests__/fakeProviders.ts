import type {
  AgentConfiguration,
  ProviderCapability,
  ProviderId
} from '../../../src/agent/protocol'
import type { CadToolBridge } from '../cadToolSpecs'
import type {
  AgentConversation,
  AgentEvent,
  AgentProvider
} from '../providers/types'

export const FAKE_MODELS = {
  'claude-code': {
    id: 'claude-default',
    invocationName: 'claude-default',
    displayName: 'Fake Claude',
    description: 'Deterministic Claude test model',
    supportedEfforts: [
      {
        value: 'high',
        displayName: 'High',
        description: 'Fake high effort',
        isDefault: true
      }
    ],
    defaultEffort: 'high',
    isDefault: true
  },
  'openai-codex': {
    id: 'codex-default',
    invocationName: 'codex-default',
    displayName: 'Fake Codex',
    description: 'Deterministic Codex test model',
    supportedEfforts: [
      {
        value: 'low',
        displayName: 'Low',
        isDefault: true
      },
      {
        value: 'high',
        displayName: 'High',
        isDefault: false
      }
    ],
    defaultEffort: 'low',
    isDefault: true
  }
} as const

export class FakeConversation implements AgentConversation {
  interrupted = false
  resetCount = 0
  closed = false
  prompts: string[] = []

  constructor(
    readonly events: AgentEvent[] = [
      { type: 'text_delta', text: 'done' }
    ],
    private readonly gate?: Promise<void>,
    private readonly failure?: Error
  ) {}

  async *runTurn(input: { prompt: string }): AsyncIterable<AgentEvent> {
    this.prompts.push(input.prompt)
    if (this.gate) await this.gate
    if (this.failure) throw this.failure
    for (const event of this.events) yield event
  }

  async interrupt(): Promise<void> {
    this.interrupted = true
  }

  async reset(): Promise<void> {
    this.resetCount += 1
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

export class FakeProvider implements AgentProvider {
  readonly displayName: string
  readonly configurations: AgentConfiguration[] = []
  readonly bridges: CadToolBridge[] = []
  readonly conversations: FakeConversation[] = []
  discoverCount = 0
  closed = false
  discoveryError: Error | undefined
  discoveryGate: Promise<void> | undefined
  nextEvents: AgentEvent[] = [{ type: 'text_delta', text: 'done' }]
  nextGate: Promise<void> | undefined
  nextError: Error | undefined
  nextCreateError: Error | undefined

  constructor(
    readonly id: ProviderId,
    public capability: ProviderCapability = {
      id,
      displayName: id === 'claude-code' ? 'Claude Code' : 'OpenAI Codex',
      status: 'ready',
      statusMessage: 'Ready for deterministic tests.',
      models: [{ ...FAKE_MODELS[id], supportedEfforts: [...FAKE_MODELS[id].supportedEfforts] }]
    }
  ) {
    this.displayName = capability.displayName
  }

  async discover(): Promise<ProviderCapability> {
    this.discoverCount += 1
    if (this.discoveryGate) await this.discoveryGate
    if (this.discoveryError) throw this.discoveryError
    return this.capability
  }

  async createConversation(
    configuration: AgentConfiguration,
    bridge: CadToolBridge
  ): Promise<AgentConversation> {
    this.configurations.push({ ...configuration })
    this.bridges.push(bridge)
    if (this.nextCreateError) {
      const error = this.nextCreateError
      this.nextCreateError = undefined
      throw error
    }
    const conversation = new FakeConversation(
      this.nextEvents,
      this.nextGate,
      this.nextError
    )
    this.conversations.push(conversation)
    this.nextGate = undefined
    this.nextError = undefined
    return conversation
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.all(
      this.conversations.map((conversation) => conversation.close())
    )
  }
}

export function unavailableProvider(
  id: ProviderId,
  status: 'missing' | 'authentication-required' | 'incompatible' | 'failed' =
    'missing'
): FakeProvider {
  return new FakeProvider(id, {
    id,
    displayName: id === 'claude-code' ? 'Claude Code' : 'OpenAI Codex',
    status,
    statusMessage: `${id} is ${status}.`,
    models: []
  })
}
