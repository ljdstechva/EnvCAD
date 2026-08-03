import {
  assertOperationReceiptTransition,
  validateOperationReceipt,
  type OperationReceipt
} from '../../shared/agent-contracts'
import {
  JournalCorruptionError,
  type LoadedJournal
} from './JournalFile'

export function replayJournalRecords(
  records: LoadedJournal['records'],
  receipts: Map<string, OperationReceipt>,
  idempotency: Map<string, string>
): void {
  for (const record of records) {
    const receipt = record.receipt
    try {
      validateOperationReceipt(receipt)
      const current = receipts.get(receipt.operationId)
      if (current) {
        assertOperationReceiptTransition(current, receipt)
      } else if (receipt.status !== 'pending') {
        throw new Error('operation begins after the pending state')
      } else {
        const blocking = [...receipts.values()].find(isUnresolved)
        if (blocking) {
          throw new Error(
            `operation ${receipt.operationId} begins while ${blocking.operationId} is unresolved`
          )
        }
      }
      const boundId = idempotency.get(receipt.idempotencyKey)
      if (boundId && boundId !== receipt.operationId) {
        throw new Error('idempotency key is bound to multiple operations')
      }
    } catch (error) {
      throw new JournalCorruptionError(
        `record ${record.sequence}: ${errorMessage(error)}`
      )
    }
    receipts.set(receipt.operationId, cloneReceipt(receipt))
    idempotency.set(receipt.idempotencyKey, receipt.operationId)
  }
}

export function isUnresolved(receipt: OperationReceipt): boolean {
  return receipt.status === 'pending' || receipt.status === 'unknown'
}

export function writeBarrierError(receipt: OperationReceipt): Error {
  return new Error(
    `CAD writes are blocked while operation "${receipt.operationId}" remains ${receipt.status}.`
  )
}

export function cloneReceipt(receipt: OperationReceipt): OperationReceipt {
  return structuredClone(receipt)
}

export function cloneOptional(
  receipt: OperationReceipt | undefined
): OperationReceipt | undefined {
  return receipt ? cloneReceipt(receipt) : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
