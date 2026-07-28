import type { ModelInfo, Query } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'
import {
  ClaudeProvider,
  type ClaudeProviderOptions
} from '../providers/claudeProvider'

function fakeQuery(
  messages: unknown[] = [],
  models: ModelInfo[] = []
): Query {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message
    },
    supportedModels: vi.fn(async () => models),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn()
  } as unknown as Query
}

const models = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-test',
    displayName: 'Default (recommended)',
    description: 'Default test alias',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'high', 'max']
  },
  {
    value: 'haiku',
    resolvedModel: 'claude-haiku-test',
    displayName: 'Haiku',
    description: 'Fast model',
    supportsEffort: false,
    supportedEffortLevels: []
  }
] as unknown as ModelInfo[]

function baseOptions(
  queryFactory: ReturnType<typeof vi.fn>
): ClaudeProviderOptions {
  return {
    runtimeDirectory:
      'C:\\Users\\test\\AppData\\Local\\EnvCAD\\ai-runtime\\test',
    environment: {
      PATH: 'C:\\tools',
      USERPROFILE: 'C:\\Users\\test'
    },
    queryFactory: queryFactory as never,
    discoverExecutable: vi.fn(async () => ({
      status: 'ready' as const,
      executablePath: 'C:\\tools\\claude.exe',
      version: '2.1.220'
    })),
    authenticate: vi.fn(async () => true),
    logger: { log: vi.fn(), error: vi.fn() }
  }
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = []
  for await (const event of events) output.push(event)
  return output
}

