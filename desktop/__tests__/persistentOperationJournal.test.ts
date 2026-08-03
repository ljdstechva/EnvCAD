import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  OperationReceipt,
  WorkspaceRevision
} from '../../shared/agent-contracts'
import {
  appendJournalReceipt,
  JournalCorruptionError
} from '../agentJournal/JournalFile'
import { PersistentOperationLedger } from '../agentJournal/PersistentOperationLedger'
import { PersistentOperationResultStore } from '../agentJournal/PersistentOperationResultStore'

const roots: string[] = []

const revision = (
  documentId = 'drawing-before-restart',
  contentRevision = 1
): WorkspaceRevision => ({
  documentId,
  documentRevision: 1,
  contentRevision,
  sheetRevision: 0,
  viewRevision: 0
})

const pendingReceipt = (
  operationId = 'operation-1',
  idempotencyKey = 'idempotency-1',
  documentId = 'drawing-before-restart'
): OperationReceipt => ({
  operationId,
  operationGroupId: `group-${operationId}`,
  idempotencyKey,
  toolName: 'draw_line',
  argumentsHash: 'a'.repeat(64),
  status: 'pending',
  revisionBefore: revision(documentId),
  affectedEntityIds: []
})

const committedReceipt = (
  pending: OperationReceipt
): OperationReceipt => {
  const json = JSON.stringify({ entityIds: ['line-1'] })
  const resultHash = createHash('sha256').update(json).digest('hex')
  return {
    ...pending,
    status: 'committed',
    revisionAfter: revision(pending.revisionBefore.documentId, 2),
    affectedEntityIds: ['line-1'],
    resultHash,
    resultReference: {
      kind: 'inline-json',
      sha256: resultHash,
      byteLength: Buffer.byteLength(json, 'utf8'),
      json
    },
    reconciliationFingerprint: 'b'.repeat(64),
    committedAt: '2026-07-29T08:00:00.000Z'
  }
}

