import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { OperationReceipt } from '../../shared/agent-contracts'
import { reconcileAbandonedOperations } from '../agentJournal/AbandonedOperationReconciler'
import { PersistentOperationLedger } from '../agentJournal/PersistentOperationLedger'

const roots: string[] = []

const pendingReceipt = (
  operationId: string,
  status: 'pending' | 'unknown' = 'pending'
): OperationReceipt => ({
  operationId,
  operationGroupId: 'operation-group-1',
  idempotencyKey: `idempotency-${operationId}`,
  toolName: 'move_entities',
  argumentsHash: 'a'.repeat(64),
  status,
  revisionBefore: {
    documentId: 'drawing-1',
    documentRevision: 1,
    contentRevision: 2,
    sheetRevision: 3,
    viewRevision: 4
  },
  affectedEntityIds: [],
  ...(status === 'unknown'
    ? { failureCode: 'operation-status-unknown' }
    : {})
})

afterEach(async () => {
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true })
  }
})

describe('abandoned operation startup reconciliation', () => {
  it('marks an abandoned pending mutation unknown without assuming rollback', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'envcad-operation-recovery-'))
    roots.push(root)
    const first = new PersistentOperationLedger(root)
    await first.createPending(pendingReceipt('operation-1'))
    await first.close()

    const restored = new PersistentOperationLedger(root)
    const result = await reconcileAbandonedOperations(restored)

    expect(result).toMatchObject({
      pendingMarkedUnknown: 1,
      unresolved: [
        {
          operationId: 'operation-1',
          status: 'unknown',
          failureCode: 'process-exited-before-operation-finalization'
        }
      ]
    })
    await expect(
      restored.createPending(pendingReceipt('operation-2'))
    ).rejects.toThrow('remains unknown')
    await restored.close()
  })

  it('leaves an already unknown receipt unchanged and remains idempotent', async () => {
    const ledger = {
      listUnresolved: async () => [pendingReceipt('operation-1', 'unknown')],
      save: async () => {
        throw new Error('save must not be called')
      }
    }

    await expect(reconcileAbandonedOperations(ledger)).resolves.toEqual({
      pendingMarkedUnknown: 0,
      unresolved: [pendingReceipt('operation-1', 'unknown')]
    })
  })
})
