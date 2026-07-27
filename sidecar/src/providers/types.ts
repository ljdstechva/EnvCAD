import type {
  AgentConfiguration,
  ProviderCapability,
  ProviderId
} from '../../../src/agent/protocol'
import type { CadToolBridge } from '../cadToolSpecs'

export interface AgentTurnInput {
  prompt: string
}

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'retry' }
  | { type: 'resolved_model'; model: string }
  | {
      type: 'token_usage'
      inputTokens?: number
      outputTokens?: number
    }

export interface AgentConversation {
  runTurn(input: AgentTurnInput): AsyncIterable<AgentEvent>
  interrupt(): Promise<void>
  reset(): Promise<void>
  close(): Promise<void>
}

export interface AgentProvider {
  readonly id: ProviderId
  readonly displayName: string
  discover(): Promise<ProviderCapability>
  createConversation(
    configuration: AgentConfiguration,
    tools: CadToolBridge
  ): Promise<AgentConversation>
  close(): Promise<void>
}

export interface ProviderLogger {
  log(message: string): void
  error(message: string, error?: unknown): void
}
