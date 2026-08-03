import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it } from 'vitest'
import type { OperationReceipt } from '../../shared/agent-contracts'
import { PersistentOperationLedger } from '../agentJournal/PersistentOperationLedger'
import { PersistentOperationResultStore } from '../agentJournal/PersistentOperationResultStore'
import {
  installOperationJournalIpc,
  type OperationJournalIpcOptions
} from '../operationJournalIpc'
import { DESKTOP_IPC } from '../runtimeProtocol'

type Handler = (
  event: IpcMainInvokeEvent,
  value?: unknown
) => Promise<unknown>

const roots: string[] = []

async function rootDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'envcad-journal-ipc-'))
  roots.push(root)
  return root
}

const pending: OperationReceipt = {
  operationId: 'operation-ipc-1',
  operationGroupId: 'group-ipc-1',
  idempotencyKey: 'key-ipc-1',
  toolName: 'draw_line',
  argumentsHash: 'a'.repeat(64),
  status: 'pending',
  revisionBefore: {
    documentId: 'drawing-ipc-1',
    documentRevision: 1,
    contentRevision: 0,
    sheetRevision: 0,
    viewRevision: 0
  },
  affectedEntityIds: []
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('operation journal IPC', () => {
  it('exposes only strict sender-checked journal operations', async () => {
    const root = await rootDirectory()
    const ledger = new PersistentOperationLedger(root)
    const results = new PersistentOperationResultStore(
      path.join(root, 'results')
    )
    const handlers = new Map<string, Handler>()
    const trustedEvent = { sender: 'trusted' } as unknown as IpcMainInvokeEvent
    const untrustedEvent = { sender: 'other' } as unknown as IpcMainInvokeEvent
    const ipcMain = {
      handle(channel: string, handler: Handler) {
        handlers.set(channel, handler)
      }
    }
    installOperationJournalIpc({
      ipcMain,
      trustedSender: (event) => event === trustedEvent,
      ledger,
      results
    } as OperationJournalIpcOptions)

    const create = handlers.get(DESKTOP_IPC.createPendingOperation)
    const list = handlers.get(DESKTOP_IPC.listUnresolvedOperations)
    const writeResult = handlers.get(DESKTOP_IPC.writeOperationResult)
    const readResult = handlers.get(DESKTOP_IPC.readOperationResult)
    if (!create || !list || !writeResult || !readResult) {
      throw new Error('operation IPC handlers were not installed')
    }

    await expect(create(untrustedEvent, pending)).rejects.toThrow(
      'Untrusted renderer'
    )
    await expect(create(trustedEvent, { ...pending, extra: true })).rejects.toThrow(
      'Invalid operation receipt'
    )
    await expect(create(trustedEvent, pending)).resolves.toMatchObject({
      created: true,
      receipt: { status: 'pending' }
    })
    await expect(list(trustedEvent)).resolves.toMatchObject([
      { operationId: 'operation-ipc-1', status: 'pending' }
    ])

    const stored = (await writeResult(trustedEvent, {
      report: 'x'.repeat(40_000)
    })) as {
      reference: unknown
    }
    await expect(readResult(trustedEvent, stored.reference)).resolves.toEqual({
      report: 'x'.repeat(40_000)
    })
    await ledger.close()
  })
})
