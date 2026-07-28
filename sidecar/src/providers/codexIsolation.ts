import {
  CodexAppServerClient,
  type CodexAppServerClientOptions
} from './codexAppServerClient'
import { isSafeCodexMcpServerName } from './codexSecurityConfig'

const MAX_MCP_SERVERS = 100
const MAX_MCP_STATUS_PAGES = 5
const MCP_STATUS_PAGE_SIZE = 100
const MAX_CURSOR_LENGTH = 4_000

type ClientFactory = (
  options: CodexAppServerClientOptions
) => CodexAppServerClient

interface CodexConfigProbeOptions {
  executablePath: string
  runtimeDirectory: string
  environment?: NodeJS.ProcessEnv
  clientFactory?: ClientFactory
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function ownDataProperty(
  value: Record<string, unknown>,
  key: string
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !hasOwn(descriptor as unknown as Record<string, unknown>, 'value')) {
    throw new Error('Codex configuration probe returned an accessor property.')
  }
  return descriptor.value
}

function configFromReadResult(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value) || !hasOwn(value, 'config')) {
    throw new Error('Codex configuration probe returned an invalid result.')
  }
  const config = ownDataProperty(value, 'config')
  if (!isPlainRecord(config)) {
    throw new Error('Codex configuration probe returned an invalid config.')
  }
  return config
}

function mcpServersFromConfig(
  config: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!hasOwn(config, 'mcp_servers')) return undefined
  const mcpServers = ownDataProperty(config, 'mcp_servers')
  if (!isPlainRecord(mcpServers)) {
    throw new Error('Codex configuration probe returned invalid MCP settings.')
  }
  if (Object.getOwnPropertySymbols(mcpServers).length > 0) {
    throw new Error('Codex configuration probe returned invalid MCP names.')
  }
  return mcpServers
}

function validateMcpNames(names: readonly string[]): string[] {
  if (names.length > MAX_MCP_SERVERS) {
    throw new Error('Codex configuration probe exceeded the MCP server limit.')
  }
  const exact = new Set<string>()
  const caseFolded = new Set<string>()
  for (const name of names) {
    if (!isSafeCodexMcpServerName(name)) {
      throw new Error('Codex configuration probe returned an unsafe MCP server name.')
    }
    const folded = name.toLocaleLowerCase('en-US')
    if (exact.has(name) || caseFolded.has(folded)) {
      throw new Error('Codex configuration probe returned a duplicate MCP server name.')
    }
    exact.add(name)
    caseFolded.add(folded)
  }
  return [...names]
}

export function extractCodexMcpServerNames(value: unknown): string[] {
  const config = configFromReadResult(value)
  const mcpServers = mcpServersFromConfig(config)
  if (!mcpServers) return []
  return validateMcpNames(Object.getOwnPropertyNames(mcpServers))
}

export async function probeCodexMcpServerNames(
  options: CodexConfigProbeOptions
): Promise<string[]> {
  const factory =
    options.clientFactory ??
    ((clientOptions: CodexAppServerClientOptions) =>
      new CodexAppServerClient(clientOptions))
  const client = factory({
    executablePath: options.executablePath,
    runtimeDirectory: options.runtimeDirectory,
    environment: options.environment
  })
  try {
    await client.start()
    const result = await client.request('config/read', {
      includeLayers: false,
      cwd: options.runtimeDirectory
    })
    return extractCodexMcpServerNames(result)
  } finally {
    await client.close()
  }
}

function assertSameMcpInventory(
  actualNames: readonly string[],
  expectedNames: readonly string[]
): void {
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name) => !expectedNames.includes(name))
  ) {
    throw new Error(
      'Codex effective MCP configuration changed after the isolation probe.'
    )
  }
}

function assertDisabledMcpConfiguration(
  config: Record<string, unknown>,
  expectedNames: readonly string[]
): void {
  const mcpServers = mcpServersFromConfig(config)
  if (!mcpServers) {
    if (expectedNames.length === 0) return
    throw new Error('Codex effective MCP configuration omitted a probed server.')
  }
  for (const name of expectedNames) {
    const server = ownDataProperty(mcpServers, name)
    if (!isPlainRecord(server) || !hasOwn(server, 'enabled')) {
      throw new Error('Codex effective MCP configuration is malformed.')
    }
    if (ownDataProperty(server, 'enabled') !== false) {
      throw new Error(`Codex MCP server "${name}" remained enabled.`)
    }
  }
}

