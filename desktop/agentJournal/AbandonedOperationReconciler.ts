import type { OperationReceipt } from '../../shared/agent-contracts'
import type { PersistentOperationLedger } from './PersistentOperationLedger'

export interface AbandonedOperationReconciliation {
  pendingMarkedUnknown: number
  unresolved: OperationReceipt[]
}

/**
 * A process exit destroys the in-memory execution witness for a pending CAD
 * mutation. Startup therefore records uncertainty explicitly and keeps the
 * global write barrier closed. It must not infer rollback or replay the tool.
 */
export async function reconcileAbandonedOperations(
  ledger: Pick<PersistentOperationLedger, 'listUnresolved' | 'save'>
): Promise<AbandonedOperationReconciliation> {
  const unresolved = await ledger.listUnresolved()
  let pendingMarkedUnknown = 0
  for (const receipt of unresolved) {
    if (receipt.status !== 'pending') continue
    await ledger.save({
      ...receipt,
      status: 'unknown',
      failureCode: 'process-exited-before-operation-finalization'
    })
    pendingMarkedUnknown += 1
  }
  return {
    pendingMarkedUnknown,
    unresolved: await ledger.listUnresolved()
  }
}
