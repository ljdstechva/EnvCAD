import { describe, expect, it, vi } from 'vitest'
import type {
  CodexAppServerClient,
  CodexAppServerClientOptions
} from '../providers/codexAppServerClient'
import {
  attestCodexMcpIsolation,
  extractCodexMcpServerNames,
  probeCodexMcpServerNames
} from '../providers/codexIsolation'

function configResult(
  servers?: Record<string, unknown>
): Record<string, unknown> {
  return {
    config: {
      ...(servers === undefined ? {} : { mcp_servers: servers })
    }
  }
}

function inertStatus(name: string) {
  return {
    name,
    serverInfo: null,
    tools: {},
    resources: [],
    resourceTemplates: [],
    authStatus: 'unsupported'
  }
}

class ProbeClient {
  started = false
  closed = false
  requests: Array<{ method: string; params: unknown }> = []

  constructor(
    private readonly result: unknown,
    private readonly failure?: Error
  ) {}

  async start(): Promise<void> {
    this.started = true
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params })
    if (this.failure) throw this.failure
    return this.result
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

describe('Codex MCP configuration probe', () => {
  it('accepts zero servers and extracts only own server names', () => {
    expect(extractCodexMcpServerNames(configResult())).toEqual([])

    const secret = 'SECRET_TRANSPORT_SENTINEL'
    const servers = Object.create(null) as Record<string, unknown>
    Object.defineProperty(servers, 'docs', {
      value: { url: secret, headers: { Authorization: secret } },
      enumerable: false
    })
    servers.node_repl = {
      command: secret,
      env: { TOKEN: secret }
    }
    const names = extractCodexMcpServerNames(configResult(servers))

    expect(names).toEqual(['docs', 'node_repl'])
    expect(JSON.stringify(names)).not.toContain(secret)
  })

  it.each([
    ['missing result', undefined],
    ['array result', []],
    ['missing config', {}],
    ['array config', { config: [] }],
    ['null MCP settings', { config: { mcp_servers: null } }],
    ['array MCP settings', { config: { mcp_servers: [] } }]
  ])('rejects malformed %s', (_label, value) => {
    expect(() => extractCodexMcpServerNames(value)).toThrow(
      /configuration probe/
    )
  })

  it('rejects excessive, unsafe, duplicate, and prototype-sensitive names', () => {
    const excessive = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`server_${index}`, {}])
    )
    expect(() =>
      extractCodexMcpServerNames(configResult(excessive))
    ).toThrow('server limit')

    for (const name of [
      '',
      'contains.dot',
      'contains space',
      'x'.repeat(201),
      '__proto__',
      'prototype',
      'constructor'
    ]) {
      const servers = JSON.parse(`{"${name}":{}}`) as Record<string, unknown>
      expect(() =>
        extractCodexMcpServerNames(configResult(servers))
      ).toThrow(/unsafe MCP server name/)
    }

    expect(() =>
      extractCodexMcpServerNames(
        configResult({ Docs: {}, docs: {} })
      )
    ).toThrow('duplicate MCP server name')

    const polluted = { inherited: true } as Record<string, unknown>
    const prototypeSensitive = Object.create(polluted) as Record<string, unknown>
    prototypeSensitive.docs = {}
    expect(() =>
      extractCodexMcpServerNames(configResult(prototypeSensitive))
    ).toThrow('invalid MCP settings')
  })

  it('starts only a config/read probe and always closes it', async () => {
    const client = new ProbeClient(configResult({ docs: {}, node_repl: {} }))
    const factory = vi.fn(
      (_options: CodexAppServerClientOptions) =>
        client as unknown as CodexAppServerClient
    )

    await expect(
      probeCodexMcpServerNames({
        executablePath: 'C:\\tools\\codex.exe',
        runtimeDirectory: 'C:\\empty-runtime',
        clientFactory: factory
      })
    ).resolves.toEqual(['docs', 'node_repl'])
    expect(client.started).toBe(true)
    expect(client.closed).toBe(true)
    expect(client.requests).toEqual([
      {
        method: 'config/read',
        params: {
          includeLayers: false,
          cwd: 'C:\\empty-runtime'
        }
      }
    ])
    expect(
      client.requests.some(({ method }) =>
        ['thread/start', 'turn/start', 'mcpServer/tool/call'].includes(method)
      )
    ).toBe(false)
  })

  it.each([
    ['timeout', new Error('config/read timed out')],
    ['early process exit', new Error('app-server exited unexpectedly')]
  ])('closes after a probe %s', async (_label, failure) => {
    const client = new ProbeClient(undefined, failure)
    await expect(
      probeCodexMcpServerNames({
        executablePath: 'C:\\tools\\codex.exe',
        runtimeDirectory: 'C:\\empty-runtime',
        clientFactory: () => client as unknown as CodexAppServerClient
      })
    ).rejects.toThrow(failure.message)
    expect(client.closed).toBe(true)
  })
})

