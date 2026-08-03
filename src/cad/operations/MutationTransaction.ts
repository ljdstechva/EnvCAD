import type {
  CadOperationRequest,
  JsonValue,
  OperationCommit
} from '../../../shared/agent-contracts'

/**
 * The adapter must run mutation and every postcondition inside one CAD
 * transaction. A normal throw promises rollback; use
 * MutationCommitUnknownError when the CAD library cannot prove commit status.
 */
export interface MutationTransaction<T extends JsonValue> {
  execute(
    request: CadOperationRequest,
    signal: AbortSignal
  ): Promise<OperationCommit<T>>
}

export class MutationCommitUnknownError extends Error {
  constructor(
    message: string,
    readonly reconciliationFingerprint?: string
  ) {
    super(message)
    this.name = 'MutationCommitUnknownError'
  }
}
