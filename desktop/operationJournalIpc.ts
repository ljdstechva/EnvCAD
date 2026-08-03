import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import {
  operationResultJsonSchema,
  operationReceiptSchema,
  operationResultReferenceSchema,
  type OperationReceipt
} from '../shared/agent-contracts'
import type { PersistentOperationLedger } from './agentJournal/PersistentOperationLedger'
import type { PersistentOperationResultStore } from './agentJournal/PersistentOperationResultStore'
import { DESKTOP_IPC } from './runtimeProtocol'

export interface OperationJournalIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>
  trustedSender(event: IpcMainInvokeEvent): boolean
  ledger: PersistentOperationLedger
  results: PersistentOperationResultStore
}

export function installOperationJournalIpc(
  options: OperationJournalIpcOptions
): void {
  const trusted = <T>(
    handler: (event: IpcMainInvokeEvent, value?: unknown) => Promise<T>
  ) =>
    async (event: IpcMainInvokeEvent, value?: unknown): Promise<T> => {
      if (!options.trustedSender(event)) {
        throw new Error('Untrusted renderer IPC request')
      }
      return handler(event, value)
    }

  options.ipcMain.handle(
    DESKTOP_IPC.getOperationReceipt,
    trusted(async (_event, operationId) =>
      options.ledger.getByOperationId(parseIdentifier(operationId))
    )
  )
  options.ipcMain.handle(
    DESKTOP_IPC.getOperationReceiptByKey,
    trusted(async (_event, idempotencyKey) =>
      options.ledger.getByIdempotencyKey(parseIdentifier(idempotencyKey))
    )
  )
  options.ipcMain.handle(
    DESKTOP_IPC.listUnresolvedOperations,
    trusted(async () => options.ledger.listUnresolved())
  )
  options.ipcMain.handle(
    DESKTOP_IPC.createPendingOperation,
    trusted(async (_event, receipt) =>
      options.ledger.createPending(parseReceipt(receipt))
    )
  )
  options.ipcMain.handle(
    DESKTOP_IPC.saveOperationReceipt,
    trusted(async (_event, receipt) => {
      await options.ledger.save(parseReceipt(receipt))
    })
  )
  options.ipcMain.handle(
    DESKTOP_IPC.writeOperationResult,
    trusted(async (_event, result) => {
      const parsed = operationResultJsonSchema.safeParse(result)
      if (!parsed.success) {
        throw new Error('Invalid operation result IPC payload.')
      }
      return options.results.write(parsed.data)
    })
  )
  options.ipcMain.handle(
    DESKTOP_IPC.readOperationResult,
    trusted(async (_event, reference) => {
      const parsed = operationResultReferenceSchema.safeParse(reference)
      if (!parsed.success) {
        throw new Error('Invalid operation result reference IPC payload.')
      }
      return options.results.read(parsed.data)
    })
  )
}

function parseIdentifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 200 ||
    value.trim() === ''
  ) {
    throw new Error('Invalid operation journal identifier.')
  }
  return value
}

function parseReceipt(value: unknown): OperationReceipt {
  const parsed = operationReceiptSchema.safeParse(value)
  if (!parsed.success) {
    throw new Error('Invalid operation receipt IPC payload.')
  }
  return parsed.data
}
