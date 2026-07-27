import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentBridge,
  DEFAULT_BROWSER_CONNECTION,
  type AgentBridgeEvent
} from '../bridge'
import type { AiPreferences } from '../../../desktop/aiPreferences'

const providerCatalog = [
  {
    id: 'claude-code' as const,
    displayName: 'Claude Code',
    status: 'ready' as const,
    statusMessage: 'Claude ready',
    models: [
      {
        id: 'claude-default',
        invocationName: 'claude-default',
        displayName: 'Claude Default',
        description: 'Claude test model',
        supportedEfforts: [
          {
            value: 'high',
            displayName: 'High',
            isDefault: true
          }
        ],
        defaultEffort: 'high',
        isDefault: true
      }
    ]
  },
  {
    id: 'openai-codex' as const,
    displayName: 'OpenAI Codex',
    status: 'ready' as const,
    statusMessage: 'Codex ready',
    models: [
      {
        id: 'codex-fast',
        invocationName: 'codex-fast',
        displayName: 'Codex Fast',
        description: 'Fast test model',
        supportedEfforts: [
          {
            value: 'low',
            displayName: 'Low',
            isDefault: true
          }
        ],
        defaultEffort: 'low',
        isDefault: true
      },
      {
        id: 'codex-quality',
        invocationName: 'codex-quality',
        displayName: 'Codex Quality',
        description: 'Quality test model',
        supportedEfforts: [
          {
            value: 'medium',
            displayName: 'Medium',
            isDefault: true
          },
          {
            value: 'high',
            displayName: 'High',
            isDefault: false
          }
        ],
        defaultEffort: 'medium',
        isDefault: false
      }
    ]
  }
]

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

  it('isolates an interrupted turn and never sends a stale tool result to a replacement socket', async () => {
    vi.useFakeTimers()
    try {
      const bridge = new AgentBridge()
      const events: AgentBridgeEvent[] = []
      let finishTool:
        | ((result: { data: { entityId: string } }) => void)
        | undefined
      const handler = vi.fn(
        () =>
          new Promise<{ data: { entityId: string } }>((resolve) => {
            finishTool = resolve
          })
      )
      bridge.subscribe((event) => events.push(event))
      bridge.registerHandler('draw_line', handler)
      bridge.connect()
      await Promise.resolve()
      const firstSocket = FakeBrowserWebSocket.instances[0]

      firstSocket.receive({ type: 'status', state: 'thinking' })
      firstSocket.receive({ type: 'assistant_text_delta', text: 'Partial response' })
      firstSocket.receive({
        type: 'tool_call',
        callId: 'stale-call',
        name: 'draw_line',
        input: { start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }
      })
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1))

      firstSocket.close()
      expect(bridge.state.status).toBe('idle')
      expect(bridge.state.streamingText).toBe('')
      expect(bridge.state.pendingToolCalls).toEqual([])
      expect(events.at(-1)).toEqual({
        type: 'connection_reset',
        message:
          'AI Assistant disconnected during the active turn. The incomplete response was not carried into the replacement conversation.'
      })

      await vi.advanceTimersByTimeAsync(500)
      await Promise.resolve()
      const replacementSocket = FakeBrowserWebSocket.instances[1]
      expect(replacementSocket.readyState).toBe(FakeBrowserWebSocket.OPEN)

      finishTool?.({ data: { entityId: 'line-stale' } })
      await Promise.resolve()
      await Promise.resolve()
      expect(replacementSocket.sent).toEqual([])

      firstSocket.receive({ type: 'assistant_text_delta', text: ' stale' })
      expect(bridge.state.streamingText).toBe('')
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

  it('keeps turn metrics when a provider completes without text', async () => {
    const bridge = new AgentBridge()
    bridge.connect()
    await vi.waitFor(() => expect(bridge.state.connectionState).toBe('online'))

    FakeBrowserWebSocket.instances[0].receive({
      type: 'assistant_done',
      provider: 'openai-codex',
      model: 'codex-fast',
      metrics: {
        totalMs: 25,
        toolCalls: 0,
        inputTokens: 4,
        outputTokens: 0
      }
    })

    expect(bridge.state.messages).toEqual([
      {
        role: 'assistant',
        text: '',
        provider: 'openai-codex',
        model: 'codex-fast',
        metrics: {
          totalMs: 25,
          toolCalls: 0,
          inputTokens: 4,
          outputTokens: 0
        }
      }
    ])
    bridge.disconnect()
  })

  it('restores a live persisted selection and falls back within the selected provider only', async () => {
    const bridge = new AgentBridge()
    const preferences: AiPreferences = {
      schemaVersion: 1,
      selectedProvider: 'openai-codex',
      lastSelectedModels: { 'openai-codex': 'removed-model' },
      lastSelectedEfforts: {
        'openai-codex': { 'removed-model': 'max' }
      }
    }
    const save = vi.fn(async (value: AiPreferences) => value)
    bridge.initializePreferences(preferences, save)
    bridge.connect()
    await vi.waitFor(() => expect(bridge.state.connectionState).toBe('online'))
    const socket = FakeBrowserWebSocket.instances[0]
    socket.receive({
      type: 'ai_capabilities',
      providers: providerCatalog,
      refreshing: false
    })

    await vi.waitFor(() => {
      expect(
        socket.sent.map((raw) => JSON.parse(raw)).some(
          (message) =>
            message.type === 'set_ai_configuration' &&
            message.configuration.provider === 'openai-codex'
        )
      ).toBe(true)
    })
    expect(bridge.state.selectedProvider).toBe('openai-codex')
    expect(bridge.state.selectedModelId).toBe('codex-fast')
    expect(bridge.state.selectedEffort).toBeUndefined()
    expect(save).toHaveBeenCalled()
    bridge.disconnect()
  })

  it('ignores stale acknowledgements and blocks chat until the latest revision is applied', async () => {
    const bridge = new AgentBridge()
    bridge.initializePreferences()
    bridge.connect()
    await vi.waitFor(() => expect(bridge.state.connectionState).toBe('online'))
    const socket = FakeBrowserWebSocket.instances[0]
    socket.receive({
      type: 'ai_capabilities',
      providers: providerCatalog,
      refreshing: false
    })
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const first = JSON.parse(socket.sent[0])
    bridge.selectProvider('openai-codex')
    await vi.waitFor(() => expect(socket.sent).toHaveLength(2))
    const latest = JSON.parse(socket.sent[1])

    socket.receive({
      type: 'ai_configuration_applied',
      revision: first.revision,
      configuration: first.configuration,
      newConversation: true
    })
    expect(bridge.state.configurationReady).toBe(false)
    expect(() =>
      bridge.sendUserMessage(
        'draw',
        { ids: [], count: 0, units: 'Meters' },
        {
          paper: 'A3',
          orientation: 'landscape',
          scaleDenominator: 500,
          drawingUnit: 'm'
        }
      )
    ).toThrow('Wait for the selected provider')

    socket.receive({
      type: 'ai_configuration_applied',
      revision: latest.revision,
      configuration: latest.configuration,
      newConversation: true
    })
    expect(bridge.state.configurationReady).toBe(true)
    bridge.sendUserMessage(
      'draw',
      { ids: [], count: 0, units: 'Meters' },
      {
        paper: 'A3',
        orientation: 'landscape',
        scaleDenominator: 500,
        drawingUnit: 'm'
      }
    )
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      type: 'user_message',
      configurationRevision: latest.revision
    })
    bridge.disconnect()
  })

  it('keeps refresh pending through cached capabilities and blocks duplicate refreshes and chat', async () => {
    const bridge = new AgentBridge()
    bridge.initializePreferences()
    bridge.connect()
    await vi.waitFor(() => expect(bridge.state.connectionState).toBe('online'))
    const socket = FakeBrowserWebSocket.instances[0]
    socket.receive({
      type: 'ai_capabilities',
      providers: providerCatalog,
      refreshing: false
    })
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const configurationRequest = JSON.parse(socket.sent[0])
    socket.receive({
      type: 'ai_configuration_applied',
      revision: configurationRequest.revision,
      configuration: configurationRequest.configuration,
      newConversation: true
    })
    expect(bridge.state.configurationReady).toBe(true)

    socket.sent = []
    bridge.refreshCapabilities()
    bridge.refreshCapabilities()
    expect(socket.sent.map((raw) => JSON.parse(raw))).toEqual([
      { type: 'refresh_ai_capabilities' }
    ])
    expect(bridge.state.refreshingCapabilities).toBe(true)
    expect(() =>
      bridge.sendUserMessage(
        'draw',
        { ids: [], count: 0, units: 'Meters' },
        {
          paper: 'A3',
          orientation: 'landscape',
          scaleDenominator: 500,
          drawingUnit: 'm'
        }
      )
    ).toThrow(
      'Wait for the selected provider, model, and effort to be confirmed before sending.'
    )

    socket.receive({
      type: 'ai_capabilities',
      providers: providerCatalog,
      refreshing: true
    })
    expect(bridge.state.refreshingCapabilities).toBe(true)
    socket.receive({
      type: 'ai_capabilities',
      providers: providerCatalog,
      refreshing: false
    })
    expect(bridge.state.refreshingCapabilities).toBe(false)
    expect(bridge.state.configurationReady).toBe(true)
    bridge.disconnect()
  })

  it('keeps chat disabled until a new-conversation reset is acknowledged', async () => {
    const bridge = new AgentBridge()
    bridge.initializePreferences()
    bridge.connect()
    await vi.waitFor(() => expect(bridge.state.connectionState).toBe('online'))
    const socket = FakeBrowserWebSocket.instances[0]
    socket.receive({
      type: 'ai_capabilities',
      providers: providerCatalog,
      refreshing: false
    })
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))
    const initial = JSON.parse(socket.sent[0])
    socket.receive({
      type: 'ai_configuration_applied',
      revision: initial.revision,
      configuration: initial.configuration,
      newConversation: true
    })
    bridge.state.messages.push({ role: 'user', text: 'preserve until ack' })

    expect(bridge.reset()).toBe(true)
    const reset = JSON.parse(socket.sent.at(-1)!)
    expect(reset).toMatchObject({
      type: 'reset',
      revision: expect.any(Number)
    })
    expect(reset.revision).toBeGreaterThan(initial.revision)
    expect(bridge.state.configurationReady).toBe(false)
    expect(bridge.state.messages).toHaveLength(1)
    expect(() =>
      bridge.sendUserMessage(
        'draw',
        { ids: [], count: 0, units: 'Meters' },
        {
          paper: 'A3',
          orientation: 'landscape',
          scaleDenominator: 500,
          drawingUnit: 'm'
        }
      )
    ).toThrow('Wait for the selected provider')

    socket.receive({
      type: 'ai_configuration_applied',
      revision: reset.revision,
      configuration: initial.configuration,
      newConversation: true
    })
    expect(bridge.state.configurationReady).toBe(true)
    expect(bridge.state.appliedRevision).toBe(reset.revision)
    expect(bridge.state.messages).toHaveLength(0)
    bridge.disconnect()
  })

  it('changes effort options by model and refuses configuration changes during a turn', async () => {
    const bridge = new AgentBridge()
    bridge.initializePreferences({
      schemaVersion: 1,
      selectedProvider: 'openai-codex',
      lastSelectedModels: {},
      lastSelectedEfforts: {}
    })
    bridge.connect()
    await vi.waitFor(() => expect(bridge.state.connectionState).toBe('online'))
    const socket = FakeBrowserWebSocket.instances[0]
    socket.receive({
      type: 'ai_capabilities',
      providers: providerCatalog,
      refreshing: false
    })
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1))

    expect(
      bridge
        .selectedModelCapability()
        ?.supportedEfforts.map((effort) => effort.value)
    ).toEqual(['low'])
    bridge.selectModel('codex-quality')
    expect(
      bridge
        .selectedModelCapability()
        ?.supportedEfforts.map((effort) => effort.value)
    ).toEqual(['medium', 'high'])
    bridge.selectEffort('high')
    expect(bridge.state.selectedEffort).toBe('high')

    socket.receive({ type: 'status', state: 'thinking' })
    const sentBefore = socket.sent.length
    bridge.selectProvider('claude-code')
    expect(bridge.state.selectedProvider).toBe('openai-codex')
    expect(socket.sent).toHaveLength(sentBefore)
    bridge.disconnect()
  })

  it('does not roll back newer preferences when an older save resolves', async () => {
    const pending: Array<{
      value: AiPreferences
      resolve: (value: AiPreferences) => void
    }> = []
    const save = vi.fn(
      (value: AiPreferences) =>
        new Promise<AiPreferences>((resolve) => pending.push({ value, resolve }))
    )
    const bridge = new AgentBridge()
    bridge.initializePreferences(
      {
        schemaVersion: 1,
        selectedProvider: 'openai-codex',
        lastSelectedModels: {},
        lastSelectedEfforts: {}
      },
      save
    )
    bridge.connect()
    await vi.waitFor(() => expect(bridge.state.connectionState).toBe('online'))
    FakeBrowserWebSocket.instances[0].receive({
      type: 'ai_capabilities',
      providers: providerCatalog,
      refreshing: false
    })
    await vi.waitFor(() => expect(pending).toHaveLength(1))

    bridge.selectModel('codex-quality')
    pending[0].resolve(pending[0].value)
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    bridge.selectEffort('high')
    pending[1].resolve(pending[1].value)
    await vi.waitFor(() => expect(pending).toHaveLength(3))
    pending[2].resolve(pending[2].value)

    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(3))
    expect(pending[2].value).toMatchObject({
      selectedProvider: 'openai-codex',
      lastSelectedModels: { 'openai-codex': 'codex-quality' },
      lastSelectedEfforts: {
        'openai-codex': { 'codex-quality': 'high' }
      }
    })
    bridge.disconnect()
  })

  it('keeps an unavailable selected provider visible without cross-provider fallback', async () => {
    const bridge = new AgentBridge()
    bridge.initializePreferences({
      schemaVersion: 1,
      selectedProvider: 'openai-codex',
      lastSelectedModels: {},
      lastSelectedEfforts: {}
    })
    bridge.connect()
    await vi.waitFor(() => expect(bridge.state.connectionState).toBe('online'))
    const socket = FakeBrowserWebSocket.instances[0]
    socket.receive({
      type: 'ai_capabilities',
      providers: [
        providerCatalog[0],
        {
          id: 'openai-codex',
          displayName: 'OpenAI Codex',
          status: 'authentication-required',
          statusMessage: 'Run codex login.',
          models: []
        }
      ],
      refreshing: false
    })

    expect(bridge.state.selectedProvider).toBe('openai-codex')
    expect(bridge.state.configurationReady).toBe(false)
    expect(bridge.state.configurationError).toBe('Run codex login.')
    expect(socket.sent).toHaveLength(0)
    bridge.disconnect()
  })
})
