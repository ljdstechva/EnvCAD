import { describe, expect, it, vi } from 'vitest'
import type {
  CadOperationRequest,
  JsonValue,
  WorkspaceRevision
} from '../../../shared/agent-contracts'
import { CadMutationExecutor } from '../operations/CadMutationExecutor'
import { OperationCoordinator } from '../operations/OperationCoordinator'
import { InMemoryOperationLedger } from '../operations/OperationLedger'
import { InMemoryOperationResultStore } from '../operations/OperationResultStore'
import { hashOperationArguments } from '../operations/OperationReceipt'

const before: WorkspaceRevision = {
  documentId: 'drawing-1',
  documentRevision: 1,
  contentRevision: 2,
  sheetRevision: 0,
  viewRevision: 0
}

const after: WorkspaceRevision = {
  ...before,
  contentRevision: 3
}

async function request(input: JsonValue): Promise<CadOperationRequest> {
  return {
    turnId: 'turn-1',
    operationId: 'operation-1',
    operationGroupId: 'group-1',
    idempotencyKey: 'idempotency-1',
    toolName: 'draw_line',
    argumentsHash: await hashOperationArguments('draw_line', input),
    expectedRevision: before,
    deadline: '2026-07-29T09:00:00.000Z'
  }
}

function fixture() {
  let revision = before
  const ledger = new InMemoryOperationLedger()
  const coordinator = new OperationCoordinator({
    ledger,
    resultStore: new InMemoryOperationResultStore(),
    currentRevision: () => revision,
    now: () => new Date('2026-07-29T08:00:00.000Z')
  })
  return {
    ledger,
    executor: new CadMutationExecutor({
      coordinator,
      currentRevision: () => revision
    }),
    setRevision(next: WorkspaceRevision) {
      revision = next
    }
  }
}

describe('live CAD mutation transaction adapter', () => {
  it('persists pending, commits revision evidence, and replays without invoking the handler twice', async () => {
    const input = { start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }
    const operation = await request(input)
    const context = fixture()
    const handler = vi.fn(async () => {
      expect(
        (await context.ledger.getByOperationId(operation.operationId))?.status
      ).toBe('pending')
      context.setRevision(after)
      return { data: { entityIds: ['line-1'], length: 10 } }
    })

    const first = await context.executor.execute(
      operation,
      input,
      handler,
      new AbortController().signal
    )
    const replay = await context.executor.execute(
      operation,
      input,
      handler,
      new AbortController().signal
    )

    expect(first).toMatchObject({
      receipt: {
        status: 'committed',
        revisionBefore: before,
        revisionAfter: after,
        affectedEntityIds: ['line-1']
      },
      result: { data: { entityIds: ['line-1'], length: 10 } }
    })
    expect(replay).toMatchObject({
      receipt: { status: 'committed' },
      result: { data: { entityIds: ['line-1'], length: 10 } }
    })
    expect(handler).toHaveBeenCalledOnce()
  })

  it('marks an error after a revision change unknown and blocks automatic replay', async () => {
    const input = { start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }
    const operation = await request(input)
    const context = fixture()
    const handler = vi.fn(async () => {
      context.setRevision(after)
      return { error: 'Injected post-mutation handler failure.' }
    })

    const first = await context.executor.execute(
      operation,
      input,
      handler,
      new AbortController().signal
    )
    const retry = await context.executor.execute(
      operation,
      input,
      handler,
      new AbortController().signal
    )

    expect(first).toMatchObject({
      receipt: { status: 'unknown' },
      result: {
        error: expect.stringContaining('will not repeat an uncertain mutation')
      }
    })
    expect(retry).toMatchObject({
      receipt: { status: 'unknown' },
      result: {
        error: expect.stringContaining('will not repeat it automatically')
      }
    })
    expect(handler).toHaveBeenCalledOnce()
  })

  it('records cancellation before handler execution as a terminal operation receipt', async () => {
    const input = { start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }
    const operation = await request(input)
    const context = fixture()
    const handler = vi.fn()
    const controller = new AbortController()
    controller.abort()

    const result = await context.executor.execute(
      operation,
      input,
      handler,
      controller.signal
    )

    expect(result).toMatchObject({
      receipt: { status: 'cancelled' },
      result: {
        error: expect.stringContaining('cancelled')
      }
    })
    expect(handler).not.toHaveBeenCalled()
  })
})
