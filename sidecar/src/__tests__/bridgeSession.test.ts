import { EventEmitter } from 'node:events'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { WebSocket } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import type { ServerMessage } from '../../../src/agent/protocol'
import { BridgeSession, buildTurnPrompt } from '../bridgeSession'

class FakeWebSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN
  sent: string[] = []

  send(data: string) {
    this.sent.push(String(data))
  }

  disconnect() {
    this.readyState = WebSocket.CLOSED
    this.emit('close')
  }
}

function decodedMessages(ws: FakeWebSocket): ServerMessage[] {
  return ws.sent.map((message) => JSON.parse(message) as ServerMessage)
}

function fakeQuery(messages: unknown[]): Query {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message
    },
    interrupt: vi.fn(async () => undefined),
    close: vi.fn()
  } as unknown as Query
}

function validUserMessage(text = 'draw a line') {
  return {
    type: 'user_message',
    text,
    selectionSnapshot: { ids: [], count: 0, units: 'Millimeters' },
    sheet: {
      paper: 'A3',
      orientation: 'landscape',
      scaleDenominator: 500,
      drawingUnit: 'm'
    }
  }
}

function testLogger() {
  return { log: vi.fn(), error: vi.fn() }
}

describe('BridgeSession', () => {
  it('rejects malformed and structurally invalid inbound messages', () => {
    const ws = new FakeWebSocket()
    const logger = testLogger()
    new BridgeSession(ws as unknown as WebSocket, { logger })

    ws.emit('message', '{')
    ws.emit('message', JSON.stringify({ type: 'user_message', text: '' }))

    expect(decodedMessages(ws)).toEqual([
      { type: 'error', message: 'Invalid browser message: malformed JSON' },
      {
        type: 'error',
        message: 'Invalid browser message: user_message.text must be a non-empty string'
      }
    ])
    expect(logger.error).toHaveBeenCalledTimes(2)
  })

  it('correlates browser tool results and reports unknown call ids', async () => {
    const ws = new FakeWebSocket()
    const session = new BridgeSession(ws as unknown as WebSocket, { logger: testLogger() })

    const resultPromise = session.callTool('draw_line', {
      start: { x: 0, y: 0 },
      end: { x: 20, y: 0 }
    })
    const call = decodedMessages(ws)[0]
    expect(call.type).toBe('tool_call')
    if (call.type !== 'tool_call') throw new Error('Expected a tool_call')

    ws.emit(
      'message',
      JSON.stringify({
        type: 'tool_result',
        callId: call.callId,
        result: { data: { entityId: 'line-1' } }
      })
    )
    await expect(resultPromise).resolves.toEqual({ data: { entityId: 'line-1' } })

    ws.emit(
      'message',
      JSON.stringify({
        type: 'tool_result',
        callId: 'unknown-call',
        result: { data: null }
      })
    )
    expect(decodedMessages(ws).at(-1)).toEqual({
      type: 'error',
      message: 'Invalid browser message: tool_result references unknown callId "unknown-call"'
    })
  })

  it('times out tool calls and resolves them when the browser disconnects', async () => {
    const timeoutSocket = new FakeWebSocket()
    const timeoutSession = new BridgeSession(timeoutSocket as unknown as WebSocket, {
      logger: testLogger(),
      toolTimeoutMs: 5
    })
    await expect(timeoutSession.callTool('zoom_extents', {})).resolves.toEqual({
      error: 'Timed out waiting for the browser to respond to zoom_extents after 0.005s'
    })

    const disconnectSocket = new FakeWebSocket()
    const disconnectSession = new BridgeSession(disconnectSocket as unknown as WebSocket, {
      logger: testLogger()
    })
    const pending = disconnectSession.callTool('draw_line', {})
    disconnectSocket.disconnect()
    await expect(pending).resolves.toEqual({
      error: 'Browser connection closed while waiting for draw_line'
    })
  })

  it('uses the no-API-key subscription path and restricted CAD tools for a successful turn', async () => {
    const ws = new FakeWebSocket()
    const logger = testLogger()
    const queryFactory = vi.fn((_params: unknown) =>
      fakeQuery([
        {
          type: 'system',
          subtype: 'init',
          apiKeySource: 'none',
          session_id: 'session-1'
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Line drawn.' }] }
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'session-1'
        }
      ])
    )
    new BridgeSession(ws as unknown as WebSocket, {
      logger,
      queryFactory: queryFactory as never
    })

    ws.emit('message', JSON.stringify(validUserMessage()))

    await vi.waitFor(() => {
      expect(decodedMessages(ws).at(-1)).toEqual({ type: 'status', state: 'idle' })
    })
    expect(decodedMessages(ws)).toEqual([
      { type: 'status', state: 'thinking' },
      { type: 'assistant_text_delta', text: 'Line drawn.' },
      { type: 'assistant_done' },
      { type: 'status', state: 'idle' }
    ])

    const options = (queryFactory.mock.calls[0][0] as { options: Record<string, unknown> }).options
    expect(options).toMatchObject({
      model: 'sonnet',
      allowedTools: ['mcp__cad__*'],
      tools: [],
      permissionMode: 'dontAsk'
    })
    expect(options).not.toHaveProperty('env')
    expect(logger.log).toHaveBeenCalledWith(
      '[sidecar] Claude authentication source: none (Claude Code login; no API key)'
    )
  })

  it('fails closed when the SDK reports a non-OAuth credential source', async () => {
    const ws = new FakeWebSocket()
    const logger = testLogger()
    const queryFactory = vi.fn((_params: unknown) =>
      fakeQuery([
        {
          type: 'system',
          subtype: 'init',
          apiKeySource: 'user',
          session_id: 'session-1'
        }
      ])
    )
    new BridgeSession(ws as unknown as WebSocket, {
      logger,
      queryFactory: queryFactory as never
    })

    ws.emit('message', JSON.stringify(validUserMessage()))

    await vi.waitFor(() => {
      expect(decodedMessages(ws).some((message) => message.type === 'error')).toBe(true)
    })
    expect(decodedMessages(ws)).toContainEqual({
      type: 'error',
      message:
        'Claude authentication source must be the Claude Code subscription login, but the Agent SDK reported "user". ' +
        'EnvCAD requires the existing Claude Code subscription login and does not permit API-key authentication.'
    })
  })

  it('surfaces detailed Agent SDK errors without making a paid request', async () => {
    const ws = new FakeWebSocket()
    const queryFactory = vi.fn((_params: unknown) =>
      fakeQuery([
        {
          type: 'system',
          subtype: 'init',
          apiKeySource: 'oauth',
          session_id: 'session-1'
        },
        {
          type: 'result',
          subtype: 'error_during_execution',
          errors: ['Claude usage limit reached'],
          session_id: 'session-1'
        }
      ])
    )
    new BridgeSession(ws as unknown as WebSocket, {
      logger: testLogger(),
      queryFactory: queryFactory as never
    })

    ws.emit('message', JSON.stringify(validUserMessage()))

    await vi.waitFor(() => {
      expect(decodedMessages(ws)).toContainEqual({
        type: 'error',
        message: 'Claude agent error (error_during_execution): Claude usage limit reached'
      })
    })
  })

  it('preserves the SDK quota message and reset time for the browser', async () => {
    const ws = new FakeWebSocket()
    const queryFactory = vi.fn((_params: unknown) =>
      fakeQuery([
        {
          type: 'system',
          subtype: 'init',
          apiKeySource: 'none',
          session_id: 'session-1'
        },
        {
          type: 'rate_limit_event',
          rate_limit_info: {
            status: 'rejected',
            rateLimitType: 'five_hour',
            resetsAt: 1_785_044_400
          }
        },
        {
          type: 'assistant',
          error: 'rate_limit',
          message: {
            content: [
              {
                type: 'text',
                text: "You've hit your session limit · resets 1:40pm (Asia/Singapore)"
              }
            ]
          }
        }
      ])
    )
    new BridgeSession(ws as unknown as WebSocket, {
      logger: testLogger(),
      queryFactory: queryFactory as never
    })

    ws.emit('message', JSON.stringify(validUserMessage()))

    await vi.waitFor(() => {
      expect(decodedMessages(ws)).toContainEqual({
        type: 'error',
        message:
          "Claude request failed (rate_limit): You've hit your session limit · " +
          'resets 1:40pm (Asia/Singapore)'
      })
    })
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
})
