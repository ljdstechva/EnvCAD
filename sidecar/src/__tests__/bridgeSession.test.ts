import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROTOCOL_VERSION,
  type AgentServerEnvelope,
  type TurnJournalPort
} from '../../../shared/agent-contracts'
import type {
  AgentConfiguration,
  ServerMessage
} from '../../../src/agent/protocol'
import { ENVCAD_TURN_REVISION_FIELD } from '../../../src/agent/protocol'
import { PersistentTurnJournal } from '../../../desktop/agentJournal/PersistentTurnJournal'
import { BridgeSession, buildTurnPrompt } from '../bridgeSession'
import { LocalInputStore } from '../application/input/LocalInputStore'
import { InputRetrievalService } from '../application/input/InputRetrievalService'
import { ProviderManager } from '../providers/providerManager'
import { FakeProvider } from './fakeProviders'

class FakeWebSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN
  sent: string[] = []

  send(data: string): void {
    this.sent.push(String(data))
  }

  disconnect(): void {
    this.readyState = WebSocket.CLOSED
    this.emit('close')
  }
}

function decodedMessages(ws: FakeWebSocket): ServerMessage[] {
  return ws.sent.map((message) => JSON.parse(message) as ServerMessage)
}

function durableEvents(ws: FakeWebSocket): AgentServerEnvelope[] {
  return ws.sent
    .map((message) => JSON.parse(message) as unknown)
    .filter(
      (message): message is AgentServerEnvelope =>
        typeof message === 'object' &&
        message !== null &&
        'protocolVersion' in message
    )
}

function logger() {
  return { log: vi.fn(), error: vi.fn() }
}

function sessionFixture(
  turnJournal?: TurnJournalPort,
  options: {
    toolTimeoutMs?: number
    inputStore?: LocalInputStore
    inputRetrieval?: InputRetrievalService
  } = {}
) {
  const ws = new FakeWebSocket()
  const claude = new FakeProvider('claude-code')
  const codex = new FakeProvider('openai-codex')
  const manager = new ProviderManager([claude, codex], logger())
  const session = new BridgeSession(ws as unknown as WebSocket, {
    providerManager: manager,
    ...(turnJournal ? { turnJournal } : {}),
    ...(options.inputStore ? { inputStore: options.inputStore } : {}),
    ...(options.inputRetrieval
      ? { inputRetrieval: options.inputRetrieval }
      : {}),
    ...(options.toolTimeoutMs !== undefined
      ? { toolTimeoutMs: options.toolTimeoutMs }
      : {}),
    logger: logger()
  })
  return { ws, claude, codex, manager, session }
}

function send(ws: FakeWebSocket, value: unknown): void {
  ws.emit('message', JSON.stringify(value))
}

function configuration(
  provider: 'claude-code' | 'openai-codex' = 'claude-code'
): AgentConfiguration {
  return provider === 'claude-code'
    ? { provider, model: 'claude-default', effort: 'high' }
    : { provider, model: 'codex-default', effort: 'low' }
}

function userMessage(revision = 1) {
  return {
    type: 'user_message',
    text: 'draw a line',
    configurationRevision: revision,
    selectionSnapshot: {
      count: 0,
      units: 'Meters',
      revision: { documentRevision: 7, contentRevision: 3 }
    },
    sheet: {
      paper: 'A3',
      orientation: 'landscape' as const,
      scaleDenominator: 500,
      drawingUnit: 'm'
    }
  }
}

function durableSubmit(sequence = 1) {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    sessionId: 'renderer-session-1',
    messageId: 'renderer-message-1',
    turnId: 'renderer-turn-1',
    sequence,
    timestamp: '2026-07-29T08:00:00.000Z',
    payload: {
      type: 'submit_turn',
      text: 'inspect the active drawing',
      referenceInputIds: [],
      configurationRevision: 1,
      selectionSnapshot: {
        count: 0,
        units: 'Meters',
        revision: {
          documentId: 'drawing-live-1',
          documentRevision: 7,
          contentRevision: 3,
          sheetRevision: 2,
          viewRevision: 4
        }
      },
      sheet: {
        paper: 'A3',
        orientation: 'landscape' as const,
        scaleDenominator: 500,
        drawingUnit: 'm'
      }
    }
  }
}

