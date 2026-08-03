import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import type {
  CadOperationRequest,
  OperationReceipt,
  WorkspaceRevision
} from '../../../shared/agent-contracts'
import { IndexedDbOperationLedger } from '../../cad/infrastructure/storage/IndexedDbOperationLedger'
import { InMemoryOperationLedger } from '../../cad/operations/OperationLedger'
import {
  createPendingReceipt,
  OperationUncertaintyBlockedError
} from '../../cad/operations/OperationReceipt'

const revision: WorkspaceRevision = {
  documentId: 'drawing-ledger',
  documentRevision: 1,
  contentRevision: 4,
  sheetRevision: 2,
  viewRevision: 7
}

function request(
  operationId: string,
  idempotencyKey = `key-${operationId}`
): CadOperationRequest {
  return {
    turnId: 'turn-ledger',
    operationId,
    operationGroupId: 'group-ledger',
    idempotencyKey,
    toolName: 'draw_line',
    argumentsHash: 'a'.repeat(64),
    expectedRevision: revision,
    deadline: '2026-07-29T23:59:59.000Z'
  }
}

function committed(pending: OperationReceipt): OperationReceipt {
  const json = '{"entityIds":["42"]}'
  return {
    ...pending,
    status: 'committed',
    revisionAfter: { ...revision, contentRevision: 5 },
    affectedEntityIds: ['42'],
    resultHash: 'b'.repeat(64),
    resultReference: {
      kind: 'inline-json',
      sha256: 'b'.repeat(64),
      byteLength: new TextEncoder().encode(json).byteLength,
      json
    },
    reconciliationFingerprint: 'c'.repeat(64),
    committedAt: '2026-07-29T08:00:00.000Z'
  }
}

describe('operation ledger safety boundary', () => {
  it('binds one idempotency key to at most one operation', async () => {
    const ledger = new InMemoryOperationLedger()
    const first = createPendingReceipt(request('operation-1'), revision)
    const duplicate = createPendingReceipt(
      request('operation-2', first.idempotencyKey),
      revision
    )

    expect(await ledger.createPending(first)).toMatchObject({ created: true })
    expect(await ledger.createPending(duplicate)).toMatchObject({
      created: false,
      receipt: { operationId: first.operationId, status: 'pending' }
    })
  })

  it('blocks a second write until an unresolved operation is reconciled', async () => {
    const ledger = new InMemoryOperationLedger()
    const first = createPendingReceipt(request('operation-1'), revision)
    await ledger.createPending(first)
    await ledger.save({
      ...first,
      status: 'unknown',
      failureCode: 'operation-status-unknown'
    })

    await expect(
      ledger.createPending(
        createPendingReceipt(request('operation-2'), revision)
      )
    ).rejects.toBeInstanceOf(OperationUncertaintyBlockedError)
    await expect(ledger.listUnresolved()).resolves.toMatchObject([
      { operationId: 'operation-1', status: 'unknown' }
    ])
  })

  it('reopens committed receipts without permitting illegal rewrites', async () => {
    const indexedDb = new IDBFactory()
    const databaseName = 'agent-operation-ledger-contract'
    const firstLedger = new IndexedDbOperationLedger({
      indexedDb,
      databaseName
    })
    const pending = createPendingReceipt(request('operation-1'), revision)
    await firstLedger.createPending(pending)
    await firstLedger.save(committed(pending))
    firstLedger.close()

    const reopened = new IndexedDbOperationLedger({
      indexedDb,
      databaseName
    })
    await expect(
      reopened.getByIdempotencyKey(pending.idempotencyKey)
    ).resolves.toMatchObject({
      operationId: pending.operationId,
      status: 'committed',
      affectedEntityIds: ['42']
    })
    await expect(
      reopened.save({
        ...pending,
        status: 'cancelled',
        failureCode: 'illegal-rewrite'
      })
    ).rejects.toThrow()
    reopened.close()
  })
})
