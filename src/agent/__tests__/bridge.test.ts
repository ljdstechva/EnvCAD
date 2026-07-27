import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentBridge,
  DEFAULT_BROWSER_CONNECTION,
  type AgentBridgeEvent
} from '../bridge'

type Listener = (event: { data?: string }) => void

class FakeBrowserWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeBrowserWebSocket[] = []

  readyState = FakeBrowserWebSocket.CONNECTING
  sent: string[] = []
  private listeners = new Map<string, Listener[]>()

  constructor(
    readonly url: string,
    readonly protocols?: string | string[]
  ) {
    FakeBrowserWebSocket.instances.push(this)
    queueMicrotask(() => {
      this.readyState = FakeBrowserWebSocket.OPEN
      this.dispatch('open')
    })
  }

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  send(data: string) {
    this.sent.push(String(data))
  }

  close() {
    this.readyState = FakeBrowserWebSocket.CLOSED
    this.dispatch('close')
  }

  receive(message: unknown) {
    this.dispatch('message', { data: JSON.stringify(message) })
  }

  private dispatch(type: string, event: { data?: string } = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

describe('AgentBridge', () => {
  beforeEach(() => {
    FakeBrowserWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeBrowserWebSocket)
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('emits a correlated browser tool result after executing a tool call', async () => {
    const bridge = new AgentBridge()
    const events: AgentBridgeEvent[] = []
    bridge.subscribe((event) => events.push(event))
    bridge.registerHandler('draw_line', () => ({ data: { entityId: 'line-1' } }))

    bridge.connect()
    await vi.waitFor(() => expect(bridge.state.connectionState).toBe('online'))
    const socket = FakeBrowserWebSocket.instances[0]

    socket.receive({
      type: 'tool_call',
      callId: 'call-1',
      name: 'draw_line',
      input: { start: { x: 0, y: 0 }, end: { x: 20, y: 0 } }
    })

    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    expect(JSON.parse(socket.sent[0])).toEqual({
      type: 'tool_result',
      callId: 'call-1',
      result: { data: { entityId: 'line-1' } }
    })
    expect(events).toEqual([
      {
        type: 'tool_call',
        callId: 'call-1',
        name: 'draw_line',
        input: { start: { x: 0, y: 0 }, end: { x: 20, y: 0 } }
      },
      {
        type: 'tool_result',
        callId: 'call-1',
        name: 'draw_line',
        result: { data: { entityId: 'line-1' } }
      }
    ])

    bridge.disconnect()
  })

  it('uses the browser-development port and protocols by default', async () => {
    const bridge = new AgentBridge()
    bridge.connect()
    await vi.waitFor(() => expect(bridge.state.connectionState).toBe('online'))

    expect(FakeBrowserWebSocket.instances[0].url).toBe('ws://127.0.0.1:8787')
    expect(FakeBrowserWebSocket.instances[0].protocols).toEqual(
      DEFAULT_BROWSER_CONNECTION.protocols
    )
    bridge.disconnect()
  })

  it('uses desktop runtime configuration supplied before connect', async () => {
    const bridge = new AgentBridge()
    bridge.configureConnection({
      url: 'ws://127.0.0.1:43123',
      protocols: ['envcad.v1', 'envcad.session.test-token']
    })
    bridge.connect()
    await vi.waitFor(() => expect(bridge.state.connectionState).toBe('online'))

    expect(FakeBrowserWebSocket.instances[0].url).toBe('ws://127.0.0.1:43123')
    expect(FakeBrowserWebSocket.instances[0].protocols).toEqual([
      'envcad.v1',
      'envcad.session.test-token'
    ])
    bridge.disconnect()
  })

  it('reconnects gracefully after an established socket closes', async () => {
    vi.useFakeTimers()
    try {
      const bridge = new AgentBridge()
      bridge.connect()
      await Promise.resolve()
      expect(bridge.state.connectionState).toBe('online')

      FakeBrowserWebSocket.instances[0].close()
      expect(bridge.state.connectionState).toBe('offline')
      await vi.advanceTimersByTimeAsync(500)
      await Promise.resolve()

      expect(FakeBrowserWebSocket.instances).toHaveLength(2)
      expect(bridge.state.connectionState).toBe('online')
      bridge.disconnect()
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs concurrent tool calls one at a time so each stays its own undo step', async () => {
    const bridge = new AgentBridge()
    const running: string[] = []
    let maxConcurrent = 0
    const release: Array<() => void> = []

    const handler = (name: string) => async () => {
      running.push(name)
      maxConcurrent = Math.max(maxConcurrent, running.length)
      await new Promise<void>((resolve) => release.push(resolve))
      running.splice(running.indexOf(name), 1)
      return { data: { name } }
    }
    bridge.registerHandler('move_entities', handler('move_entities'))
    bridge.registerHandler('copy_entities', handler('copy_entities'))

    bridge.connect()
    await vi.waitFor(() => expect(bridge.state.connectionState).toBe('online'))
    const socket = FakeBrowserWebSocket.instances[0]

    // Both arrive before either has finished, as they would from one
    // assistant turn that emits parallel tool calls.
    socket.receive({ type: 'tool_call', callId: 'call-1', name: 'move_entities', input: {} })
    socket.receive({ type: 'tool_call', callId: 'call-2', name: 'copy_entities', input: {} })

    await vi.waitFor(() => expect(release).toHaveLength(1))
    expect(running).toEqual(['move_entities'])
    release[0]()

    await vi.waitFor(() => expect(release).toHaveLength(2))
    expect(running).toEqual(['copy_entities'])
    release[1]()

    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    expect(maxConcurrent).toBe(1)
    expect(socket.sent.map((raw) => JSON.parse(raw).callId)).toEqual(['call-1', 'call-2'])

    bridge.disconnect()
  })

  it('rejects an invalid inbound tool name before invoking a handler', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const handler = vi.fn(() => ({ data: null }))
    const bridge = new AgentBridge()
    bridge.registerHandler('execute_code', handler)
    bridge.connect()
    await vi.waitFor(() => expect(bridge.state.connectionState).toBe('online'))

    FakeBrowserWebSocket.instances[0].receive({
      type: 'tool_call',
      callId: 'call-2',
      name: 'execute_code',
      input: {}
    })

    await vi.waitFor(() => expect(bridge.state.messages).toHaveLength(1))
    expect(handler).not.toHaveBeenCalled()
    expect(bridge.state.messages[0].text).toContain(
      'tool_call.name is not a registered CAD tool: execute_code'
    )
    expect(consoleError).toHaveBeenCalled()

    bridge.disconnect()
  })
})