async function journalRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'envcad-agent-journal-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('PersistentOperationLedger desktop restart boundary', () => {
  it('reopens a synced pending receipt and keeps the global write barrier', async () => {
    const root = await journalRoot()
    const first = new PersistentOperationLedger(root)
    await first.createPending(pendingReceipt())
    await first.close()

    const reopened = new PersistentOperationLedger(root)
    await expect(reopened.listUnresolved()).resolves.toMatchObject([
      { operationId: 'operation-1', status: 'pending' }
    ])
    await expect(
      reopened.createPending(
        pendingReceipt(
          'operation-after-restart',
          'idempotency-after-restart',
          'new-session-document-id'
        )
      )
    ).rejects.toThrow('CAD writes are blocked')
    await reopened.close()
  })

  it('replays committed content after ledger and result-store recreation', async () => {
    const root = await journalRoot()
    const resultRoot = path.join(root, 'results')
    const result = {
      entityIds: ['line-10'],
      report: 'é'.repeat(40_000)
    }
    const results = new PersistentOperationResultStore(resultRoot)
    const stored = await results.write(result)
    const ledger = new PersistentOperationLedger(root)
    const pending = pendingReceipt()
    await ledger.createPending(pending)
    await ledger.save({
      ...pending,
      status: 'committed',
      revisionAfter: revision('drawing-before-restart', 2),
      affectedEntityIds: ['line-10'],
      resultHash: stored.resultHash,
      resultReference: stored.reference,
      reconciliationFingerprint: 'b'.repeat(64),
      committedAt: '2026-07-29T08:00:00.000Z'
    })
    await ledger.close()

    const reopenedLedger = new PersistentOperationLedger(root)
    const reopenedResults = new PersistentOperationResultStore(resultRoot)
    const receipt = await reopenedLedger.getByOperationId('operation-1')
    if (!receipt?.resultReference) throw new Error('missing replay reference')
    await expect(reopenedResults.read(receipt.resultReference)).resolves.toEqual(
      result
    )
    await reopenedLedger.close()
  })

  it('fails closed on a partial or corrupt restart record', async () => {
    const root = await journalRoot()
    const ledger = new PersistentOperationLedger(root)
    await ledger.createPending(pendingReceipt())
    await ledger.close()
    await appendFile(
      path.join(root, 'operation-receipts.jsonl'),
      '{"version":1,"sequence":2'
    )

    const reopened = new PersistentOperationLedger(root)
    await expect(reopened.listUnresolved()).rejects.toBeInstanceOf(
      JournalCorruptionError
    )
    await expect(
      reopened.createPending(
        pendingReceipt('operation-2', 'idempotency-2')
      )
    ).rejects.toBeInstanceOf(JournalCorruptionError)
    await reopened.close().catch(() => undefined)
  })

  it('fails closed when valid records contain a second unresolved pending operation', async () => {
    const root = await journalRoot()
    const journal = path.join(root, 'operation-receipts.jsonl')
    await appendJournalReceipt(journal, 1, pendingReceipt())
    await appendJournalReceipt(
      journal,
      2,
      pendingReceipt('operation-2', 'idempotency-2')
    )

    const reopened = new PersistentOperationLedger(root)
    await expect(reopened.listUnresolved()).rejects.toThrow(
      'begins while operation-1 is unresolved'
    )
    await reopened.close().catch(() => undefined)
  })

  it('fails closed when a valid idempotency key is rebound after terminal completion', async () => {
    const root = await journalRoot()
    const journal = path.join(root, 'operation-receipts.jsonl')
    const first = pendingReceipt()
    await appendJournalReceipt(journal, 1, first)
    await appendJournalReceipt(journal, 2, committedReceipt(first))
    await appendJournalReceipt(
      journal,
      3,
      pendingReceipt('operation-2', first.idempotencyKey)
    )

    const reopened = new PersistentOperationLedger(root)
    await expect(reopened.listUnresolved()).rejects.toThrow(
      'idempotency key is bound to multiple operations'
    )
    await reopened.close().catch(() => undefined)
  })

  it('fails closed when valid records contain an illegal terminal status transition', async () => {
    const root = await journalRoot()
    const journal = path.join(root, 'operation-receipts.jsonl')
    const pending = pendingReceipt()
    await appendJournalReceipt(journal, 1, pending)
    await appendJournalReceipt(journal, 2, committedReceipt(pending))
    await appendJournalReceipt(journal, 3, {
      ...pending,
      status: 'rolled-back'
    })

    const reopened = new PersistentOperationLedger(root)
    await expect(reopened.listUnresolved()).rejects.toThrow(
      'Invalid operation transition from "committed" to "rolled-back"'
    )
    await reopened.close().catch(() => undefined)
  })

  it('fails closed when a complete journal record has a checksum mismatch', async () => {
    const root = await journalRoot()
    await appendFile(
      path.join(root, 'operation-receipts.jsonl'),
      `${JSON.stringify({
        version: 1,
        sequence: 1,
        receipt: pendingReceipt(),
        checksum: '0'.repeat(64)
      })}\n`,
      'utf8'
    )

    const reopened = new PersistentOperationLedger(root)
    await expect(reopened.listUnresolved()).rejects.toThrow(
      'record checksum does not match'
    )
    await reopened.close().catch(() => undefined)
  })

  it('poisons the owner after a lost append acknowledgement', async () => {
    const root = await journalRoot()
    let appendCalls = 0
    const ledger = new PersistentOperationLedger(root, {
      async appendReceipt(...arguments_) {
        appendCalls += 1
        await appendJournalReceipt(...arguments_)
        throw new Error('Injected failure after the synced append.')
      }
    })

    await expect(
      ledger.createPending(pendingReceipt())
    ).rejects.toThrow('Injected failure')
    await expect(ledger.listUnresolved()).rejects.toThrow('Injected failure')
    await expect(
      ledger.createPending(
        pendingReceipt('operation-2', 'idempotency-2')
      )
    ).rejects.toThrow('Injected failure')
    expect(appendCalls).toBe(1)
    await expect(ledger.close()).rejects.toThrow('Injected failure')

    const recovered = new PersistentOperationLedger(root)
    await expect(recovered.listUnresolved()).resolves.toMatchObject([
      { operationId: 'operation-1', status: 'pending' }
    ])
    await recovered.close()
  })

  it('drains an already-enqueued receipt append during graceful close', async () => {
    const root = await journalRoot()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const ledger = new PersistentOperationLedger(root, {
      async appendReceipt(...arguments_) {
        await gate
        await appendJournalReceipt(...arguments_)
      }
    })

    const pending = ledger.createPending(pendingReceipt())
    const closing = ledger.close()
    await expect(
      ledger.createPending(pendingReceipt('operation-2', 'idempotency-2'))
    ).rejects.toThrow('closing')
    release()
    await expect(pending).resolves.toMatchObject({ created: true })
    await expect(closing).resolves.toBeUndefined()

    const reopened = new PersistentOperationLedger(root)
    await expect(reopened.listUnresolved()).resolves.toMatchObject([
      { operationId: 'operation-1' }
    ])
    await reopened.close()
  })
})
