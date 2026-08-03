import type {
  CadOperationRequest,
  JsonValue,
  OperationReceipt,
  WorkspaceRevision
} from '../../../shared/agent-contracts'
import {
  cloneWorkspaceRevision,
  operationArgumentsPreimage,
  sameWorkspaceRevision
} from '../../../shared/agent-contracts'

export const createPendingReceipt = (
  request: CadOperationRequest,
  revisionBefore: WorkspaceRevision
): OperationReceipt => ({
  operationId: request.operationId,
  operationGroupId: request.operationGroupId,
  idempotencyKey: request.idempotencyKey,
  toolName: request.toolName,
  argumentsHash: request.argumentsHash,
  status: 'pending',
  revisionBefore: cloneWorkspaceRevision(revisionBefore),
  affectedEntityIds: []
})

export const cloneOperationReceipt = (
  receipt: OperationReceipt
): OperationReceipt => structuredClone(receipt)

export const receiptMatchesRequest = (
  receipt: OperationReceipt,
  request: CadOperationRequest
): boolean =>
  receipt.operationId === request.operationId &&
  receipt.operationGroupId === request.operationGroupId &&
  receipt.idempotencyKey === request.idempotencyKey &&
  receipt.toolName === request.toolName &&
  receipt.argumentsHash === request.argumentsHash &&
  sameWorkspaceRevision(receipt.revisionBefore, request.expectedRevision)

export class IdempotencyConflictError extends Error {
  constructor(readonly priorReceipt: OperationReceipt) {
    super(
      `Idempotency key "${priorReceipt.idempotencyKey}" is already bound to a different operation.`
    )
    this.name = 'IdempotencyConflictError'
  }
}

export class StaleWorkspaceRevisionError extends Error {
  constructor(
    readonly expected: WorkspaceRevision,
    readonly actual: WorkspaceRevision
  ) {
    super('The complete workspace revision changed before mutation execution.')
    this.name = 'StaleWorkspaceRevisionError'
  }
}

export class OperationStatusUnknownError extends Error {
  constructor(
    readonly operationId: string,
    message = 'The mutation result could not be reconciled safely.'
  ) {
    super(message)
    this.name = 'OperationStatusUnknownError'
  }
}

export class OperationPersistenceError extends Error {
  constructor(
    readonly operationId: string,
    readonly drawingChanged: boolean | 'unknown',
    message = 'EnvCAD could not durably update the operation receipt.'
  ) {
    super(message)
    this.name = 'OperationPersistenceError'
  }
}

export class OperationUncertaintyBlockedError extends Error {
  constructor(readonly blockingReceipt: OperationReceipt) {
    super(
      `CAD writes are blocked while operation "${blockingReceipt.operationId}" remains ${blockingReceipt.status}.`
    )
    this.name = 'OperationUncertaintyBlockedError'
  }
}

export class OperationArgumentsHashMismatchError extends Error {
  constructor(readonly operationId: string) {
    super('The CAD operation arguments hash does not match its actual tool input.')
    this.name = 'OperationArgumentsHashMismatchError'
  }
}

export const hashOperationArguments = async (
  toolName: string,
  input: JsonValue
): Promise<string> => {
  const bytes = new TextEncoder().encode(
    operationArgumentsPreimage(toolName, input)
  )
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    Uint8Array.from(bytes).buffer
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
