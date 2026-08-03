import { describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import type {
  CadOperationRequest,
  JsonValue,
  OperationReceipt,
  WorkspaceRevision
} from '../../../shared/agent-contracts'
import { OperationCoordinator } from '../operations/OperationCoordinator'
import {
  InMemoryOperationLedger,
  type OperationLedger
} from '../operations/OperationLedger'
import {
  IdempotencyConflictError,
  OperationArgumentsHashMismatchError,
  OperationPersistenceError,
  OperationStatusUnknownError,
  OperationUncertaintyBlockedError,
  hashOperationArguments
} from '../operations/OperationReceipt'
import { InMemoryOperationResultStore } from '../operations/OperationResultStore'
import { IndexedDbOperationLedger } from '../infrastructure/storage/IndexedDbOperationLedger'
import { IndexedDbOperationResultStore } from '../infrastructure/storage/IndexedDbOperationResultStore'
import { OperationStatusHandler } from '../operations/OperationStatusHandler'
import {
  MutationCommitUnknownError,
  type MutationTransaction
} from '../operations/MutationTransaction'

const before: WorkspaceRevision = {
  documentId: 'drawing-1',
  documentRevision: 1,
  contentRevision: 2,
  sheetRevision: 3,
  viewRevision: 4
}

const after = (contentRevision = 3): WorkspaceRevision => ({
  ...before,
  contentRevision
})

const createRequest = async (
  input: JsonValue,
  overrides: Partial<CadOperationRequest> = {}
): Promise<CadOperationRequest> => ({
  turnId: 'turn-1',
  operationId: 'operation-1',
  operationGroupId: 'group-1',
  idempotencyKey: 'idempotency-1',
  toolName: 'draw_line',
  argumentsHash: await hashOperationArguments('draw_line', input),
  expectedRevision: before,
  deadline: '2026-07-29T08:00:00.000Z',
  ...overrides
})

const successfulTransaction = (
  setRevision: (revision: WorkspaceRevision) => void,
  result: JsonValue = { entityIds: ['10'] }
): MutationTransaction<JsonValue> => ({
  async execute() {
    setRevision(after())
    return {
      result,
      revisionBefore: before,
      revisionAfter: after(),
      affectedEntityIds: ['10'],
      reconciliationFingerprint: 'b'.repeat(64)
    }
  }
})

const setup = (
  ledger: OperationLedger = new InMemoryOperationLedger()
) => {
  let current = before
  let now = new Date('2026-07-29T07:00:00.000Z')
  const coordinator = new OperationCoordinator({
    ledger,
    resultStore: new InMemoryOperationResultStore(),
    currentRevision: () => current,
    now: () => now
  })
  return {
    coordinator,
    ledger,
    setRevision: (revision: WorkspaceRevision) => {
      current = revision
    },
    setNow: (value: string) => {
      now = new Date(value)
    }
  }
}

describe('exactly-once CAD mutation coordination', () => {
  it('persists pending before execution and replays one committed result', async () => {
    const input = { start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }
    const request = await createRequest(input)
    const context = setup()
    const execute = vi.fn(async () => {
      expect(
        (await context.ledger.getByOperationId(request.operationId))?.status
      ).toBe('pending')
      context.setRevision(after())
      return {
        result: { entityIds: ['10'] },
        revisionBefore: before,
        revisionAfter: after(),
        affectedEntityIds: ['10'],
        reconciliationFingerprint: 'b'.repeat(64)
      }
    })
    const transaction: MutationTransaction<JsonValue> = { execute }

    const first = await context.coordinator.execute(
      request,
      input,
      transaction,
      new AbortController().signal
    )
    context.setNow('2026-07-29T09:00:00.000Z')
    const duplicate = await context.coordinator.execute(
      request,
      input,
      transaction,
      new AbortController().signal
    )

    expect(first.receipt.status).toBe('committed')
    expect(duplicate).toMatchObject({
      duplicate: true,
      result: { entityIds: ['10'] }
    })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('rejects argument mismatches and operation ID collisions without mutation', async () => {
    const input = { start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }
    const request = await createRequest(input)
    const context = setup()
    const firstTransaction = successfulTransaction(context.setRevision)
    await context.coordinator.execute(
      request,
      input,
      firstTransaction,
      new AbortController().signal
    )

    await expect(
      context.coordinator.execute(
        request,
        { start: { x: 1, y: 0 }, end: { x: 10, y: 0 } },
        firstTransaction,
        new AbortController().signal
      )
    ).rejects.toBeInstanceOf(OperationArgumentsHashMismatchError)

    const collisionInput = { start: { x: 10, y: 0 }, end: { x: 20, y: 0 } }
    const collision = await createRequest(collisionInput, {
      idempotencyKey: 'idempotency-2',
      expectedRevision: after()
    })
    const collisionTransaction = { execute: vi.fn() }
    await expect(
      context.coordinator.execute(
        collision,
        collisionInput,
        collisionTransaction,
        new AbortController().signal
      )
    ).rejects.toBeInstanceOf(IdempotencyConflictError)
    expect(collisionTransaction.execute).not.toHaveBeenCalled()
  })

  it('rechecks workspace revision after pending persistence', async () => {
    let current = before
    const baseLedger = new InMemoryOperationLedger()
    const ledger: OperationLedger = {
      ...baseLedger,
      getByOperationId: (id) => baseLedger.getByOperationId(id),
      getByIdempotencyKey: (key) => baseLedger.getByIdempotencyKey(key),
      listUnresolved: () => baseLedger.listUnresolved(),
      save: (receipt) => baseLedger.save(receipt),
      async createPending(receipt) {
        const created = await baseLedger.createPending(receipt)
        current = after(99)
        return created
      }
    }
    const coordinator = new OperationCoordinator({
      ledger,
      resultStore: new InMemoryOperationResultStore(),
      currentRevision: () => current,
      now: () => new Date('2026-07-29T07:00:00.000Z')
    })
    const input = { start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }
    const request = await createRequest(input)
    const transaction = { execute: vi.fn() }

    await expect(
      coordinator.execute(
        request,
        input,
        transaction,
        new AbortController().signal
      )
    ).rejects.toThrow('complete workspace revision')
    expect(transaction.execute).not.toHaveBeenCalled()
    expect(
      (await baseLedger.getByOperationId(request.operationId))?.status
    ).toBe('rolled-back')
  })

  it('keeps unknown mutations blocked and queryable', async () => {
    const input = { start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }
    const request = await createRequest(input)
    const context = setup()
    const transaction = {
      execute: vi.fn(async () => {
        throw new MutationCommitUnknownError(
          'Timed out at the CAD boundary.',
          'c'.repeat(64)
        )
      })
    }

    await expect(
      context.coordinator.execute(
        request,
        input,
        transaction,
        new AbortController().signal
      )
    ).rejects.toBeInstanceOf(OperationStatusUnknownError)

    const retry = await context.coordinator.execute(
      request,
      input,
      transaction,
      new AbortController().signal
    )
    const status = await new OperationStatusHandler(context.ledger).handle(
      request.operationId
    )
    expect(retry).toMatchObject({ duplicate: true, receipt: { status: 'unknown' } })
    expect(status.receipt?.status).toBe('unknown')
    expect(transaction.execute).toHaveBeenCalledTimes(1)

    const secondInput = { start: { x: 1, y: 1 }, end: { x: 5, y: 1 } }
    const secondRequest = await createRequest(secondInput, {
      operationId: 'operation-2',
      operationGroupId: 'group-2',
      idempotencyKey: 'idempotency-2',
      expectedRevision: {
        ...before,
        documentId: 'reopened-drawing-with-new-session-id'
      }
    })
    const secondTransaction = { execute: vi.fn() }
    await expect(
      context.coordinator.execute(
        secondRequest,
        secondInput,
        secondTransaction,
        new AbortController().signal
      )
    ).rejects.toBeInstanceOf(OperationUncertaintyBlockedError)
    expect(secondTransaction.execute).not.toHaveBeenCalled()
  })

  it('reports receipt persistence failure as committed drawing change, not unknown', async () => {
    const baseLedger = new InMemoryOperationLedger()
    const ledger: OperationLedger = {
      getByOperationId: (id) => baseLedger.getByOperationId(id),
      getByIdempotencyKey: (key) => baseLedger.getByIdempotencyKey(key),
      listUnresolved: () => baseLedger.listUnresolved(),
      createPending: (receipt) => baseLedger.createPending(receipt),
      async save(receipt: OperationReceipt) {
        if (receipt.status === 'committed') throw new Error('Injected IDB failure')
        await baseLedger.save(receipt)
      }
    }
    const input = { start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }
    const request = await createRequest(input)
    const context = setup(ledger)

    const error = await context.coordinator
      .execute(
        request,
        input,
        successfulTransaction(context.setRevision),
        new AbortController().signal
      )
      .catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(OperationPersistenceError)
    expect((error as OperationPersistenceError).drawingChanged).toBe(true)
    expect(
      (await baseLedger.getByOperationId(request.operationId))?.status
    ).toBe('pending')

    const secondInput = { start: { x: 2, y: 2 }, end: { x: 8, y: 2 } }
    const secondRequest = await createRequest(secondInput, {
      operationId: 'operation-after-persistence-failure',
      operationGroupId: 'group-after-persistence-failure',
      idempotencyKey: 'key-after-persistence-failure',
      expectedRevision: after()
    })
    const secondTransaction = { execute: vi.fn() }
    await expect(
      context.coordinator.execute(
        secondRequest,
        secondInput,
        secondTransaction,
        new AbortController().signal
      )
    ).rejects.toBeInstanceOf(OperationUncertaintyBlockedError)
    expect(secondTransaction.execute).not.toHaveBeenCalled()
  })

  it('durably replays committed results after ledger and result-store recreation', async () => {
    const indexedDb = new IDBFactory()
    const ledgerName = 'mutation-idempotency-ledger'
    const resultName = 'mutation-idempotency-results'
    const input = { start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }
    const request = await createRequest(input)
    let current = before
    const ledger = new IndexedDbOperationLedger({
      indexedDb,
      databaseName: ledgerName
    })
    const results = new IndexedDbOperationResultStore({
      indexedDb,
      databaseName: resultName
    })
    const coordinator = new OperationCoordinator({
      ledger,
      resultStore: results,
      currentRevision: () => current,
      now: () => new Date('2026-07-29T07:00:00.000Z')
    })
    const largeResult = { report: 'x'.repeat(40_000), entityIds: ['10'] }
    await coordinator.execute(
      request,
      input,
      successfulTransaction((revision) => {
        current = revision
      }, largeResult),
      new AbortController().signal
    )
    ledger.close()
    results.close()

    const reopenedLedger = new IndexedDbOperationLedger({
      indexedDb,
      databaseName: ledgerName
    })
    const reopenedResults = new IndexedDbOperationResultStore({
      indexedDb,
      databaseName: resultName
    })
    const replayTransaction = { execute: vi.fn() }
    const replay = await new OperationCoordinator({
      ledger: reopenedLedger,
      resultStore: reopenedResults,
      currentRevision: () => current,
      now: () => new Date('2026-07-29T09:00:00.000Z')
    }).execute(
      request,
      input,
      replayTransaction,
      new AbortController().signal
    )

    expect(replay.duplicate).toBe(true)
    expect(replay.result).toEqual(largeResult)
    expect(replayTransaction.execute).not.toHaveBeenCalled()
    reopenedLedger.close()
    reopenedResults.close()
  })
})
