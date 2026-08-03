import type { OperationReceipt } from '../../../shared/agent-contracts'
import type { IdempotencyStore } from './IdempotencyStore'
import { InMemoryIdempotencyStore } from './IdempotencyStore'
import { cloneOperationReceipt } from './OperationReceipt'
import {
  assertOperationReceiptTransition,
  validateOperationReceipt
} from '../../../shared/agent-contracts'
import { OperationUncertaintyBlockedError } from './OperationReceipt'

export interface OperationLedger {
  getByOperationId(operationId: string): Promise<OperationReceipt | undefined>
  getByIdempotencyKey(
    idempotencyKey: string
  ): Promise<OperationReceipt | undefined>
  listUnresolved(): Promise<OperationReceipt[]>
  createPending(
    receipt: OperationReceipt
  ): Promise<{ receipt: OperationReceipt; created: boolean }>
  save(receipt: OperationReceipt): Promise<void>
}

export class InMemoryOperationLedger implements OperationLedger {
  private readonly receipts = new Map<string, OperationReceipt>()

  constructor(
    private readonly idempotency: IdempotencyStore =
      new InMemoryIdempotencyStore()
  ) {}

  async getByOperationId(
    operationId: string
  ): Promise<OperationReceipt | undefined> {
    const receipt = this.receipts.get(operationId)
    return receipt ? cloneOperationReceipt(receipt) : undefined
  }

  async getByIdempotencyKey(
    idempotencyKey: string
  ): Promise<OperationReceipt | undefined> {
    const operationId = await this.idempotency.getOperationId(idempotencyKey)
    return operationId ? this.getByOperationId(operationId) : undefined
  }

  async listUnresolved(): Promise<OperationReceipt[]> {
    return [...this.receipts.values()]
      .filter(
        (receipt) =>
          (receipt.status === 'pending' || receipt.status === 'unknown')
      )
      .map(cloneOperationReceipt)
  }

  async createPending(
    receipt: OperationReceipt
  ): Promise<{ receipt: OperationReceipt; created: boolean }> {
    validateOperationReceipt(receipt)
    if (receipt.status !== 'pending') {
      throw new Error('OperationLedger can only create pending receipts.')
    }
    const operationCollision = this.receipts.get(receipt.operationId)
    if (operationCollision) {
      return { receipt: cloneOperationReceipt(operationCollision), created: false }
    }
    const existingOperationId = await this.idempotency.getOperationId(
      receipt.idempotencyKey
    )
    if (existingOperationId) {
      const existing = await this.getByOperationId(existingOperationId)
      if (!existing) {
        throw new Error('Idempotency binding has no operation receipt.')
      }
      return { receipt: existing, created: false }
    }
    const unresolved = await this.listUnresolved()
    if (unresolved.length > 0) {
      throw new OperationUncertaintyBlockedError(unresolved[0])
    }
    const binding = await this.idempotency.bind(
      receipt.idempotencyKey,
      receipt.operationId
    )
    if (!binding.created) {
      const existing = await this.getByOperationId(binding.operationId)
      if (!existing) {
        throw new Error('Idempotency binding has no operation receipt.')
      }
      return { receipt: existing, created: false }
    }
    this.receipts.set(receipt.operationId, cloneOperationReceipt(receipt))
    return { receipt: cloneOperationReceipt(receipt), created: true }
  }

  async save(receipt: OperationReceipt): Promise<void> {
    validateOperationReceipt(receipt)
    const current = this.receipts.get(receipt.operationId)
    if (!current) throw new Error(`Unknown operation "${receipt.operationId}".`)
    assertOperationReceiptTransition(current, receipt)
    this.receipts.set(receipt.operationId, cloneOperationReceipt(receipt))
  }
}