describe('ClaudeProvider', () => {
  it('maps live aliases, resolved models, and advertised effort levels', async () => {
    const queryFactory = vi.fn(() => fakeQuery([], models))
    const options = baseOptions(queryFactory)
    options.environment = {
      ...options.environment,
      ENVCAD_ACCEPTANCE_EVIDENCE_PATH:
        'C:\\acceptance\\provider-prompt-evidence.jsonl'
    }
    const provider = new ClaudeProvider(options)

    await expect(provider.discover()).resolves.toMatchObject({
      id: 'claude-code',
      status: 'ready',
      executableVersion: '2.1.220',
      models: [
        {
          id: 'default',
          invocationName: 'default',
          resolvedModel: 'claude-opus-test',
          defaultEffort: 'high',
          isDefault: true,
          supportedEfforts: [
            { value: 'low', isDefault: false },
            { value: 'high', isDefault: true },
            { value: 'max', isDefault: false }
          ]
        },
        {
          id: 'haiku',
          invocationName: 'haiku',
          resolvedModel: 'claude-haiku-test',
          supportedEfforts: [],
          isDefault: false
        }
      ]
    })
    const discoveryOptions = (
      queryFactory.mock.calls[0] as unknown as [
        { options: Record<string, unknown> }
      ]
    )[0].options
    expect(discoveryOptions).toMatchObject({
      tools: [],
      allowedTools: [],
      permissionMode: 'dontAsk',
      persistSession: false,
      settingSources: [],
      skills: [],
      plugins: []
    })
    expect(discoveryOptions.env).not.toHaveProperty(
      'ENVCAD_ACCEPTANCE_EVIDENCE_PATH'
    )
  })

  it('passes the exact model and effort while keeping every built-in tool absent', async () => {
    const discoveryQuery = fakeQuery([], models)
    const turnQuery = fakeQuery([
      {
        type: 'system',
        subtype: 'init',
        apiKeySource: 'none',
        session_id: 'session-1',
        model: 'claude-opus-test',
        tools: ['mcp__cad__draw_line']
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Created.' }] }
      },
      {
        type: 'result',
        subtype: 'success',
        session_id: 'session-1',
        usage: { input_tokens: 10, output_tokens: 4 }
      }
    ])
    const queryFactory = vi
      .fn()
      .mockReturnValueOnce(discoveryQuery)
      .mockReturnValueOnce(turnQuery)
    const provider = new ClaudeProvider(baseOptions(queryFactory))
    await provider.discover()
    const conversation = await provider.createConversation(
      {
        provider: 'claude-code',
        model: 'default',
        effort: 'max'
      },
      {
        callTool: vi.fn(async () => ({ data: null })),
        getSelectionSnapshot: () => undefined
      }
    )

    const longPrompt =
      `BEGIN-CLAUDE-SENTINEL\n${'α🌏'.repeat(8_000)}` +
      `\nMIDDLE-CLAUDE-SENTINEL\n${'z'.repeat(8_000)}\nEND-CLAUDE-SENTINEL  `
    await expect(
      collect(conversation.runTurn({ prompt: longPrompt }))
    ).resolves.toEqual([
      { type: 'resolved_model', model: 'claude-opus-test' },
      { type: 'text_delta', text: 'Created.' },
      { type: 'token_usage', inputTokens: 10, outputTokens: 4 }
    ])
    expect(queryFactory.mock.calls[1][0].prompt).toBe(longPrompt)
    const turnOptions = queryFactory.mock.calls[1][0].options
    expect(turnOptions).toMatchObject({
      model: 'default',
      effort: 'max',
      tools: [],
      allowedTools: ['mcp__cad__*'],
      permissionMode: 'dontAsk',
      settingSources: [],
      skills: [],
      plugins: [],
      strictMcpConfig: true
    })
    expect(turnOptions.env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(turnOptions).not.toHaveProperty('Bash')
    await conversation.close()
    expect(turnQuery.close).toHaveBeenCalled()
  })

  it('rejects API-key environments before discovery and redacts no secret into status', async () => {
    const queryFactory = vi.fn()
    const options = baseOptions(queryFactory)
    options.environment = {
      ANTHROPIC_API_KEY: 'sk-ant-never-use'
    }
    const provider = new ClaudeProvider(options)
    const capability = await provider.discover()

    expect(capability).toMatchObject({
      status: 'failed',
      statusMessage: expect.stringContaining('ANTHROPIC_API_KEY')
    })
    expect(capability.statusMessage).not.toContain('sk-ant-never-use')
    expect(options.discoverExecutable).not.toHaveBeenCalled()
  })

  it('fails closed if Claude exposes any non-canonical tool', async () => {
    const queryFactory = vi
      .fn()
      .mockReturnValueOnce(fakeQuery([], models))
      .mockReturnValueOnce(
        fakeQuery([
          {
            type: 'system',
            subtype: 'init',
            apiKeySource: 'oauth',
            session_id: 'session-1',
            tools: ['mcp__cad__draw_line', 'WebFetch']
          }
        ])
      )
    const provider = new ClaudeProvider(baseOptions(queryFactory))
    await provider.discover()
    const conversation = await provider.createConversation(
      { provider: 'claude-code', model: 'default', effort: 'high' },
      {
        callTool: vi.fn(async () => ({ data: null })),
        getSelectionSnapshot: () => undefined
      }
    )

    await expect(
      collect(conversation.runTurn({ prompt: 'draw' }))
    ).rejects.toThrow('Claude security boundary rejected non-CAD tools: WebFetch')
  })

  it('surfaces the CAD-tool failure when stopping the SDK turn raises an interrupt error', async () => {
    const discoveryQuery = fakeQuery([], models)
    let turnOptions:
      | {
          mcpServers: Record<
            string,
            {
              instance: {
                _registeredTools: Record<
                  string,
                  {
                    handler(input: unknown): Promise<unknown>
                  }
                >
              }
            }
          >
        }
      | undefined
    const turnQuery = {
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'system',
          subtype: 'init',
          apiKeySource: 'oauth',
          session_id: 'session-1',
          model: 'claude-opus-test',
          tools: ['mcp__cad__draw_line']
        }
        await turnOptions!.mcpServers.cad.instance._registeredTools.draw_line.handler(
          {
            start: { x: 0, y: 0 },
            end: { x: 1, y: 0 }
          }
        )
        throw new Error('SDK turn interrupted')
      },
      interrupt: vi.fn(async () => undefined),
      close: vi.fn()
    } as unknown as Query
    const queryFactory = vi
      .fn()
      .mockReturnValueOnce(discoveryQuery)
      .mockImplementationOnce((input: { options: typeof turnOptions }) => {
        turnOptions = input.options
        return turnQuery
      })
    const provider = new ClaudeProvider(baseOptions(queryFactory))
    await provider.discover()
    const conversation = await provider.createConversation(
      { provider: 'claude-code', model: 'default', effort: 'high' },
      {
        callTool: vi.fn(async () => ({ error: 'Layer not found: AI_BENCHMARK' })),
        getSelectionSnapshot: () => undefined
      }
    )

    await expect(
      collect(conversation.runTurn({ prompt: 'draw' }))
    ).rejects.toThrow(
      'Claude CAD tool draw_line failed: Layer not found: AI_BENCHMARK'
    )
    expect(turnQuery.interrupt).toHaveBeenCalledOnce()
    expect(turnQuery.close).toHaveBeenCalledOnce()
  })

  it('closes authoritatively without waiting for a wedged interrupt acknowledgement', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const discoveryQuery = fakeQuery([], models)
    const turnQuery = {
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'system',
          subtype: 'init',
          apiKeySource: 'oauth',
          session_id: 'session-1',
          model: 'claude-opus-test',
          tools: ['mcp__cad__draw_line']
        }
        await gate
      },
      interrupt: vi.fn(() => new Promise<void>(() => undefined)),
      close: vi.fn(() => release())
    } as unknown as Query
    const queryFactory = vi
      .fn()
      .mockReturnValueOnce(discoveryQuery)
      .mockReturnValueOnce(turnQuery)
    const provider = new ClaudeProvider(baseOptions(queryFactory))
    await provider.discover()
    const conversation = await provider.createConversation(
      { provider: 'claude-code', model: 'default', effort: 'high' },
      {
        callTool: vi.fn(async () => ({ data: null })),
        getSelectionSnapshot: () => undefined
      }
    )

    const run = collect(conversation.runTurn({ prompt: 'draw' }))
    await vi.waitFor(() => expect(queryFactory).toHaveBeenCalledTimes(2))
    await expect(conversation.close()).resolves.toBeUndefined()
    expect(turnQuery.interrupt).toHaveBeenCalledOnce()
    expect(turnQuery.close).toHaveBeenCalled()
    await expect(run).resolves.toEqual([
      { type: 'resolved_model', model: 'claude-opus-test' }
    ])
  })

  it('surfaces a provider-specific rate-limit reset and closes the completed query', async () => {
    const discoveryQuery = fakeQuery([], models)
    const turnQuery = fakeQuery([
      {
        type: 'system',
        subtype: 'init',
        apiKeySource: 'oauth',
        session_id: 'session-1',
        tools: []
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
        type: 'result',
        subtype: 'error_during_execution',
        errors: ['usage limit reached'],
        session_id: 'session-1'
      }
    ])
    const queryFactory = vi
      .fn()
      .mockReturnValueOnce(discoveryQuery)
      .mockReturnValueOnce(turnQuery)
    const provider = new ClaudeProvider(baseOptions(queryFactory))
    await provider.discover()
    const conversation = await provider.createConversation(
      { provider: 'claude-code', model: 'default', effort: 'high' },
      {
        callTool: vi.fn(async () => ({ data: null })),
        getSelectionSnapshot: () => undefined
      }
    )

    await expect(
      collect(conversation.runTurn({ prompt: 'draw' }))
    ).rejects.toThrow(
      'Claude five_hour usage limit reached; resets at 2026-07-26T05:40:00.000Z'
    )
    await conversation.reset()
    await conversation.close()
    expect(turnQuery.interrupt).not.toHaveBeenCalled()
    expect(turnQuery.close).toHaveBeenCalled()
  })
})
