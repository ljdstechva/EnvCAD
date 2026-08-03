import type { OperationReceipt } from '../../../../shared/agent-contracts'
import type { OperationLedger } from '../../operations/OperationLedger'
import {
  assertOperationReceiptTransition,
  validateOperationReceipt
} from '../../../../shared/agent-contracts'
import {
  cloneOperationReceipt,
  OperationUncertaintyBlockedError
} from '../../operations/OperationReceipt'

const RECEIPTS_STORE = 'receipts'
const IDEMPOTENCY_STORE = 'idempotency'

interface IdempotencyRecord {
  idempotencyKey: string
  operationId: string
}

export interface IndexedDbOperationLedgerOptions {
  databaseName?: string
  indexedDb?: IDBFactory
}

const requestValue = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB request failed.'))
  })

const transactionComplete = (
  transaction: IDBTransaction
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted.'))
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed.'))
  })

export class IndexedDbOperationLedger implements OperationLedger {
  private readonly indexedDb: IDBFactory
  private readonly databaseName: string
  private databasePromise: Promise<IDBDatabase> | undefined

  constructor(options: IndexedDbOperationLedgerOptions = {}) {
    if (!options.indexedDb && !globalThis.indexedDB) {
      throw new Error('IndexedDB is required for the durable operation ledger.')
    }
    this.indexedDb = options.indexedDb ?? globalThis.indexedDB
    this.databaseName = options.databaseName ?? 'envcad-operation-ledger-v2'
  }

  async getByOperationId(
    operationId: string
  ): Promise<OperationReceipt | undefined> {
    const database = await this.open()
    const transaction = database.transaction(RECEIPTS_STORE, 'readonly')
    const receipt = await requestValue<OperationReceipt | undefined>(
      transaction.objectStore(RECEIPTS_STORE).get(operationId)
    )
    await transactionComplete(transaction)
    if (!receipt) return undefined
    validateOperationReceipt(receipt)
    return cloneOperationReceipt(receipt)
  }

  async getByIdempotencyKey(
    idempotencyKey: string
  ): Promise<OperationReceipt | undefined> {
    const database = await this.open()
    const transaction = database.transaction(
      [IDEMPOTENCY_STORE, RECEIPTS_STORE],
      'readonly'
    )
    const binding = await requestValue<IdempotencyRecord | undefined>(
      transaction.objectStore(IDEMPOTENCY_STORE).get(idempotencyKey)
    )
    const receipt = binding
      ? await requestValue<OperationReceipt | undefined>(
          transaction.objectStore(RECEIPTS_STORE).get(binding.operationId)
        )
      : undefined
    await transactionComplete(transaction)
    if (binding && !receipt) {
      throw new Error('Durable idempotency binding has no operation receipt.')
    }
    if (!receipt) return undefined
    validateOperationReceipt(receipt)
    return cloneOperationReceipt(receipt)
  }

  async listUnresolved(): Promise<OperationReceipt[]> {
    const database = await this.open()
    const transaction = database.transaction(RECEIPTS_STORE, 'readonly')
    const receipts = await requestValue<OperationReceipt[]>(
      transaction.objectStore(RECEIPTS_STORE).getAll()
    )
    await transactionComplete(transaction)
    receipts.forEach(validateOperationReceipt)
    const unresolved = receipts.filter(
      (receipt) => receipt.status === 'pending' || receipt.status === 'unknown'
    )
    return unresolved.map(cloneOperationReceipt)
  }

  async createPending(
    receipt: OperationReceipt
  ): Promise<{ receipt: OperationReceipt; created: boolean }> {
    validateOperationReceipt(receipt)
    if (receipt.status !== 'pending') {
      throw new Error('OperationLedger can only create pending receipts.')
    }
    const database = await this.open()
    const transaction = database.transaction(
      [IDEMPOTENCY_STORE, RECEIPTS_STORE],
      'readwrite'
    )
    try {
      const receipts = transaction.objectStore(RECEIPTS_STORE)
      const idempotency = transaction.objectStore(IDEMPOTENCY_STORE)
      const [operationCollision, binding] = await Promise.all([
        requestValue<OperationReceipt | undefined>(
          receipts.get(receipt.operationId)
        ),
        requestValue<IdempotencyRecord | undefined>(
          idempotency.get(receipt.idempotencyKey)
        )
      ])
      if (operationCollision) {
        validateOperationReceipt(operationCollision)
        await transactionComplete(transaction)
        return {
          receipt: cloneOperationReceipt(operationCollision),
          created: false
        }
      }
      if (binding) {
        const existing = await requestValue<OperationReceipt | undefined>(
          receipts.get(binding.operationId)
        )
        if (!existing) throw new Error('Idempotency binding has no receipt.')
        validateOperationReceipt(existing)
        await transactionComplete(transaction)
        return { receipt: cloneOperationReceipt(existing), created: false }
      }
      const allReceipts = await requestValue<OperationReceipt[]>(
        receipts.getAll()
      )
      allReceipts.forEach(validateOperationReceipt)
      const unresolved = allReceipts.find(
        (candidate) =>
          candidate.status === 'pending' || candidate.status === 'unknown'
      )
      if (unresolved) {
        throw new OperationUncertaintyBlockedError(unresolved)
      }
      receipts.add(cloneOperationReceipt(receipt))
      idempotency.add({
        idempotencyKey: receipt.idempotencyKey,
        operationId: receipt.operationId
      } satisfies IdempotencyRecord)
      await transactionComplete(transaction)
      return { receipt: cloneOperationReceipt(receipt), created: true }
    } catch (error) {
      try {
        transaction.abort()
      } catch {
        // The transaction may already be aborted; the original error is authoritative.
      }
      throw error
    }
  }

  async save(receipt: OperationReceipt): Promise<void> {
    validateOperationReceipt(receipt)
    const database = await this.open()
    const transaction = database.transaction(RECEIPTS_STORE, 'readwrite')
    try {
      const store = transaction.objectStore(RECEIPTS_STORE)
      const current = await requestValue<OperationReceipt | undefined>(
        store.get(receipt.operationId)
      )
      if (!current) throw new Error(`Unknown operation "${receipt.operationId}".`)
      assertOperationReceiptTransition(current, receipt)
      store.put(cloneOperationReceipt(receipt))
      await transactionComplete(transaction)
    } catch (error) {
      try {
        transaction.abort()
      } catch {
        // The transaction may already be aborted; the original error is authoritative.
      }
      throw error
    }
  }

  close(): void {
    void this.databasePromise?.then((database) => database.close())
    this.databasePromise = undefined
  }

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise
    this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.indexedDb.open(this.databaseName, 1)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains(RECEIPTS_STORE)) {
          database.createObjectStore(RECEIPTS_STORE, {
            keyPath: 'operationId'
          })
        }
        if (!database.objectStoreNames.contains(IDEMPOTENCY_STORE)) {
          database.createObjectStore(IDEMPOTENCY_STORE, {
            keyPath: 'idempotencyKey'
          })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () =>
        reject(request.error ?? new Error('Could not open operation ledger.'))
      request.onblocked = () =>
        reject(new Error('Operation ledger upgrade is blocked.'))
    })
    return this.databasePromise
  }
}