describe('BridgeSession', () => {
  it('discovers both providers without requiring an active configuration', async () => {
    const { ws, session } = sessionFixture()
    await session.discoveryReady

    const catalogs = decodedMessages(ws).filter(
      (message) => message.type === 'ai_capabilities'
    )
    expect(catalogs).toHaveLength(2)
    expect(
      catalogs.map((message) =>
        message.type === 'ai_capabilities' ? message.refreshing : undefined
      )
    ).toEqual([true, false])
    expect(catalogs.at(-1)).toMatchObject({
      providers: [
        { id: 'claude-code', status: 'ready' },
        { id: 'openai-codex', status: 'ready' }
      ]
    })
  })

  it('coalesces refreshes and blocks turns until the final catalog arrives', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { ws, claude, codex, session } = sessionFixture()
    await session.discoveryReady
    send(ws, {
      type: 'set_ai_configuration',
      revision: 1,
      configuration: configuration()
    })
    await vi.waitFor(() => {
      expect(decodedMessages(ws)).toContainEqual({
        type: 'ai_configuration_applied',
        revision: 1,
        configuration: configuration(),
        newConversation: true
      })
    })

    claude.discoveryGate = gate
    ws.sent = []
    send(ws, { type: 'refresh_ai_capabilities' })
    send(ws, { type: 'refresh_ai_capabilities' })
    send(ws, userMessage())

    await vi.waitFor(() => {
      expect(claude.discoverCount).toBe(2)
    })
    expect(codex.discoverCount).toBe(2)
    expect(decodedMessages(ws)).toContainEqual({
      type: 'error',
      message:
        'AI capabilities are refreshing; wait for the final provider catalog before sending.'
    })
    expect(
      decodedMessages(ws).filter(
        (message) =>
          message.type === 'ai_capabilities' && message.refreshing
      )
    ).toHaveLength(1)

    release()
    await vi.waitFor(() => {
      expect(
        decodedMessages(ws).some(
          (message) =>
            message.type === 'ai_capabilities' && !message.refreshing
        )
      ).toBe(true)
    })
    await Promise.resolve()
    send(ws, userMessage())
    await vi.waitFor(() => {
      expect(
        decodedMessages(ws).some(
          (message) => message.type === 'assistant_done'
        )
      ).toBe(true)
    })
  })

  it('rejects malformed messages and turns with no acknowledged configuration', async () => {
    const { ws, session } = sessionFixture()
    await session.discoveryReady
    ws.sent = []

    ws.emit('message', '{')
    send(ws, userMessage())

    expect(decodedMessages(ws)).toEqual([
      { type: 'error', message: 'Invalid browser message: malformed JSON' },
      {
        type: 'error',
        message:
          'The selected AI configuration has not been acknowledged. Wait for configuration confirmation before sending.'
      }
    ])
  })

  it('applies a revisioned configuration and reports provider metadata and metrics', async () => {
    const { ws, claude, session } = sessionFixture()
    await session.discoveryReady
    ws.sent = []

    send(ws, {
      type: 'set_ai_configuration',
      revision: 1,
      configuration: configuration()
    })
    await vi.waitFor(() => {
      expect(decodedMessages(ws)).toContainEqual({
        type: 'ai_configuration_applied',
        revision: 1,
        configuration: configuration(),
        newConversation: true
      })
    })

    send(ws, userMessage())
    await vi.waitFor(() => {
      expect(
        decodedMessages(ws).some((message) => message.type === 'assistant_done')
      ).toBe(true)
    })

    expect(claude.configurations).toEqual([configuration()])
    const done = decodedMessages(ws).find(
      (message) => message.type === 'assistant_done'
    )
    expect(done).toMatchObject({
      provider: 'claude-code',
      model: 'claude-default',
      effort: 'high',
      metrics: { toolCalls: 0 }
    })
    if (done?.type !== 'assistant_done') throw new Error('missing completion')
    expect(done.metrics.totalMs).toBeGreaterThanOrEqual(0)
    expect(done.metrics.conversationStartupMs).toBeGreaterThanOrEqual(0)
  })

  it('runs the live protocol v2 path through durable acceptance, progress, and one terminal event', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'envcad-live-turn-'))
    const journal = new PersistentTurnJournal(root)
    const { ws, claude, session } = sessionFixture(journal)
    try {
      await session.discoveryReady
      send(ws, {
        type: 'set_ai_configuration',
        revision: 1,
        configuration: configuration()
      })
      await vi.waitFor(() => {
        expect(decodedMessages(ws)).toContainEqual(
          expect.objectContaining({
            type: 'ai_configuration_applied',
            revision: 1
          })
        )
      })
      ws.sent = []

      send(ws, durableSubmit())
      await vi.waitFor(() => {
        expect(
          durableEvents(ws).some(
            ({ payload }) => payload.type === 'turn_finished'
          )
        ).toBe(true)
      })

      const events = durableEvents(ws)
      expect(events.map(({ payload }) => payload.type)).toEqual([
        'turn_accepted',
        'skill_activated',
        'skill_activated',
        'skill_activated',
        'turn_progress',
        'turn_progress',
        'instruction_breakdown',
        'turn_progress',
        'turn_progress',
        'turn_progress',
        'assistant_text_delta',
        'turn_progress',
        'turn_finished'
      ])
      expect(events.map(({ sequence }) => sequence)).toEqual(
        events.map((_event, index) => index + 1)
      )
      expect(
        events.filter(({ payload }) => payload.type === 'turn_finished')
      ).toHaveLength(1)
      expect(events.at(-1)?.payload).toMatchObject({
        type: 'turn_finished',
        outcome: 'completed',
        provider: 'claude-code',
        finalRevision: {
          documentId: 'drawing-live-1',
          documentRevision: 7,
          contentRevision: 3,
          sheetRevision: 2,
          viewRevision: 4
        }
      })
      expect(
        decodedMessages(ws).some(
          (message) => message.type === 'assistant_done'
        )
      ).toBe(false)
      expect(claude.conversations[0].prompts).toHaveLength(1)
      await vi.waitFor(() => {
        expect(decodedMessages(ws)).toContainEqual({
          type: 'status',
          state: 'idle'
        })
      })

      const durableCount = events.length
      send(ws, durableSubmit())
      await vi.waitFor(() => {
        expect(durableEvents(ws)).toHaveLength(durableCount * 2)
      })
      expect(claude.conversations[0].prompts).toHaveLength(1)

      ws.sent = []
      send(ws, {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        sessionId: 'renderer-session-1',
        messageId: 'resume-message-1',
        turnId: 'renderer-turn-1',
        sequence: 2,
        timestamp: '2026-07-29T08:01:00.000Z',
        payload: {
          type: 'resume_turn',
          turnId: 'renderer-turn-1',
          lastSequence: 1
        }
      })
      await vi.waitFor(() => {
        expect(durableEvents(ws)).toHaveLength(durableCount - 1)
      })
      expect(durableEvents(ws)[0].sequence).toBe(2)

      const read = await journal.execute({
        type: 'read-turn',
        turnId: 'renderer-turn-1',
        afterSequence: 0
      })
      expect(read).toMatchObject({
        type: 'turn-read',
        terminal: true,
        eventsAfterCursor: expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({
              type: 'turn_accepted'
            })
          }),
          expect.objectContaining({
            payload: expect.objectContaining({
              type: 'turn_finished',
              outcome: 'completed'
            })
          })
        ])
      })
    } finally {
      await session.close()
      await journal.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects stale revisions and provider changes during a running turn', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { ws, claude, session } = sessionFixture()
    claude.nextGate = gate
    await session.discoveryReady
    send(ws, {
      type: 'set_ai_configuration',
      revision: 1,
      configuration: configuration()
    })
    await vi.waitFor(() => {
      expect(
        decodedMessages(ws).some(
          (message) => message.type === 'ai_configuration_applied'
        )
      ).toBe(true)
    })

    send(ws, userMessage())
    await vi.waitFor(() => {
      expect(decodedMessages(ws)).toContainEqual({
        type: 'status',
        state: 'thinking'
      })
    })
    send(ws, {
      type: 'set_ai_configuration',
      revision: 2,
      configuration: configuration('openai-codex')
    })
    expect(decodedMessages(ws)).toContainEqual({
      type: 'ai_configuration_rejected',
      revision: 2,
      message:
        'Provider, model, and effort cannot change while an AI turn is running.'
    })

    release()
    await vi.waitFor(() => {
      expect(decodedMessages(ws)).toContainEqual({
        type: 'status',
        state: 'idle'
      })
    })
    send(ws, {
      type: 'set_ai_configuration',
      revision: 1,
      configuration: configuration()
    })
    expect(decodedMessages(ws)).toContainEqual({
      type: 'ai_configuration_rejected',
      revision: 1,
      message: 'Configuration revision 1 is stale.'
    })
  })

  it('recreates the provider conversation and acknowledges a reset revision', async () => {
    const { ws, claude, session } = sessionFixture()
    await session.discoveryReady
    send(ws, {
      type: 'set_ai_configuration',
      revision: 1,
      configuration: configuration()
    })
    await vi.waitFor(() => {
      expect(decodedMessages(ws)).toContainEqual({
        type: 'ai_configuration_applied',
        revision: 1,
        configuration: configuration(),
        newConversation: true
      })
    })
    const firstConversation = claude.conversations[0]

    send(ws, { type: 'reset', revision: 2 })
    await vi.waitFor(() => {
      expect(decodedMessages(ws)).toContainEqual({
        type: 'ai_configuration_applied',
        revision: 2,
        configuration: configuration(),
        newConversation: true
      })
    })
    expect(firstConversation.closed).toBe(true)
    expect(claude.conversations).toHaveLength(2)
  })

  it('serializes browser tool calls and correlates their results', async () => {
    const { ws, session } = sessionFixture()
    await session.discoveryReady
    ws.sent = []

    const first = session.callTool('draw_line', {
      start: { x: 0, y: 0 },
      end: { x: 1, y: 0 }
    })
    const second = session.callTool('zoom_extents', {})
    await vi.waitFor(() => {
      expect(
        decodedMessages(ws).filter((message) => message.type === 'tool_call')
      ).toHaveLength(1)
    })
    const firstCall = decodedMessages(ws).find(
      (message) => message.type === 'tool_call'
    )
    if (firstCall?.type !== 'tool_call') throw new Error('missing first call')
    send(ws, {
      type: 'tool_result',
      callId: firstCall.callId,
      result: { data: { entityId: 'line-1' } }
    })
    await expect(first).resolves.toEqual({ data: { entityId: 'line-1' } })

    await vi.waitFor(() => {
      expect(
        decodedMessages(ws).filter((message) => message.type === 'tool_call')
      ).toHaveLength(2)
    })
    const secondCall = decodedMessages(ws).filter(
      (message) => message.type === 'tool_call'
    )[1]
    if (secondCall.type !== 'tool_call') throw new Error('missing second call')
    send(ws, {
      type: 'tool_result',
      callId: secondCall.callId,
      result: { data: null }
    })
    await expect(second).resolves.toEqual({ data: null })
  })

  it('binds every active-turn tool call to the drawing revision and advances it after edits', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { ws, claude, session } = sessionFixture()
    claude.nextGate = gate
    await session.discoveryReady
    send(ws, {
      type: 'set_ai_configuration',
      revision: 1,
      configuration: configuration()
    })
    await vi.waitFor(() => {
      expect(decodedMessages(ws)).toContainEqual(
        expect.objectContaining({
          type: 'ai_configuration_applied',
          revision: 1
        })
      )
    })
    ws.sent = []
    send(ws, userMessage())
    await vi.waitFor(() => {
      expect(decodedMessages(ws)).toContainEqual({
        type: 'status',
        state: 'thinking'
      })
    })

    const first = claude.bridges[0].callTool('move_entities', {
      entityIds: ['entity-1'],
      dx: 1,
      dy: 0
    })
    await vi.waitFor(() => {
      expect(
        decodedMessages(ws).filter((message) => message.type === 'tool_call')
      ).toHaveLength(1)
    })
    const firstCall = decodedMessages(ws).find(
      (message) => message.type === 'tool_call'
    )
    if (firstCall?.type !== 'tool_call') throw new Error('missing first call')
    expect(firstCall.input).toMatchObject({
      entityIds: ['entity-1'],
      [ENVCAD_TURN_REVISION_FIELD]: {
        documentRevision: 7,
        contentRevision: 3
      }
    })
    send(ws, {
      type: 'tool_result',
      callId: firstCall.callId,
      result: {
        data: {
          moved: 1,
          revision: { documentRevision: 7, contentRevision: 4 }
        }
      }
    })
    await expect(first).resolves.toMatchObject({
      data: {
        moved: 1,
        revision: { documentRevision: 7, contentRevision: 4 }
      }
    })

    const second = claude.bridges[0].callTool('list_entities', {
      cursor: 0,
      pageSize: 10
    })
    await vi.waitFor(() => {
      expect(
        decodedMessages(ws).filter((message) => message.type === 'tool_call')
      ).toHaveLength(2)
    })
    const secondCall = decodedMessages(ws).filter(
      (message) => message.type === 'tool_call'
    )[1]
    if (secondCall.type !== 'tool_call') throw new Error('missing second call')
    expect(secondCall.input).toMatchObject({
      cursor: 0,
      pageSize: 10,
      [ENVCAD_TURN_REVISION_FIELD]: {
        documentRevision: 7,
        contentRevision: 4
      }
    })
    send(ws, {
      type: 'tool_result',
      callId: secondCall.callId,
      result: {
        data: {
          entities: [],
          revision: { documentRevision: 7, contentRevision: 4 }
        }
      }
    })
    await expect(second).resolves.toMatchObject({
      data: {
        entities: [],
        revision: { documentRevision: 7, contentRevision: 4 }
      }
    })

    release()
    await vi.waitFor(() => {
      expect(decodedMessages(ws)).toContainEqual({
        type: 'status',
        state: 'idle'
      })
    })
    await session.close()
  })

  it('binds durable mutations to operation metadata and journals the committed receipt before completion', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'envcad-live-operation-'))
    const journal = new PersistentTurnJournal(root)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { ws, claude, session } = sessionFixture(journal)
    claude.nextGate = gate
    await session.discoveryReady
    send(ws, {
      type: 'set_ai_configuration',
      revision: 1,
      configuration: configuration()
    })
    await vi.waitFor(() =>
      expect(decodedMessages(ws)).toContainEqual(
        expect.objectContaining({
          type: 'ai_configuration_applied',
          revision: 1
        })
      )
    )
    const mutationSubmit = durableSubmit()
    mutationSubmit.payload.text = 'move the selected entity'
    send(ws, mutationSubmit)
    await vi.waitFor(() =>
      expect(
        durableEvents(ws).some(
          (event) =>
            event.payload.type === 'turn_progress' &&
            event.payload.phase === 'executing'
        )
      ).toBe(true)
    )

    const pending = claude.bridges[0].callTool('move_entities', {
      entityIds: ['entity-1'],
      dx: 1,
      dy: 0
    })
    await vi.waitFor(() =>
      expect(
        decodedMessages(ws).filter((message) => message.type === 'tool_call')
      ).toHaveLength(1)
    )
    const call = decodedMessages(ws).find(
      (message) => message.type === 'tool_call'
    )
    if (call?.type !== 'tool_call' || !call.operation || !call.turnId) {
      throw new Error('missing durable mutation metadata')
    }
    expect(call).toMatchObject({
      turnId: 'renderer-turn-1',
      operation: {
        turnId: 'renderer-turn-1',
        toolName: 'move_entities',
        expectedRevision: {
          documentId: 'drawing-live-1',
          contentRevision: 3,
          sheetRevision: 2,
          viewRevision: 4
        }
      }
    })
    const storedData = { entityIds: ['entity-1'], moved: 1 }
    const storedJson = JSON.stringify(storedData)
    const resultHash = createHash('sha256')
      .update(storedJson, 'utf8')
      .digest('hex')
    const revisionAfter = {
      ...call.operation.expectedRevision,
      contentRevision: 4
    }
    const receipt = {
      operationId: call.operation.operationId,
      operationGroupId: call.operation.operationGroupId,
      idempotencyKey: call.operation.idempotencyKey,
      toolName: call.operation.toolName,
      argumentsHash: call.operation.argumentsHash,
      status: 'committed' as const,
      revisionBefore: call.operation.expectedRevision,
      revisionAfter,
      affectedEntityIds: ['entity-1'],
      resultHash,
      resultReference: {
        kind: 'inline-json' as const,
        sha256: resultHash,
        byteLength: Buffer.byteLength(storedJson, 'utf8'),
        json: storedJson
      },
      reconciliationFingerprint: 'b'.repeat(64),
      committedAt: '2026-07-29T08:00:01.000Z'
    }
    send(ws, {
      type: 'tool_result',
      callId: call.callId,
      result: {
        data: {
          ...storedData,
          revision: revisionAfter
        }
      },
      operationReceipt: receipt
    })

    await expect(pending).resolves.toMatchObject({
      data: { moved: 1, revision: revisionAfter }
    })
    await vi.waitFor(() =>
      expect(
        durableEvents(ws).some(
          (event) =>
            event.payload.type === 'operation_receipt' &&
            event.payload.receipt.operationId === receipt.operationId &&
            event.payload.receipt.status === 'committed'
        )
      ).toBe(true)
    )
    release()
    await vi.waitFor(() =>
      expect(
        durableEvents(ws).some(
          (event) =>
            event.payload.type === 'turn_finished' &&
            event.payload.outcome === 'completed'
        )
      ).toBe(true)
    )
    await session.close()
    await journal.close()
    await rm(root, { recursive: true, force: true })
  })

  it('reconciles a timed-out durable mutation and accepts its late committed result without repeating it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'envcad-late-operation-'))
    const journal = new PersistentTurnJournal(root)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { ws, claude, session } = sessionFixture(journal, {
      toolTimeoutMs: 10
    })
    claude.nextGate = gate
    await session.discoveryReady
    send(ws, {
      type: 'set_ai_configuration',
      revision: 1,
      configuration: configuration()
    })
    await vi.waitFor(() =>
      expect(decodedMessages(ws)).toContainEqual(
        expect.objectContaining({
          type: 'ai_configuration_applied',
          revision: 1
        })
      )
    )
    const mutationSubmit = durableSubmit()
    mutationSubmit.payload.text = 'move the selected entity'
    send(ws, mutationSubmit)
    await vi.waitFor(() =>
      expect(
        durableEvents(ws).some(
          (event) =>
            event.payload.type === 'turn_progress' &&
            event.payload.phase === 'executing'
        )
      ).toBe(true)
    )

    const pending = claude.bridges[0].callTool('move_entities', {
      entityIds: ['entity-late'],
      dx: 2,
      dy: 0
    })
    await vi.waitFor(() =>
      expect(
        decodedMessages(ws).filter((message) => message.type === 'tool_call')
      ).toHaveLength(1)
    )
    const call = decodedMessages(ws).find(
      (message) => message.type === 'tool_call'
    )
    if (call?.type !== 'tool_call' || !call.operation) {
      throw new Error('missing durable mutation metadata')
    }
    await vi.waitFor(() =>
      expect(
        decodedMessages(ws).some(
          (message) => message.type === 'get_operation_status'
        )
      ).toBe(true)
    )
    const statusRequest = decodedMessages(ws).find(
      (message) => message.type === 'get_operation_status'
    )
    if (statusRequest?.type !== 'get_operation_status') {
      throw new Error('missing operation status request')
    }
    send(ws, {
      type: 'operation_status',
      requestId: statusRequest.requestId,
      result: {
        operationId: call.operation.operationId,
        receipt: {
          operationId: call.operation.operationId,
          operationGroupId: call.operation.operationGroupId,
          idempotencyKey: call.operation.idempotencyKey,
          toolName: call.operation.toolName,
          argumentsHash: call.operation.argumentsHash,
          status: 'pending',
          revisionBefore: call.operation.expectedRevision,
          affectedEntityIds: []
        }
      }
    })

    const storedData = { entityIds: ['entity-late'], moved: 1 }
    const storedJson = JSON.stringify(storedData)
    const resultHash = createHash('sha256')
      .update(storedJson, 'utf8')
      .digest('hex')
    const revisionAfter = {
      ...call.operation.expectedRevision,
      contentRevision: 4
    }
    const receipt = {
      operationId: call.operation.operationId,
      operationGroupId: call.operation.operationGroupId,
      idempotencyKey: call.operation.idempotencyKey,
      toolName: call.operation.toolName,
      argumentsHash: call.operation.argumentsHash,
      status: 'committed' as const,
      revisionBefore: call.operation.expectedRevision,
      revisionAfter,
      affectedEntityIds: ['entity-late'],
      resultHash,
      resultReference: {
        kind: 'inline-json' as const,
        sha256: resultHash,
        byteLength: Buffer.byteLength(storedJson, 'utf8'),
        json: storedJson
      },
      reconciliationFingerprint: 'c'.repeat(64),
      committedAt: '2026-07-29T08:00:01.000Z'
    }
    send(ws, {
      type: 'tool_result',
      callId: call.callId,
      result: {
        data: {
          ...storedData,
          revision: revisionAfter
        }
      },
      operationReceipt: receipt
    })

    await expect(pending).resolves.toMatchObject({
      data: { moved: 1, revision: revisionAfter }
    })
    expect(
      decodedMessages(ws).filter((message) => message.type === 'tool_call')
    ).toHaveLength(1)
    await vi.waitFor(() =>
      expect(
        durableEvents(ws).some(
          (event) =>
            event.payload.type === 'operation_receipt' &&
            event.payload.receipt.operationId === receipt.operationId
        )
      ).toBe(true)
    )

    release()
    await vi.waitFor(() =>
      expect(
        durableEvents(ws).some(
          (event) =>
            event.payload.type === 'turn_finished' &&
            event.payload.outcome === 'completed'
        )
      ).toBe(true)
    )
    await session.close()
    await journal.close()
    await rm(root, { recursive: true, force: true })
  })

  it('rejects a spoofed image digest at the sidecar trust boundary', async () => {
    const { ws, session } = sessionFixture()
    await session.discoveryReady
    ws.sent = []

    const pending = session.callTool('inspect_sheet_preview', { view: 'full' })
    await vi.waitFor(() => {
      expect(
        decodedMessages(ws).filter((message) => message.type === 'tool_call')
      ).toHaveLength(1)
    })
    const call = decodedMessages(ws).find(
      (message) => message.type === 'tool_call'
    )
    if (call?.type !== 'tool_call') throw new Error('missing visual tool call')

    const base64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII='
    send(ws, {
      type: 'tool_result',
      callId: call.callId,
      result: {
        data: { view: 'full' },
        image: {
          mimeType: 'image/png',
          base64,
          byteLength: 68,
          width: 1,
          height: 1,
          aspectRatio: 1,
          sha256: '0'.repeat(64),
          captureId: 'sheet-1-full-spoofed-digest',
          renderRevision: 1
        }
      }
    })

    await expect(pending).resolves.toEqual({
      error: 'Browser returned an invalid inspect_sheet_preview result.'
    })
    expect(decodedMessages(ws)).toContainEqual({
      type: 'error',
      message:
        'Invalid browser message: invalid inspect_sheet_preview result: ' +
        'tool_result.result.image.sha256 does not match the decoded image bytes'
    })
  })

  it('rejects unknown tools and times out an unanswered browser call', async () => {
    const { session } = sessionFixture()
    await session.discoveryReady
    await expect(session.callTool('shell', {})).resolves.toEqual({
      error: 'Unknown CAD tool: shell'
    })

    const ws = new FakeWebSocket()
    const manager = new ProviderManager(
      [new FakeProvider('claude-code'), new FakeProvider('openai-codex')],
      logger()
    )
    const shortSession = new BridgeSession(ws as unknown as WebSocket, {
      providerManager: manager,
      logger: logger(),
      toolTimeoutMs: 5
    })
    await shortSession.discoveryReady
    await expect(shortSession.callTool('zoom_extents', {})).resolves.toEqual({
      error:
        'Timed out waiting for the browser to respond to zoom_extents after 0.005s'
    })
  })

  it('keeps concurrent disconnect and shutdown callers waiting on one provider cleanup', async () => {
    const { ws, manager, session } = sessionFixture()
    await session.discoveryReady
    let releaseCleanup!: () => void
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve
    })
    const close = vi
      .spyOn(manager, 'close')
      .mockImplementation(async () => cleanupGate)

    ws.disconnect()
    let shutdownFinished = false
    const shutdown = session.close().then(() => {
      shutdownFinished = true
    })
    await Promise.resolve()
    expect(shutdownFinished).toBe(false)
    expect(close).toHaveBeenCalledOnce()

    releaseCleanup()
    await shutdown
    expect(shutdownFinished).toBe(true)
    expect(close).toHaveBeenCalledOnce()
  })
})

