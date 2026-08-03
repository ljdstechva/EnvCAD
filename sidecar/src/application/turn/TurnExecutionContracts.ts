import type {
  SkillActivation,
  SubmitTurnEnvelope,
  VerificationSummary,
  WorkspaceRevision
} from '../../../../shared/agent-contracts'

export type NeutralProviderEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'retry' }
  | { type: 'resolved_model'; model: string }
  | { type: 'token_usage'; inputTokens?: number; outputTokens?: number }

export interface ProviderTurnPort {
  runTurn(input: { prompt: string }): AsyncIterable<NeutralProviderEvent>
  interrupt(): Promise<void>
}

export interface TurnToolMetrics {
  toolCalls: number
  mutationCalls?: number
  firstToolCallMs?: number
}

export interface TurnExecutionContext {
  draft: SubmitTurnEnvelope
  provider: string
  prompt?: string
  resolvePrompt?(): Promise<string>
  classificationText?: string
  activeSkills: readonly SkillActivation[]
  conversation: ProviderTurnPort
  recoverProvider?(
    failure: unknown,
    signal: AbortSignal
  ): Promise<ProviderTurnPort>
  currentRevision(): WorkspaceRevision
  toolMetrics(): TurnToolMetrics
  unresolvedMutation?(): string | undefined
  providerReadyMs?: number
  conversationStartupMs?: number
  providerRecoveryTimeoutMs?: number
  performPrePlanningInspection?(): Promise<void>
  performVerification?(): Promise<VerificationSummary>
  wallClockNow?: () => Date
}

export type TurnExecutionResult =
  | { duplicate: true }
  | {
      duplicate: false
      outcome: 'completed' | 'recovered' | 'cancelled' | 'failed'
    }