describe('Codex MCP effective isolation attestation', () => {
  function clientFor(
    configServers: Record<string, unknown>,
    pages: unknown[]
  ) {
    const requests: Array<{ method: string; params: unknown }> = []
    return {
      requests,
      client: {
        async request(method: string, params: unknown) {
          requests.push({ method, params })
          if (method === 'config/read') return configResult(configServers)
          if (method === 'mcpServerStatus/list') return pages.shift()
          throw new Error(`unexpected method ${method}`)
        }
      }
    }
  }

  it('accepts zero servers and a bounded multi-page inert inventory', async () => {
    const zero = clientFor({}, [{ data: [], nextCursor: null }])
    await expect(
      attestCodexMcpIsolation(
        zero.client as Pick<CodexAppServerClient, 'request'>,
        'C:\\empty-runtime',
        []
      )
    ).resolves.toBeUndefined()

    const several = clientFor(
      {
        docs: { enabled: false, secret: 'DO_NOT_READ_THIS_SENTINEL' },
        node_repl: { enabled: false }
      },
      [
        { data: [inertStatus('docs')], nextCursor: 'next-page' },
        { data: [inertStatus('node_repl')], nextCursor: null }
      ]
    )
    await expect(
      attestCodexMcpIsolation(
        several.client as Pick<CodexAppServerClient, 'request'>,
        'C:\\empty-runtime',
        ['docs', 'node_repl']
      )
    ).resolves.toBeUndefined()
    expect(several.requests).toEqual([
      expect.objectContaining({ method: 'config/read' }),
      {
        method: 'mcpServerStatus/list',
        params: {
          cursor: null,
          limit: 100,
          detail: 'toolsAndAuthOnly'
        }
      },
      {
        method: 'mcpServerStatus/list',
        params: {
          cursor: 'next-page',
          limit: 100,
          detail: 'toolsAndAuthOnly'
        }
      }
    ])
  })

  it('rejects an MCP that remains enabled in the effective config', async () => {
    const test = clientFor(
      { docs: { enabled: true } },
      [{ data: [inertStatus('docs')], nextCursor: null }]
    )
    await expect(
      attestCodexMcpIsolation(
        test.client as Pick<CodexAppServerClient, 'request'>,
        'C:\\empty-runtime',
        ['docs']
      )
    ).rejects.toThrow('remained enabled')
    expect(test.requests).toHaveLength(1)
  })

  it.each([
    [
      'unexpected server',
      inertStatus('codex_apps'),
      'unexpected server "codex_apps"'
    ],
    [
      'server information',
      { ...inertStatus('docs'), serverInfo: { name: 'active' } },
      'was not inert'
    ],
    [
      'tool',
      { ...inertStatus('docs'), tools: { shell: { description: 'no' } } },
      'was not inert'
    ],
    [
      'resource',
      { ...inertStatus('docs'), resources: [{ uri: 'secret://no' }] },
      'was not inert'
    ],
    [
      'resource template',
      {
        ...inertStatus('docs'),
        resourceTemplates: [{ uriTemplate: 'secret://{id}' }]
      },
      'was not inert'
    ]
  ])('rejects an active %s surface', async (_label, status, message) => {
    const expected = status.name === 'codex_apps' ? [] : ['docs']
    const config = expected.length ? { docs: { enabled: false } } : {}
    const test = clientFor(config, [{ data: [status], nextCursor: null }])
    await expect(
      attestCodexMcpIsolation(
        test.client as Pick<CodexAppServerClient, 'request'>,
        'C:\\empty-runtime',
        expected
      )
    ).rejects.toThrow(message)
  })

  it('rejects repeated cursors and excessive pagination', async () => {
    const repeated = clientFor(
      { docs: { enabled: false } },
      [
        { data: [], nextCursor: 'cycle' },
        { data: [], nextCursor: 'cycle' }
      ]
    )
    await expect(
      attestCodexMcpIsolation(
        repeated.client as Pick<CodexAppServerClient, 'request'>,
        'C:\\empty-runtime',
        ['docs']
      )
    ).rejects.toThrow('repeated a pagination cursor')

    const excessive = clientFor(
      { docs: { enabled: false } },
      Array.from({ length: 5 }, (_, index) => ({
        data: [],
        nextCursor: `page-${index + 1}`
      }))
    )
    await expect(
      attestCodexMcpIsolation(
        excessive.client as Pick<CodexAppServerClient, 'request'>,
        'C:\\empty-runtime',
        ['docs']
      )
    ).rejects.toThrow('pagination limit')
  })
})
