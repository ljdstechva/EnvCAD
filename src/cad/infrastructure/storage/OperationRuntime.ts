import type { WorkspaceRevision } from '../../../../shared/agent-contracts'
import { createDesktopOperationStores } from './DesktopOperationStores'
import { IndexedDbOperationLedger } from './IndexedDbOperationLedger'
import { IndexedDbOperationResultStore } from './IndexedDbOperationResultStore'
import { OperationCoordinator } from '../../operations/OperationCoordinator'

export function createDurableOperationCoordinator(
  currentRevision: () => WorkspaceRevision
): OperationCoordinator {
  const desktopApi = globalThis.window?.envcadDesktop
  if (desktopApi) {
    const stores = createDesktopOperationStores()
    return new OperationCoordinator({
      ledger: stores.ledger,
      resultStore: stores.results,
      currentRevision
    })
  }
  if (!globalThis.indexedDB) {
    throw new Error(
      'Durable operation storage is unavailable; AI drawing mutation is disabled.'
    )
  }
  return new OperationCoordinator({
    ledger: new IndexedDbOperationLedger(),
    resultStore: new IndexedDbOperationResultStore(),
    currentRevision
  })
}
