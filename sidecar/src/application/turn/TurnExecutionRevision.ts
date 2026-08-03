import type {
  SubmitTurnEnvelope,
  VerificationSummary,
  WorkspaceRevision,
  WorkspaceRevisionTransitionKind
} from '../../../../shared/agent-contracts'

export function requiredTurnId(draft: SubmitTurnEnvelope): string {
  if (!draft.turnId) throw new Error('Durable turn draft has no turnId.')
  return draft.turnId
}

export function revisionTransition(
  previous: WorkspaceRevision,
  next: WorkspaceRevision
): WorkspaceRevisionTransitionKind {
  return previous.documentId === next.documentId
    ? 'same-document'
    : 'document-replaced'
}

export function defaultVerification(
  revision: WorkspaceRevision
): VerificationSummary {
  return {
    mode: 'database-only',
    databaseChecks: ['Final workspace revision recorded.'],
    visualEvidenceIds: [],
    warnings: ['No revision-bound visual evidence was requested or captured.'],
    revision: { ...revision }
  }
}
