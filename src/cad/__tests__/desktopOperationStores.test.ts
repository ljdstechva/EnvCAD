import { describe, expect, it, vi } from 'vitest'
import type { EnvCadDesktopApi } from '../../../desktop/runtimeProtocol'
import type { OperationReceipt } from '../../../shared/agent-contracts'
import {
  DesktopOperationLedger,
  DesktopOperationResultStore
} from '../infrastructure/storage/DesktopOperationStores'

const receipt = (status: OperationReceipt['status'] = 'pending'): OperationReceipt => ({
  operationId: 'operation-desktop-1',
  operationGroupId: 'group-desktop-1',
  idempotencyKey: 'key-desktop-1',
  toolName: 'draw_line',
  argumentsHash: 'a'.repeat(64),
  status,
  revisionBefore: {
    documentId: 'drawing-desktop-1',
    documentRevision: 1,
    contentRevision: 0,
    sheetRevision: 0,
    viewRevision: 0
  },
  affectedEntityIds: []
})

describe('desktop operation store adapters', () => {
  it('rejects malformed and semantically invalid ledger responses', async () => {
    const api = {
      getOperationReceipt: vi.fn(async () => ({
        ...receipt(),
        unexpected: true
      })),
      listUnresolvedOperations: vi.fn(async () => [
        {
          ...receipt('rolled-back'),
          failureCode: 'rolled-back'
        }
      ])
    } as unknown as EnvCadDesktopApi
    const ledger = new DesktopOperationLedger(api)

    await expect(
      ledger.getByOperationId('operation-desktop-1')
    ).rejects.toThrow('invalid response')
    await expect(ledger.listUnresolved()).rejects.toThrow('invalid response')
  })

  it('rejects mismatched result digests and oversized replay JSON', async () => {
    const api = {
      writeOperationResult: vi.fn(async () => ({
        reference: {
          kind: 'inline-json',
          sha256: 'a'.repeat(64),
          byteLength: 4,
          json: 'null'
        },
        resultHash: 'b'.repeat(64)
      })),
      readOperationResult: vi.fn(async () => 'x'.repeat(2_000_001))
    } as unknown as EnvCadDesktopApi
    const results = new DesktopOperationResultStore(api)

    await expect(results.write(null)).rejects.toThrow('invalid response')
    await expect(
      results.read({
        kind: 'inline-json',
        sha256: 'a'.repeat(64),
        byteLength: 4,
        json: 'null'
      })
    ).rejects.toThrow('invalid response')
  })
})
