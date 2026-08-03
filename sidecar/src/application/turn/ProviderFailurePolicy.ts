import type { StructuredFailure } from '../../../../shared/agent-contracts'

export class TurnInputUnavailableError extends Error {
  constructor() {
    super('The durable instruction reference could not be resolved locally.')
    this.name = 'TurnInputUnavailableError'
  }
}

export class TurnMutationUnresolvedError extends Error {
  constructor(readonly operationId: string) {
    super(`CAD operation "${operationId}" has no reconciled terminal status.`)
    this.name = 'TurnMutationUnresolvedError'
  }
}

export function providerFailure(error: unknown): StructuredFailure {
  if (error instanceof TurnInputUnavailableError) {
    return {
      kind: 'validation',
      code: 'instruction-input-unavailable',
      userMessage:
        'The preserved instruction could not be loaded. The drawing was not replayed or changed automatically.',
      developerMessage: error.message,
      retryable: false,
      fieldErrors: {
        instructionInputId:
          'Re-ingest the instruction before starting a replacement turn.'
      },
      recoveryActions: []
    }
  }
  if (error instanceof TurnMutationUnresolvedError) {
    return {
      kind: 'unknown-operation',
      code: 'mutation-status-unresolved',
      userMessage:
        'A drawing operation did not reach a known committed or rolled-back status. EnvCAD blocked automatic replay.',
      developerMessage: error.message,
      retryable: false,
      recoveryActions: [
        {
          id: 'export-diagnostics',
          kind: 'export-diagnostics',
          label: 'Export diagnostics',
          enabled: true
        }
      ]
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/\b(auth|login|credential|unauthenticated)\b/i.test(message)) {
    return {
      kind: 'authentication',
      code: 'provider-authentication-failed',
      userMessage:
        'The selected provider needs authentication before this turn can continue.',
      retryable: false,
      recoveryActions: [
        {
          id: 'choose-provider',
          kind: 'choose-provider',
          label: 'Review provider',
          enabled: true,
          requiresApproval: true
        }
      ]
    }
  }
  if (/\b(rate.?limit|too many requests|429)\b/i.test(message)) {
    return {
      kind: 'rate-limit',
      code: 'provider-rate-limited',
      userMessage:
        'The selected provider is temporarily rate-limited. The turn remains available to resume.',
      retryable: true,
      recoveryActions: [
        {
          id: 'resume-turn',
          kind: 'resume',
          label: 'Resume turn',
          enabled: true
        }
      ]
    }
  }
  if (/\b(context window|context length|too many tokens)\b/i.test(message)) {
    return {
      kind: 'validation',
      code: 'provider-context-capacity',
      userMessage:
        'The provider could not fit this request in its current context. The complete instruction remains preserved.',
      retryable: false,
      recoveryActions: [
        {
          id: 'resume-with-references',
          kind: 'resume',
          label: 'Resume with stored references',
          enabled: false
        }
      ]
    }
  }
  if (/\bsecurity boundary|protocol violation|malformed protocol\b/i.test(message)) {
    return {
      kind: 'security',
      code: 'provider-security-boundary',
      userMessage:
        'EnvCAD stopped the provider because its security boundary was violated.',
      retryable: false,
      recoveryActions: [
        {
          id: 'export-diagnostics',
          kind: 'export-diagnostics',
          label: 'Export diagnostics',
          enabled: true
        }
      ]
    }
  }
  return {
    kind: 'transient-provider',
    code: 'provider-turn-interrupted',
    userMessage:
      'The provider connection ended before the turn completed. EnvCAD preserved the turn and will not repeat drawing actions automatically.',
    retryable: true,
    recoveryActions: [
      {
        id: 'resume-turn',
        kind: 'resume',
        label: 'Resume turn',
        enabled: true
      }
    ]
  }
}
