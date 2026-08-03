import { z } from 'zod'
import {
  operationResultJsonSchema,
  operationReceiptSchema,
  operationResultReferenceSchema,
  type JsonValue,
  type OperationReceipt,
  type OperationResultReference
} from '../../../../shared/agent-contracts'
import type { EnvCadDesktopApi } from '../../../../desktop/runtimeProtocol'
import type { OperationLedger } from '../../operations/OperationLedger'
import type { OperationResultStore } from '../../operations/OperationResultStore'

const pendingResponseSchema = z.strictObject({
  receipt: operationReceiptSchema,
  created: z.boolean()
})

const storedResultSchema = z.strictObject({
  reference: operationResultReferenceSchema,
  resultHash: z.string().regex(/^[a-f0-9]{64}$/)
})

export class DesktopOperationLedger implements OperationLedger {
  constructor(private readonly api: EnvCadDesktopApi) {}

  async getByOperationId(
    operationId: string
  ): Promise<OperationReceipt | undefined> {
    return parseOptionalReceipt(await this.api.getOperationReceipt(operationId))
  }

  async getByIdempotencyKey(
    idempotencyKey: string
  ): Promise<OperationReceipt | undefined> {
    return parseOptionalReceipt(
      await this.api.getOperationReceiptByKey(idempotencyKey)
    )
  }

  async listUnresolved(): Promise<OperationReceipt[]> {
    const parsed = z
      .array(operationReceiptSchema)
      .safeParse(await this.api.listUnresolvedOperations())
    if (!parsed.success) throw invalidDesktopResponse()
    if (
      parsed.data.some(
        (receipt) =>
          receipt.status !== 'pending' && receipt.status !== 'unknown'
      )
    ) {
      throw invalidDesktopResponse()
    }
    return parsed.data
  }

  async createPending(
    receipt: OperationReceipt
  ): Promise<{ receipt: OperationReceipt; created: boolean }> {
    const parsed = pendingResponseSchema.safeParse(
      await this.api.createPendingOperation(receipt)
    )
    if (!parsed.success) throw invalidDesktopResponse()
    return parsed.data
  }

  async save(receipt: OperationReceipt): Promise<void> {
    await this.api.saveOperationReceipt(receipt)
  }
}

export class DesktopOperationResultStore implements OperationResultStore {
  constructor(private readonly api: EnvCadDesktopApi) {}

  async write(result: JsonValue): Promise<{
    reference: OperationResultReference
    resultHash: string
  }> {
    const parsed = storedResultSchema.safeParse(
      await this.api.writeOperationResult(result)
    )
    if (!parsed.success || parsed.data.reference.sha256 !== parsed.data.resultHash) {
      throw invalidDesktopResponse()
    }
    return parsed.data
  }

  async read(reference: OperationResultReference): Promise<JsonValue> {
    const parsed = operationResultJsonSchema.safeParse(
      await this.api.readOperationResult(reference)
    )
    if (!parsed.success) throw invalidDesktopResponse()
    return parsed.data
  }
}

export function createDesktopOperationStores(): {
  ledger: DesktopOperationLedger
  results: DesktopOperationResultStore
} {
  const api = window.envcadDesktop
  if (!api) throw new Error('The durable operation journal requires EnvCAD Desktop.')
  return {
    ledger: new DesktopOperationLedger(api),
    results: new DesktopOperationResultStore(api)
  }
}

function parseOptionalReceipt(value: unknown): OperationReceipt | undefined {
  if (value === undefined) return undefined
  const parsed = operationReceiptSchema.safeParse(value)
  if (!parsed.success) throw invalidDesktopResponse()
  return parsed.data
}

function invalidDesktopResponse(): Error {
  return new Error('Desktop operation journal returned an invalid response.')
}
