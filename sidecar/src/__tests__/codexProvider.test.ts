import { describe, expect, it, vi } from 'vitest'
import { CAD_TOOL_NAMES } from '../cadToolSpecs'
import {
  CodexProvider,
  type CodexProviderOptions
} from '../providers/codexProvider'
import type {
  CodexAppServerClientOptions,
  CodexNotification,
  CodexProtocolErrorListener,
  CodexServerRequest,
  CodexServerRequestHandler
} from '../providers/codexAppServerClient'
import { CodexAppServerClient } from '../providers/codexAppServerClient'

type NotificationListener = (notification: CodexNotification) => void

class FakeCodexClient {
  requests: Array<{ method: string; params: unknown }> = []
  notifications: Array<{ method: string; params: unknown }> = []
  started = false
  closed = false
  serverRequestHandler: CodexServerRequestHandler | undefined
  notificationListeners = new Set<NotificationListener>()
  protocolListeners = new Set<CodexProtocolErrorListener>()
  modelPages: unknown[] = []
  failedMethods = new Set<string>()
  accountResult: unknown = {
    account: {
      type: 'chatgpt',
      email: null,
      planType: 'plus'
    },
    requiresOpenaiAuth: true
  }

  async start(): Promise<void> {
    this.started = true
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params })
    if (this.failedMethods.has(method)) {
      return Promise.reject(new Error(`${method} failed for test`))
    }
    let result: unknown
    if (method === 'model/list') result = this.modelPages.shift()
    else if (method === 'account/read') result = this.accountResult
    else if (method === 'thread/start') result = { thread: { id: 'thread-1' } }
    else if (method === 'turn/start') result = { turn: { id: 'turn-1' } }
    else result = {}
    return Promise.resolve(result as T)
  }

  notify(method: string, params: unknown): void {
    this.notifications.push({ method, params })
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  onProtocolError(listener: CodexProtocolErrorListener): () => void {
    this.protocolListeners.add(listener)
    return () => this.protocolListeners.delete(listener)
  }

  setServerRequestHandler(
    handler: CodexServerRequestHandler | undefined
  ): void {
    this.serverRequestHandler = handler
  }

  emit(notification: CodexNotification): void {
    for (const listener of this.notificationListeners) listener(notification)
  }

  protocolError(error: Error): void {
    for (const listener of this.protocolListeners) listener(error)
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

const modelOne = {
  id: 'gpt-default',
  model: 'gpt-default',
  displayName: 'GPT Default',
  description: 'Default fake model',
  hidden: false,
  isDefault: true,
  defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: [
    { reasoningEffort: 'low', description: 'Fast' },
    { reasoningEffort: 'medium', description: 'Balanced' },
    { reasoningEffort: 'ultra', description: 'Subagents' }
  ]
}
const modelTwo = {
  ...modelOne,
  id: 'gpt-fast',
  model: 'gpt-fast-resolved',
  displayName: 'GPT Fast',
  description: 'Fast fake model',
  isDefault: false,
  defaultReasoningEffort: 'low',
  supportedReasoningEfforts: [
    { reasoningEffort: 'low', description: 'Fast' }
  ]
}
const ultraDefaultModel = {
  ...modelOne,
  id: 'gpt-ultra-default',
  model: 'gpt-ultra-default',
  displayName: 'GPT Ultra Default',
  description: 'Must remain unavailable to the single-agent EnvCAD runtime',
  isDefault: false,
  defaultReasoningEffort: 'ultra',
  supportedReasoningEfforts: [
    { reasoningEffort: 'low', description: 'Single agent' },
    { reasoningEffort: 'ultra', description: 'Multi-agent orchestration' }
  ]
}
const runtimeDirectory =
  'C:\\Users\\test\\AppData\\Local\\EnvCAD\\ai-runtime\\test'

function threadSettings(
  overrides: Record<string, unknown> = {}
): CodexNotification {
  return {
    method: 'thread/settings/updated',
    params: {
      threadId: 'thread-1',
      threadSettings: {
        activePermissionProfile: null,
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        collaborationMode: {
          mode: 'default',
          settings: {
            developer_instructions: 'EnvCAD security boundary',
            model: 'gpt-default',
            reasoning_effort: 'medium'
          }
        },
        cwd: runtimeDirectory,
        effort: 'medium',
        model: 'gpt-default',
        modelProvider: 'openai',
        multiAgentMode: 'explicitRequestOnly',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        ...overrides
      }
    }
  }
}

function threadStarted(
  overrides: Record<string, unknown> = {}
): CodexNotification {
  return {
    method: 'thread/started',
    params: {
      thread: {
        id: 'thread-1',
        cwd: runtimeDirectory,
        ephemeral: true,
        source: 'vscode',
        modelProvider: 'openai',
        parentThreadId: null,
        forkedFromId: null,
        agentRole: null,
        agentNickname: null,
        turns: [],
        ...overrides
      }
    }
  }
}

function options(clients: FakeCodexClient[]): CodexProviderOptions {
  return {
    runtimeDirectory,
    environment: {
      PATH: 'C:\\tools',
      USERPROFILE: 'C:\\Users\\test',
      LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local'
    },
    discoverExecutable: vi.fn(async () => ({
      status: 'ready' as const,
      executablePath: 'C:\\tools\\codex.exe',
      version: '0.145.0'
    })),
    authenticate: vi.fn(async () => true),
    listMcpServers: vi.fn(async () => ['test-mcp']),
    clientFactory: (_options: CodexAppServerClientOptions) => {
      const client = new FakeCodexClient()
      if (clients.length === 0) {
        client.modelPages.push(
          { data: [modelOne, ultraDefaultModel], nextCursor: 'page-2' },
          { data: [modelTwo], nextCursor: null }
        )
      }
      clients.push(client)
      return client as unknown as CodexAppServerClient
    },
    logger: { log: vi.fn(), error: vi.fn() }
  }
}

async function discoveredProvider() {
  const clients: FakeCodexClient[] = []
  const provider = new CodexProvider(options(clients))
  const capability = await provider.discover()
  return { provider, clients, capability }
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = []
  for await (const event of events) output.push(event)
  return output
}

describe('CodexProvider', () => {
  it('discovers paginated visible models, resolved ids, defaults, and filters Ultra', async () => {
    const { clients, capability } = await discoveredProvider()

    expect(capability).toMatchObject({
      id: 'openai-codex',
      status: 'ready',
      executableVersion: '0.145.0',
      models: [
        {
          id: 'gpt-default',
          invocationName: 'gpt-default',
          defaultEffort: 'medium',
          isDefault: true
        },
        {
          id: 'gpt-fast',
          invocationName: 'gpt-fast-resolved',
          resolvedModel: 'gpt-fast-resolved',
          defaultEffort: 'low',
          isDefault: false
        }
      ]
    })
    expect(
      capability.models[0].supportedEfforts.map((effort) => effort.value)
    ).toEqual(['low', 'medium'])
    expect(
      capability.models.some((model) => model.id === 'gpt-ultra-default')
    ).toBe(false)
    expect(
      clients[0].requests.filter((request) => request.method === 'model/list')
    ).toEqual([
      {
        method: 'model/list',
        params: { cursor: null, includeHidden: false }
      },
      {
        method: 'model/list',
        params: { cursor: 'page-2', includeHidden: false }
      }
    ])
    expect(clients[0].requests).toContainEqual({
      method: 'account/read',
      params: { refreshToken: false }
    })
    expect(clients[0].closed).toBe(true)
  })

  it('fails bounded discovery when model pagination repeats a cursor', async () => {
    const clients: FakeCodexClient[] = []
    const providerOptions = options(clients)
    const factory = providerOptions.clientFactory!
    providerOptions.clientFactory = (clientOptions) => {
      const client = factory(clientOptions) as unknown as FakeCodexClient
      if (clients.length === 1) {
        client.modelPages = [
          { data: [modelOne], nextCursor: 'cycle' },
          { data: [modelTwo], nextCursor: 'cycle' }
        ]
      }
      return client as unknown as CodexAppServerClient
    }
    const provider = new CodexProvider(providerOptions)

    await expect(provider.discover()).resolves.toMatchObject({
      status: 'failed',
      statusMessage: expect.stringContaining(
        'repeated pagination cursor'
      )
    })
    expect(
      clients[0].requests.filter((request) => request.method === 'model/list')
    ).toHaveLength(2)
    expect(clients[0].closed).toBe(true)
  })

  it('registers only canonical dynamic CAD tools inside a read-only isolated thread', async () => {
    const { provider, clients } = await discoveredProvider()
    const bridge = {
      callTool: vi.fn(async () => ({ data: { ok: true } })),
      getSelectionSnapshot: () => undefined
    }
    await provider.createConversation(
      {
        provider: 'openai-codex',
        model: 'gpt-default',
        effort: 'medium'
      },
      bridge
    )

    const threadStart = clients[1].requests.find(
      (request) => request.method === 'thread/start'
    )
    expect(threadStart?.params).toMatchObject({
      model: 'gpt-default',
      modelProvider: 'openai',
      cwd: expect.stringContaining('ai-runtime'),
      approvalPolicy: 'never',
      sandbox: 'read-only',
      allowProviderModelFallback: false,
      environments: [],
      selectedCapabilityRoots: [],
      config: {
        model_provider: 'openai',
        web_search: 'disabled',
        mcp_servers: { 'test-mcp': { enabled: false } },
        agents: { enabled: false },
        features: {
          apps: false,
          browser_use: false,
          computer_use: false,
          multi_agent: false,
          plugins: false,
          shell_tool: false,
          skill_search: false
        }
      }
    })
    const dynamicTools = (
      threadStart?.params as {
        dynamicTools: Array<{ name: string; inputSchema: unknown }>
      }
    ).dynamicTools
    expect(dynamicTools.map((tool) => tool.name)).toEqual([...CAD_TOOL_NAMES])
    expect(dynamicTools.every((tool) => tool.inputSchema)).toBe(true)
  })

  it('closes the app-server when conversation startup fails', async () => {
    const clients: FakeCodexClient[] = []
    const providerOptions = options(clients)
    const factory = providerOptions.clientFactory!
    providerOptions.clientFactory = (clientOptions) => {
      const client = factory(clientOptions) as unknown as FakeCodexClient
      if (clients.length === 2) client.failedMethods.add('thread/start')
      return client as unknown as CodexAppServerClient
    }
    const provider = new CodexProvider(providerOptions)
    await provider.discover()

    await expect(
      provider.createConversation(
        {
          provider: 'openai-codex',
          model: 'gpt-default',
          effort: 'medium'
        },
        {
          callTool: vi.fn(async () => ({ data: null })),
          getSelectionSnapshot: () => undefined
        }
      )
    ).rejects.toThrow('thread/start failed for test')
    expect(clients[1].closed).toBe(true)
  })

  it.each([
    {
      label: 'API-key account',
      result: {
        account: { type: 'apiKey' },
        requiresOpenaiAuth: true
      }
    },
    {
      label: 'signed-out account',
      result: {
        account: null,
        requiresOpenaiAuth: true
      }
    },
    {
      label: 'personal-token account',
      result: {
        account: { type: 'personalToken' },
        requiresOpenaiAuth: true
      }
    },
    {
      label: 'malformed ChatGPT account',
      result: {
        account: { type: 'chatgpt' },
        requiresOpenaiAuth: true
      }
    },
    {
      label: 'provider that does not require OpenAI authentication',
      result: {
        account: {
          type: 'chatgpt',
          email: null,
          planType: 'plus'
        },
        requiresOpenaiAuth: false
      }
    }
  ])(
    'fails conversation startup on $label after discovery',
    async ({ result }) => {
      const clients: FakeCodexClient[] = []
      const providerOptions = options(clients)
      const factory = providerOptions.clientFactory!
      providerOptions.clientFactory = (clientOptions) => {
        const client = factory(clientOptions) as unknown as FakeCodexClient
        if (clients.length === 2) client.accountResult = result
        return client as unknown as CodexAppServerClient
      }
      const provider = new CodexProvider(providerOptions)
      await expect(provider.discover()).resolves.toMatchObject({
        status: 'ready'
      })

      await expect(
        provider.createConversation(
          {
            provider: 'openai-codex',
            model: 'gpt-default',
            effort: 'medium'
          },
          {
            callTool: vi.fn(async () => ({ data: null })),
            getSelectionSnapshot: () => undefined
          }
        )
      ).rejects.toThrow(
        'Codex app-server is not authenticated with the required ChatGPT login.'
      )
      expect(clients[1].requests).toContainEqual({
        method: 'account/read',
        params: { refreshToken: false }
      })
      expect(clients[1].requests).not.toContainEqual(
        expect.objectContaining({ method: 'thread/start' })
      )
      expect(clients[1].closed).toBe(true)
    }
  )

  it('streams text, passes selected effort, and routes a dynamic CAD tool result', async () => {
    const { provider, clients } = await discoveredProvider()
    const bridge = {
      callTool: vi.fn(async () => ({ data: { entityId: 'line-1' } })),
      getSelectionSnapshot: () => undefined
    }
    const conversation = await provider.createConversation(
      {
        provider: 'openai-codex',
        model: 'gpt-default',
        effort: 'medium'
      },
      bridge
    )
    const run = collect(conversation.runTurn({ prompt: 'draw' }))
    await vi.waitFor(() => {
      expect(
        clients[1].requests.some((request) => request.method === 'turn/start')
      ).toBe(true)
    })
    clients[1].emit(threadSettings())
    expect(
      clients[1].requests.find((request) => request.method === 'turn/start')
    ).toMatchObject({
      params: {
        threadId: 'thread-1',
        model: 'gpt-default',
        effort: 'medium'
      }
    })
    const toolResult = await clients[1].serverRequestHandler?.({
      id: 9,
      method: 'item/tool/call',
      params: {
        callId: 'call-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        tool: 'zoom_extents',
        arguments: {}
      }
    } as CodexServerRequest)
    expect(toolResult).toEqual({
      contentItems: [{ type: 'inputText', text: '{\n  "entityId": "line-1"\n}' }],
      success: true
    })
    clients[1].emit({
      method: 'item/started',
      params: {
        item: { type: 'agentMessage' },
        startedAtMs: 1,
        threadId: 'thread-1',
        turnId: 'turn-1'
      }
    })
    clients[1].emit({
      method: 'item/agentMessage/delta',
      params: {
        delta: 'Created.',
        itemId: 'item-1',
        threadId: 'thread-1',
        turnId: 'turn-1'
      }
    })
    clients[1].emit({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          last: { inputTokens: 12, outputTokens: 3 },
          total: { inputTokens: 12, outputTokens: 3 }
        }
      }
    })
    clients[1].emit({
      method: 'item/completed',
      params: {
        completedAtMs: 2,
        item: { type: 'agentMessage' },
        threadId: 'thread-1',
        turnId: 'turn-1'
      }
    })
    clients[1].emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed' }
      }
    })
    await expect(run).resolves.toEqual([
      { type: 'text_delta', text: 'Created.' },
      { type: 'token_usage', inputTokens: 12, outputTokens: 3 }
    ])
    expect(bridge.callTool).toHaveBeenCalledWith('zoom_extents', {})
  })

  it('fails closed when Codex reports weakened runtime settings', async () => {
    const { provider, clients } = await discoveredProvider()
    const conversation = await provider.createConversation(
      {
        provider: 'openai-codex',
        model: 'gpt-default',
        effort: 'medium'
      },
      {
        callTool: vi.fn(async () => ({ data: null })),
        getSelectionSnapshot: () => undefined
      }
    )
    const run = collect(conversation.runTurn({ prompt: 'draw' }))
    await vi.waitFor(() => {
      expect(
        clients[1].requests.some((request) => request.method === 'turn/start')
      ).toBe(true)
    })
    clients[1].emit(
      threadSettings({
        sandboxPolicy: { type: 'readOnly', networkAccess: true }
      })
    )

    await expect(run).rejects.toThrow(
      'Codex security boundary rejected unexpected thread settings.'
    )
    await vi.waitFor(() => {
      expect(
        clients[1].requests.some(
          (request) => request.method === 'turn/interrupt'
        )
      ).toBe(true)
    })
    expect(clients[1].serverRequestHandler).toBeUndefined()
    expect(clients[1].closed).toBe(true)
  })

  it.each([
    {
      label: 'thread startup',
      notification: threadStarted({ modelProvider: 'custom-provider' }),
      expected: 'Codex emitted malformed thread/started metadata.'
    },
    {
      label: 'thread settings',
      notification: threadSettings({ modelProvider: 'custom-provider' }),
      expected:
        'Codex security boundary rejected unexpected thread settings.'
    }
  ])(
    'fails closed when a custom model provider appears in $label metadata',
    async ({ notification, expected }) => {
      const { provider, clients } = await discoveredProvider()
      const conversation = await provider.createConversation(
        {
          provider: 'openai-codex',
          model: 'gpt-default',
          effort: 'medium'
        },
        {
          callTool: vi.fn(async () => ({ data: null })),
          getSelectionSnapshot: () => undefined
        }
      )
      clients[1].emit(notification)

      await expect(
        collect(conversation.runTurn({ prompt: 'draw' }))
      ).rejects.toThrow(expected)
      expect(clients[1].closed).toBe(true)
    }
  )

  it('accepts the Codex 0.145 Windows app-server thread source', async () => {
    const { provider, clients } = await discoveredProvider()
    const conversation = await provider.createConversation(
      {
        provider: 'openai-codex',
        model: 'gpt-default',
        effort: 'medium'
      },
      {
        callTool: vi.fn(async () => ({ data: null })),
        getSelectionSnapshot: () => undefined
      }
    )
    clients[1].emit(threadStarted())
    const run = collect(conversation.runTurn({ prompt: 'draw' }))
    await vi.waitFor(() => {
      expect(
        clients[1].requests.some((request) => request.method === 'turn/start')
      ).toBe(true)
    })
    clients[1].emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed' }
      }
    })

    await expect(run).resolves.toEqual([])
  })

  it('rejects an unrelated Codex thread source', async () => {
    const { provider, clients } = await discoveredProvider()
    const conversation = await provider.createConversation(
      {
        provider: 'openai-codex',
        model: 'gpt-default',
        effort: 'medium'
      },
      {
        callTool: vi.fn(async () => ({ data: null })),
        getSelectionSnapshot: () => undefined
      }
    )
    clients[1].emit(threadStarted({ source: 'cli' }))

    await expect(
      collect(conversation.runTurn({ prompt: 'draw' }))
    ).rejects.toThrow('Codex emitted malformed thread/started metadata.')
    expect(clients[1].closed).toBe(true)
  })

  it('fails closed when streamed output references another turn', async () => {
    const { provider, clients } = await discoveredProvider()
    const conversation = await provider.createConversation(
      {
        provider: 'openai-codex',
        model: 'gpt-default',
        effort: 'medium'
      },
      {
        callTool: vi.fn(async () => ({ data: null })),
        getSelectionSnapshot: () => undefined
      }
    )
    const run = collect(conversation.runTurn({ prompt: 'draw' }))
    await vi.waitFor(() => {
      expect(
        clients[1].requests.some((request) => request.method === 'turn/start')
      ).toBe(true)
    })
    clients[1].emit({
      method: 'item/agentMessage/delta',
      params: {
        delta: 'Wrong turn',
        itemId: 'item-1',
        threadId: 'thread-1',
        turnId: 'turn-other'
      }
    })

    await expect(run).rejects.toThrow(
      'Codex emitted malformed agent-message delta.'
    )
    expect(clients[1].serverRequestHandler).toBeUndefined()
    expect(clients[1].closed).toBe(true)
  })

  it.each([
    ['API-key login', { authMode: 'apiKey', planType: 'plus' }],
    ['logout', { authMode: null, planType: null }],
    ['missing auth mode', { planType: null }],
    [
      'personal-token login',
      { authMode: 'chatgptAuthTokens', planType: 'plus' }
    ],
    ['Bedrock login', { authMode: 'amazonBedrock', planType: null }]
  ])(
    'fails closed if Codex reports %s after ChatGPT startup',
    async (_label, params) => {
      const { provider, clients } = await discoveredProvider()
      const conversation = await provider.createConversation(
        {
          provider: 'openai-codex',
          model: 'gpt-default',
          effort: 'medium'
        },
        {
          callTool: vi.fn(async () => ({ data: null })),
          getSelectionSnapshot: () => undefined
        }
      )
      const run = collect(conversation.runTurn({ prompt: 'draw' }))
      await vi.waitFor(() => {
        expect(
          clients[1].requests.some((request) => request.method === 'turn/start')
        ).toBe(true)
      })
      clients[1].emit({
        method: 'account/updated',
        params
      })

      await expect(run).rejects.toThrow(
        'Codex security boundary rejected a non-ChatGPT authentication update.'
      )
      expect(clients[1].closed).toBe(true)
    }
  )

  it('validates passive app-server notifications instead of accepting opaque metadata', async () => {
    const { provider, clients } = await discoveredProvider()
    const conversation = await provider.createConversation(
      {
        provider: 'openai-codex',
        model: 'gpt-default',
        effort: 'medium'
      },
      {
        callTool: vi.fn(async () => ({ data: null })),
        getSelectionSnapshot: () => undefined
      }
    )
    const run = collect(conversation.runTurn({ prompt: 'draw' }))
    await vi.waitFor(() => {
      expect(
        clients[1].requests.some((request) => request.method === 'turn/start')
      ).toBe(true)
    })
    clients[1].emit({
      method: 'item/reasoning/summaryPartAdded',
      params: {
        itemId: 'reasoning-1',
        summaryIndex: 0,
        threadId: 'thread-1',
        turnId: 'turn-1'
      }
    })
    clients[1].emit({
      method: 'warning',
      params: {
        message: 'Malformed because this field is not in the generated schema.',
        unexpectedAuthority: true
      }
    })

    await expect(run).rejects.toThrow('Codex emitted malformed warning metadata.')
    expect(clients[1].closed).toBe(true)
  })

  it.each([
    'commandExecution',
    'fileChange',
    'mcpToolCall',
    'webSearch',
    'collabAgentToolCall',
    'subAgentActivity'
  ])('interrupts and fails closed on forbidden %s events', async (itemType) => {
    const { provider, clients } = await discoveredProvider()
    const conversation = await provider.createConversation(
      {
        provider: 'openai-codex',
        model: 'gpt-default',
        effort: 'medium'
      },
      {
        callTool: vi.fn(async () => ({ data: null })),
        getSelectionSnapshot: () => undefined
      }
    )
    const run = collect(conversation.runTurn({ prompt: 'draw' }))
    await vi.waitFor(() => {
      expect(
        clients[1].requests.some((request) => request.method === 'turn/start')
      ).toBe(true)
    })
    clients[1].emit({
      method: 'item/started',
      params: {
        item: { type: itemType },
        startedAtMs: 1,
        threadId: 'thread-1',
        turnId: 'turn-1'
      }
    })

    await expect(run).rejects.toThrow(
      `Codex security boundary rejected item type "${itemType}".`
    )
    await vi.waitFor(() => {
      expect(
        clients[1].requests.some(
          (request) => request.method === 'turn/interrupt'
        )
      ).toBe(true)
    })
    expect(clients[1].serverRequestHandler).toBeUndefined()
    expect(clients[1].closed).toBe(true)
  })

  it('rejects key-based environments before executable or auth discovery', async () => {
    const clients: FakeCodexClient[] = []
    const providerOptions = options(clients)
    providerOptions.environment = {
      OPENAI_API_KEY: 'sk-proj-never-use'
    }
    const provider = new CodexProvider(providerOptions)

    await expect(provider.discover()).resolves.toMatchObject({
      status: 'failed',
      statusMessage: expect.stringContaining('OPENAI_API_KEY')
    })
    expect(providerOptions.discoverExecutable).not.toHaveBeenCalled()
    expect(JSON.stringify(clients)).not.toContain('sk-proj-never-use')
  })
})
