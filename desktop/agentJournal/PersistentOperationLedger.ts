import path from 'node:path'
import {
  assertOperationReceiptTransition,
  validateOperationReceipt,
  type OperationReceipt
} from '../../shared/agent-contracts'
import {
  appendJournalReceipt,
  loadJournal
} from './JournalFile'
import {
  cloneOptional,
  cloneReceipt,
  isUnresolved,
  replayJournalRecords,
  writeBarrierError
} from './OperationJournalState'

const ACTIVE_LEDGER_ROOTS = new Set<string>()

export interface PersistentOperationLedgerOptions {
  appendReceipt?: typeof appendJournalReceipt
}

export class PersistentOperationLedger {
  private readonly receipts = new Map<string, OperationReceipt>()
  private readonly idempotency = new Map<string, string>()
  private readonly journalPath: string
  private readonly ownershipKey: string
  private readonly appendReceipt: typeof appendJournalReceipt
  private loadPromise: Promise<void> | undefined
  private writerQueue: Promise<void> = Promise.resolve()
  private closePromise: Promise<void> | undefined
  private poisoned: Error | undefined
  private lastSequence = 0
  private closing = false
  private closed = false

  constructor(
    rootDirectory: string,
    options: PersistentOperationLedgerOptions = {}
  ) {
    const resolvedRoot = path.resolve(rootDirectory)
    this.ownershipKey =
      process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot
    if (ACTIVE_LEDGER_ROOTS.has(this.ownershipKey)) {
      throw new Error('Operation journal already has an active process owner.')
    }
    ACTIVE_LEDGER_ROOTS.add(this.ownershipKey)
    this.journalPath = path.join(
      resolvedRoot,
      'operation-receipts.jsonl'
    )
    this.appendReceipt = options.appendReceipt ?? appendJournalReceipt
  }

  getByOperationId(
    operationId: string
  ): Promise<OperationReceipt | undefined> {
    return this.read(() => cloneOptional(this.receipts.get(operationId)))
  }

  getByIdempotencyKey(
    idempotencyKey: string
  ): Promise<OperationReceipt | undefined> {
    return this.read(() => {
      const operationId = this.idempotency.get(idempotencyKey)
      return operationId
        ? cloneOptional(this.receipts.get(operationId))
        : undefined
    })
  }

  listUnresolved(): Promise<OperationReceipt[]> {
    return this.read(() =>
      [...this.receipts.values()]
        .filter(isUnresolved)
        .map(cloneReceipt)
    )
  }

  createPending(
    receipt: OperationReceipt
  ): Promise<{ receipt: OperationReceipt; created: boolean }> {
    return this.write(async () => {
      validateOperationReceipt(receipt)
      if (receipt.status !== 'pending') {
        throw new Error('Operation journal can only create pending receipts.')
      }
      const collision = this.receipts.get(receipt.operationId)
      if (collision) {
        return { receipt: cloneReceipt(collision), created: false }
      }
      const boundId = this.idempotency.get(receipt.idempotencyKey)
      if (boundId) {
        const bound = this.receipts.get(boundId)
        if (!bound) throw new Error('Idempotency binding has no receipt.')
        return { receipt: cloneReceipt(bound), created: false }
      }
      const unresolved = [...this.receipts.values()].find(isUnresolved)
      if (unresolved) throw writeBarrierError(unresolved)

      await this.append(receipt)
      this.receipts.set(receipt.operationId, cloneReceipt(receipt))
      this.idempotency.set(receipt.idempotencyKey, receipt.operationId)
      return { receipt: cloneReceipt(receipt), created: true }
    })
  }

  save(receipt: OperationReceipt): Promise<void> {
    return this.write(async () => {
      validateOperationReceipt(receipt)
      const current = this.receipts.get(receipt.operationId)
      if (!current) {
        throw new Error(`Unknown operation "${receipt.operationId}".`)
      }
      assertOperationReceiptTransition(current, receipt)
      await this.append(receipt)
      this.receipts.set(receipt.operationId, cloneReceipt(receipt))
    })
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.closing = true
      try {
        await this.writerQueue
        if (this.poisoned) throw this.poisoned
      } finally {
        this.closed = true
        ACTIVE_LEDGER_ROOTS.delete(this.ownershipKey)
      }
    })()
    return this.closePromise
  }

  private async load(): Promise<void> {
    try {
      const loaded = await loadJournal(this.journalPath)
      replayJournalRecords(loaded.records, this.receipts, this.idempotency)
      this.lastSequence = loaded.lastSequence
    } catch (error) {
      throw this.poison(error)
    }
  }

  private ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.load()
    return this.loadPromise
  }

  private read<T>(readValue: () => T): Promise<T> {
    try {
      this.assertAccepting()
    } catch (error) {
      return Promise.reject(error)
    }
    return this.writerQueue.then(async () => {
      this.assertAvailable()
      await this.ensureLoaded()
      this.assertAvailable()
      return readValue()
    })
  }

  private write<T>(operation: () => Promise<T>): Promise<T> {
    try {
      this.assertAccepting()
    } catch (error) {
      return Promise.reject(error)
    }
    const result = this.writerQueue.then(async () => {
      this.assertAvailable()
      await this.ensureLoaded()
      this.assertAvailable()
      return operation()
    })
    this.writerQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async append(receipt: OperationReceipt): Promise<void> {
    const sequence = this.lastSequence + 1
    try {
      await this.appendReceipt(this.journalPath, sequence, receipt)
    } catch (error) {
      throw this.poison(error)
    }
    this.lastSequence = sequence
  }

  private assertAvailable(): void {
    if (this.poisoned) throw this.poisoned
    if (this.closed) throw new Error('Operation journal is closed.')
  }

  private assertAccepting(): void {
    this.assertAvailable()
    if (this.closing) throw new Error('Operation journal is closing.')
  }

  private poison(error: unknown): Error {
    this.poisoned ??=
      error instanceof Error
        ? error
        : new Error('Operation journal entered an uncertain state.')
    return this.poisoned
  }
}
