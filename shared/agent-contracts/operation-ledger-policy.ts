import {
  operationReceiptSchema,
  type OperationReceipt
} from './operation'
import { sameWorkspaceRevision } from './workspace-revision'

const ALLOWED_TRANSITIONS: Record<OperationReceipt['status'], string[]> = {
  pending: ['committed', 'rolled-back', 'cancelled', 'unknown'],
  unknown: ['committed', 'rolled-back'],
  committed: [],
  'rolled-back': [],
  cancelled: []
}

export const validateOperationReceipt = (
  receipt: OperationReceipt
): void => {
  if (!operationReceiptSchema.safeParse(receipt).success) {
    throw new Error('Operation receipt failed strict validation.')
  }
}

export const assertOperationReceiptTransition = (
  current: OperationReceipt,
  next: OperationReceipt
): void => {
  validateOperationReceipt(next)
  if (
    current.operationId !== next.operationId ||
    current.operationGroupId !== next.operationGroupId ||
    current.idempotencyKey !== next.idempotencyKey ||
    current.toolName !== next.toolName ||
    current.argumentsHash !== next.argumentsHash ||
    !sameWorkspaceRevision(current.revisionBefore, next.revisionBefore)
  ) {
    throw new Error('Immutable operation receipt fields cannot change.')
  }
  if (current.status === next.status) {
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      throw new Error('An operation receipt cannot change within one status.')
    }
    return
  }
  if (!ALLOWED_TRANSITIONS[current.status].includes(next.status)) {
    throw new Error(
      `Invalid operation transition from "${current.status}" to "${next.status}".`
    )
  }
}