describe('buildTurnPrompt', () => {
  it('records a CAD Skills invocation in every turn prompt', () => {
    for (const text of ['inspect the layers', 'draw a boundary']) {
      expect(buildTurnPrompt(text)).toContain(
        'CAD Skills invoked: earthtojake/text-to-cad v0.3.9 ' +
          '(envcad-native-cad-dxf); verified CAD ' +
          'f6ba5a9a2042d1a955f511a929f3061677871c2cd3674b09cf70b0c4c6690ecd and DXF ' +
          '12f88bb9d93b42c22b60e6ce4dad7ff3dacfe1cc4eab66afca6787cf243ee453.'
      )
    }
  })

  it('freezes selection and sheet context into the turn prompt', () => {
    expect(
      buildTurnPrompt(
        'move these',
        {
          count: 2,
          units: 'Meters',
          revision: { documentRevision: 7, contentRevision: 3 }
        },
        {
          paper: 'A3',
          orientation: 'landscape',
          scaleDenominator: 500,
          drawingUnit: 'm',
          templateId: 'site-plan'
        }
      )
    ).toContain(
      'Selection attached: 2 entities. Exact ids are held by EnvCAD; use ' +
        'get_selected_entities to read them in bounded pages. Units: Meters.\n' +
        'Active sheet: A3 landscape, scale 1:500, drawing unit m, template site-plan.'
    )
    expect(
      buildTurnPrompt(
        'move these',
        {
          count: 2,
          units: 'Meters',
          revision: { documentRevision: 7, contentRevision: 3 }
        }
      )
    ).not.toContain('private-a')
  })

  it.each(['claude-code', 'openai-codex'] as const)(
    'preserves a long prompt through WebSocket parsing and the %s provider boundary',
    async (providerId) => {
      const { ws, claude, codex, session } = sessionFixture()
      await session.discoveryReady
      send(ws, {
        type: 'set_ai_configuration',
        revision: 1,
        configuration: configuration(providerId)
      })
      await vi.waitFor(() => {
        expect(decodedMessages(ws)).toContainEqual(
          expect.objectContaining({
            type: 'ai_configuration_applied',
            revision: 1
          })
        )
      })
      const text =
        `  BEGIN-BRIDGE-SENTINEL\r\n${'α🌏\n'.repeat(4_000)}` +
        `MIDDLE-BRIDGE-SENTINEL\n${'x'.repeat(16_000)}\nEND-BRIDGE-SENTINEL  `
      const message = { ...userMessage(), text }
      send(ws, message)
      const provider = providerId === 'claude-code' ? claude : codex

      await vi.waitFor(() => {
        expect(provider.conversations[0].prompts).toHaveLength(1)
      })
      expect(provider.conversations[0].prompts[0]).toBe(
        buildTurnPrompt(
          text,
          message.selectionSnapshot,
          message.sheet
        )
      )
      await session.close()
    }
  )

  it('surfaces provider context rejection without truncating or retrying the prompt', async () => {
    const { ws, claude, session } = sessionFixture()
    await session.discoveryReady
    claude.nextError = new Error(
      'Claude context window rejected the complete request.'
    )
    send(ws, {
      type: 'set_ai_configuration',
      revision: 1,
      configuration: configuration('claude-code')
    })
    await vi.waitFor(() => {
      expect(decodedMessages(ws)).toContainEqual(
        expect.objectContaining({
          type: 'ai_configuration_applied',
          revision: 1
        })
      )
    })
    const text = `BEGIN-CONTEXT\n${'x'.repeat(32_000)}\nEND-CONTEXT`
    send(ws, { ...userMessage(), text })

    await vi.waitFor(() => {
      expect(decodedMessages(ws)).toContainEqual({
        type: 'error',
        message: 'Claude context window rejected the complete request.',
        provider: 'claude-code'
      })
    })
    expect(claude.conversations).toHaveLength(1)
    expect(claude.conversations[0].prompts).toEqual([
      buildTurnPrompt(text, userMessage().selectionSnapshot, userMessage().sheet)
    ])
    expect(
      decodedMessages(ws).some((message) => message.type === 'assistant_done')
    ).toBe(false)
    await session.close()
  })

  it('ingests a referenced instruction, keeps it out of the provider envelope, and authorizes exact retrieval', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'envcad-referenced-turn-'))
    const inputStore = new LocalInputStore(path.join(root, 'inputs'))
    const inputRetrieval = new InputRetrievalService(inputStore)
    const journal = new PersistentTurnJournal(path.join(root, 'turns'))
    const fixture = sessionFixture(journal, { inputStore, inputRetrieval })
    const { ws, claude, session } = fixture
    let release!: () => void
    const providerGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const inputId = 'instruction-reference-1'
    const content = Buffer.from(
      `BEGIN-PRIVATE-INPUT\n${'large local instruction\n'.repeat(2_000)}END-PRIVATE-INPUT`,
      'utf8'
    )
    const inputHash = createHash('sha256').update(content).digest('hex')
    const command = (sequence: number, payload: unknown) => ({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      sessionId: 'renderer-session-1',
      messageId: `input-command-${sequence}`,
      sequence,
      timestamp: '2026-07-29T08:00:00.000Z',
      payload
    })

    try {
      await session.discoveryReady
      claude.nextGate = providerGate
      send(ws, {
        type: 'set_ai_configuration',
        revision: 1,
        configuration: configuration()
      })
      await vi.waitFor(() => {
        expect(claude.bridges).toHaveLength(1)
      })
      send(
        ws,
        command(1, {
          type: 'input_begin',
          inputId,
          mediaType: 'text/plain',
          sourceName: 'instruction.txt',
          declaredByteLength: content.length
        })
      )
      await vi.waitFor(() => {
        expect(
          durableEvents(ws).some(
            ({ payload }) =>
              payload.type === 'input_progress' &&
              payload.receivedChunks === 0
          )
        ).toBe(true)
      })
      send(
        ws,
        command(2, {
          type: 'input_chunk',
          inputId,
          chunkIndex: 0,
          bytesBase64: content.toString('base64'),
          sha256: inputHash
        })
      )
      await vi.waitFor(() => {
        expect(
          durableEvents(ws).some(
            ({ payload }) =>
              payload.type === 'input_progress' &&
              payload.receivedChunks === 1
          )
        ).toBe(true)
      })
      send(
        ws,
        command(3, {
          type: 'input_commit',
          inputId,
          sha256: inputHash
        })
      )
      await vi.waitFor(() => {
        expect(
          durableEvents(ws).some(
            ({ payload }) => payload.type === 'input_committed'
          )
        ).toBe(true)
      })

      const base = durableSubmit(4)
      const { text: _inlineText, ...payloadWithoutText } = base.payload
      send(ws, {
        ...base,
        payload: {
          ...payloadWithoutText,
          instructionInputId: inputId
        }
      })
      await vi.waitFor(() => {
        expect(claude.conversations[0].prompts).toHaveLength(1)
      })

      const prompt = claude.conversations[0].prompts[0]
      expect(prompt).toContain(`Instruction input: id=${inputId}`)
      expect(prompt).toContain(`sha256=${inputHash}`)
      expect(prompt).not.toContain('BEGIN-PRIVATE-INPUT')
      await expect(
        claude.bridges[0].callTool('read_input_range', {
          inputId,
          byteStart: 0,
          byteLength: 'BEGIN-PRIVATE-INPUT'.length
        })
      ).resolves.toMatchObject({
        data: { text: 'BEGIN-PRIVATE-INPUT' }
      })
      await expect(
        claude.bridges[0].callTool('read_input_range', {
          inputId: 'not-attached',
          byteStart: 0,
          byteLength: 1
        })
      ).resolves.toMatchObject({
        error: expect.stringContaining('not attached')
      })
      release()
      await vi.waitFor(() => {
        expect(
          durableEvents(ws).some(
            ({ payload }) => payload.type === 'turn_finished'
          )
        ).toBe(true)
      })
    } finally {
      release()
      await session.close()
      await inputStore.close()
      await journal.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('preserves the complete multiline Unicode user text before appending context', () => {
    const text =
      `  BEGIN-TURN-SENTINEL\r\n${'α🌏\n'.repeat(6_000)}` +
      `MIDDLE-TURN-SENTINEL\n${'x'.repeat(16_000)}\nEND-TURN-SENTINEL  `
    const prompt = buildTurnPrompt(text)

    expect(prompt.startsWith(`${text}\n\n<context>\n`)).toBe(true)
    expect(prompt.indexOf('BEGIN-TURN-SENTINEL')).toBe(2)
    expect(prompt.indexOf('MIDDLE-TURN-SENTINEL')).toBeGreaterThan(
      prompt.indexOf('BEGIN-TURN-SENTINEL')
    )
    expect(prompt.indexOf('END-TURN-SENTINEL')).toBeGreaterThan(
      prompt.indexOf('MIDDLE-TURN-SENTINEL')
    )
  })
})
