import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentConfiguration,
  ServerMessage
} from '../../../src/agent/protocol'
import { BridgeSession, buildTurnPrompt } from '../bridgeSession'
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

function logger() {
  return { log: vi.fn(), error: vi.fn() }
}

function sessionFixture() {
  const ws = new FakeWebSocket()
  const claude = new FakeProvider('claude-code')
  const codex = new FakeProvider('openai-codex')
  const manager = new ProviderManager([claude, codex], logger())
  const session = new BridgeSession(ws as unknown as WebSocket, {
    providerManager: manager,
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
    selectionSnapshot: { ids: [], count: 0, units: 'Meters' },
    sheet: {
      paper: 'A3',
      orientation: 'landscape' as const,
      scaleDenominator: 500,
      drawingUnit: 'm'
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
  it('freezes selection and sheet context into the turn prompt', () => {
    expect(
      buildTurnPrompt(
        'move these',
        { ids: ['a', 'b'], count: 2, units: 'Meters' },
        {
          paper: 'A3',
          orientation: 'landscape',
          scaleDenominator: 500,
          drawingUnit: 'm',
          templateId: 'site-plan'
        }
      )
    ).toContain(
      'Selection attached: 2 entities, ids [a, b]. Units: Meters.\n' +
        'Active sheet: A3 landscape, scale 1:500, drawing unit m, template site-plan.'
    )
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
    await session.close()
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
