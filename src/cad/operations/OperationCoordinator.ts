import {
  type CadOperationRequest,
  type JsonValue,
  type OperationCommit,
  type OperationExecution,
  type OperationReceipt,
  type WorkspaceRevision
} from '../../../shared/agent-contracts'
import type { MutationTransaction } from './MutationTransaction'
import { MutationCommitUnknownError } from './MutationTransaction'
import type { OperationLedger } from './OperationLedger'
import type { OperationResultStore } from './OperationResultStore'
import { OperationExecutionValidator } from './OperationExecutionValidator'
import {
  createPendingReceipt,
  IdempotencyConflictError,
  OperationPersistenceError,
  OperationStatusUnknownError,
  OperationUncertaintyBlockedError,
  receiptMatchesRequest
} from './OperationReceipt'

export interface OperationCoordinatorOptions {
  ledger: OperationLedger
  resultStore: OperationResultStore
  currentRevision(): WorkspaceRevision
  now?: () => Date
}

export class OperationCoordinator {
  private writerQueue: Promise<void> = Promise.resolve()
  private readonly now: () => Date
  private readonly validator: OperationExecutionValidator

  constructor(private readonly options: OperationCoordinatorOptions) {
    this.now = options.now ?? (() => new Date())
    this.validator = new OperationExecutionValidator({
      currentRevision: options.currentRevision,
      now: this.now
    })
  }

  execute<T extends JsonValue>(
    request: CadOperationRequest,
    actualInput: JsonValue,
    transaction: MutationTransaction<T>,
    signal: AbortSignal
  ): Promise<OperationExecution<T>> {
    const execution = this.writerQueue.then(() =>
      this.executeSerialized(request, actualInput, transaction, signal)
    )
    this.writerQueue = execution.then(
      () => undefined,
      () => undefined
    )
    return execution
  }

  getReceipt(operationId: string): Promise<OperationReceipt | undefined> {
    return this.options.ledger.getByOperationId(operationId)
  }

  private async executeSerialized<T extends JsonValue>(
    request: CadOperationRequest,
    actualInput: JsonValue,
    transaction: MutationTransaction<T>,
    signal: AbortSignal
  ): Promise<OperationExecution<T>> {
    await this.validator.validateIdentity(request, actualInput)
    const prior = await this.options.ledger.getByIdempotencyKey(
      request.idempotencyKey
    )
    if (prior) return this.replayPrior<T>(prior, request)
    const unresolved = await this.options.ledger.listUnresolved()
    if (unresolved.length > 0) {
      throw new OperationUncertaintyBlockedError(unresolved[0])
    }
    this.validator.validateDeadline(request)

    const revisionBefore = this.options.currentRevision()
    this.validator.assertExpectedRevision(request, revisionBefore)
    const pending = createPendingReceipt(request, revisionBefore)
    const created = await this.options.ledger.createPending(pending)
    if (!created.created) {
      return this.replayPrior<T>(created.receipt, request)
    }
    if (signal.aborted) return this.cancel(pending)

    const afterPersistence = this.options.currentRevision()
    try {
      this.validator.assertExpectedRevision(request, afterPersistence)
    } catch (error) {
      await this.finishWithoutMutation(pending, 'stale-workspace')
      throw error
    }

    let commit: OperationCommit<T>
    try {
      commit = await transaction.execute(request, signal)
    } catch (error) {
      return this.handleTransactionFailure(pending, error, signal)
    }

    try {
      this.validator.validateCommit(request, commit)
      const stored = await this.options.resultStore.write(commit.result)
      if (commit.resultHash && commit.resultHash !== stored.resultHash) {
        throw new Error('Mutation result hash does not match its replay record.')
      }
      const receipt: OperationReceipt = {
        ...pending,
        status: 'committed',
        revisionAfter: { ...commit.revisionAfter },
        affectedEntityIds: [...commit.affectedEntityIds],
        resultHash: stored.resultHash,
        resultReference: stored.reference,
        reconciliationFingerprint: commit.reconciliationFingerprint,
        committedAt: this.now().toISOString()
      }
      await this.options.ledger.save(receipt)
      return { receipt, result: commit.result, duplicate: false }
    } catch (error) {
      throw new OperationPersistenceError(
        pending.operationId,
        true,
        error instanceof Error ? error.message : undefined
      )
    }
  }

  private async handleTransactionFailure<T extends JsonValue>(
    pending: OperationReceipt,
    error: unknown,
    signal: AbortSignal
  ): Promise<OperationExecution<T>> {
    if (error instanceof MutationCommitUnknownError) {
      try {
        await this.options.ledger.save({
          ...pending,
          status: 'unknown',
          ...(error.reconciliationFingerprint
            ? { reconciliationFingerprint: error.reconciliationFingerprint }
            : {}),
          failureCode: 'operation-status-unknown'
        })
      } catch {
        throw new OperationPersistenceError(pending.operationId, 'unknown')
      }
      throw new OperationStatusUnknownError(pending.operationId)
    }
    const status = signal.aborted ? 'cancelled' : 'rolled-back'
    try {
      await this.options.ledger.save({
        ...pending,
        status,
        failureCode: signal.aborted
          ? 'operation-cancelled'
          : 'mutation-rolled-back'
      })
    } catch {
      throw new OperationPersistenceError(pending.operationId, false)
    }
    throw error
  }

  private async replayPrior<T extends JsonValue>(
    receipt: OperationReceipt,
    request: CadOperationRequest
  ): Promise<OperationExecution<T>> {
    if (!receiptMatchesRequest(receipt, request)) {
      throw new IdempotencyConflictError(receipt)
    }
    const result =
      receipt.status === 'committed' && receipt.resultReference
        ? ((await this.options.resultStore.read(receipt.resultReference)) as T)
        : undefined
    return { receipt, ...(result !== undefined ? { result } : {}), duplicate: true }
  }

  private async cancel(
    pending: OperationReceipt
  ): Promise<OperationExecution<never>> {
    await this.finishWithoutMutation(pending, 'operation-cancelled', 'cancelled')
    const receipt = await this.options.ledger.getByOperationId(pending.operationId)
    if (!receipt) throw new OperationPersistenceError(pending.operationId, false)
    return { receipt, duplicate: false }
  }

  private async finishWithoutMutation(
    pending: OperationReceipt,
    failureCode: string,
    status: 'rolled-back' | 'cancelled' = 'rolled-back'
  ): Promise<void> {
    await this.options.ledger.save({ ...pending, status, failureCode })
  }

}
