import type {
  JsonValue,
  OperationResultReference
} from '../../../../shared/agent-contracts'
import {
  hashOperationResultBytes,
  type OperationResultStore
} from '../../operations/OperationResultStore'

const RESULTS_STORE = 'results'

interface StoredOperationResult {
  contentId: string
  sha256: string
  byteLength: number
  bytes: ArrayBuffer
}

export interface IndexedDbOperationResultStoreOptions {
  databaseName?: string
  indexedDb?: IDBFactory
}

const requestValue = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB result request failed.'))
  })

const transactionComplete = (
  transaction: IDBTransaction
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('Result transaction aborted.'))
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Result transaction failed.'))
  })

export class IndexedDbOperationResultStore implements OperationResultStore {
  private readonly indexedDb: IDBFactory
  private readonly databaseName: string
  private databasePromise: Promise<IDBDatabase> | undefined

  constructor(options: IndexedDbOperationResultStoreOptions = {}) {
    if (!options.indexedDb && !globalThis.indexedDB) {
      throw new Error('IndexedDB is required for durable operation results.')
    }
    this.indexedDb = options.indexedDb ?? globalThis.indexedDB
    this.databaseName = options.databaseName ?? 'envcad-operation-results-v2'
  }

  async write(result: JsonValue): Promise<{
    reference: OperationResultReference
    resultHash: string
  }> {
    const json = JSON.stringify(result)
    const bytes = new TextEncoder().encode(json)
    const resultHash = await hashOperationResultBytes(bytes)
    if (bytes.byteLength <= 32_000) {
      return {
        reference: {
          kind: 'inline-json',
          sha256: resultHash,
          byteLength: bytes.byteLength,
          json
        },
        resultHash
      }
    }
    const contentId = `operation-result-${resultHash}`
    const database = await this.open()
    const transaction = database.transaction(RESULTS_STORE, 'readwrite')
    transaction.objectStore(RESULTS_STORE).put({
      contentId,
      sha256: resultHash,
      byteLength: bytes.byteLength,
      bytes: Uint8Array.from(bytes).buffer
    } satisfies StoredOperationResult)
    await transactionComplete(transaction)
    return {
      reference: {
        kind: 'content-store',
        sha256: resultHash,
        byteLength: bytes.byteLength,
        contentId
      },
      resultHash
    }
  }

  async read(reference: OperationResultReference): Promise<JsonValue> {
    if (reference.kind === 'inline-json') {
      return this.parseVerified(reference, new TextEncoder().encode(reference.json))
    }
    const database = await this.open()
    const transaction = database.transaction(RESULTS_STORE, 'readonly')
    const stored = await requestValue<StoredOperationResult | undefined>(
      transaction.objectStore(RESULTS_STORE).get(reference.contentId)
    )
    await transactionComplete(transaction)
    if (!stored) throw new Error('Durable operation replay content is unavailable.')
    return this.parseVerified(reference, new Uint8Array(stored.bytes))
  }

  close(): void {
    void this.databasePromise?.then((database) => database.close())
    this.databasePromise = undefined
  }

  private async parseVerified(
    reference: OperationResultReference,
    bytes: Uint8Array
  ): Promise<JsonValue> {
    if (bytes.byteLength !== reference.byteLength) {
      throw new Error('Operation replay content length does not match its receipt.')
    }
    if ((await hashOperationResultBytes(bytes)) !== reference.sha256) {
      throw new Error('Operation replay content digest does not match its receipt.')
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as JsonValue
  }

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise
    this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.indexedDb.open(this.databaseName, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(RESULTS_STORE)) {
          request.result.createObjectStore(RESULTS_STORE, {
            keyPath: 'contentId'
          })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () =>
        reject(request.error ?? new Error('Could not open operation results.'))
      request.onblocked = () =>
        reject(new Error('Operation result store upgrade is blocked.'))
    })
    return this.databasePromise
  }
}