function parseStatusPage(value: unknown): {
  data: unknown[]
  nextCursor: string | null
} {
  if (!isPlainRecord(value) || !hasOwn(value, 'data') || !hasOwn(value, 'nextCursor')) {
    throw new Error('Codex MCP status returned an invalid page.')
  }
  const data = ownDataProperty(value, 'data')
  const nextCursor = ownDataProperty(value, 'nextCursor')
  if (!Array.isArray(data) || data.length > MCP_STATUS_PAGE_SIZE) {
    throw new Error('Codex MCP status returned an invalid server page.')
  }
  if (
    nextCursor !== null &&
    (typeof nextCursor !== 'string' ||
      nextCursor.length === 0 ||
      nextCursor.length > MAX_CURSOR_LENGTH)
  ) {
    throw new Error('Codex MCP status returned an invalid pagination cursor.')
  }
  return { data, nextCursor }
}

function assertInertMcpStatus(
  value: unknown,
  expectedNames: ReadonlySet<string>,
  seenNames: Set<string>
): void {
  if (!isPlainRecord(value) || !hasOwn(value, 'name')) {
    throw new Error('Codex MCP status returned a malformed server.')
  }
  const name = ownDataProperty(value, 'name')
  if (!isSafeCodexMcpServerName(name)) {
    throw new Error('Codex MCP status returned an unsafe server name.')
  }
  if (!expectedNames.has(name)) {
    throw new Error(`Codex MCP status exposed unexpected server "${name}".`)
  }
  if (seenNames.has(name)) {
    throw new Error('Codex MCP status returned a duplicate server.')
  }
  seenNames.add(name)

  if (
    !hasOwn(value, 'serverInfo') ||
    !hasOwn(value, 'tools') ||
    !hasOwn(value, 'resources') ||
    !hasOwn(value, 'resourceTemplates')
  ) {
    throw new Error('Codex MCP status returned a malformed server.')
  }
  const serverInfo = ownDataProperty(value, 'serverInfo')
  const tools = ownDataProperty(value, 'tools')
  const resources = ownDataProperty(value, 'resources')
  const resourceTemplates = ownDataProperty(value, 'resourceTemplates')
  if (
    serverInfo !== null ||
    !isPlainRecord(tools) ||
    Object.getOwnPropertyNames(tools).length !== 0 ||
    Object.getOwnPropertySymbols(tools).length !== 0 ||
    !Array.isArray(resources) ||
    resources.length !== 0 ||
    !Array.isArray(resourceTemplates) ||
    resourceTemplates.length !== 0
  ) {
    throw new Error(`Codex MCP server "${name}" was not inert.`)
  }
}

export async function attestCodexMcpIsolation(
  client: Pick<CodexAppServerClient, 'request'>,
  runtimeDirectory: string,
  expectedServerNames: readonly string[]
): Promise<void> {
  const expectedNames = validateMcpNames(expectedServerNames)
  const configResult = await client.request('config/read', {
    includeLayers: false,
    cwd: runtimeDirectory
  })
  const actualNames = extractCodexMcpServerNames(configResult)
  assertSameMcpInventory(actualNames, expectedNames)
  assertDisabledMcpConfiguration(configFromReadResult(configResult), expectedNames)

  const expected = new Set(expectedNames)
  const seenNames = new Set<string>()
  const seenCursors = new Set<string>()
  let cursor: string | null = null
  let pageCount = 0
  do {
    if (cursor) {
      if (seenCursors.has(cursor)) {
        throw new Error('Codex MCP status repeated a pagination cursor.')
      }
      seenCursors.add(cursor)
    }
    pageCount += 1
    if (pageCount > MAX_MCP_STATUS_PAGES) {
      throw new Error('Codex MCP status exceeded the pagination limit.')
    }
    const page = parseStatusPage(
      await client.request('mcpServerStatus/list', {
        cursor,
        limit: MCP_STATUS_PAGE_SIZE,
        detail: 'toolsAndAuthOnly'
      })
    )
    for (const status of page.data) {
      assertInertMcpStatus(status, expected, seenNames)
    }
    cursor = page.nextCursor
  } while (cursor)

  if (
    seenNames.size !== expected.size ||
    expectedNames.some((name) => !seenNames.has(name))
  ) {
    throw new Error('Codex MCP status omitted a configured server.')
  }
}
