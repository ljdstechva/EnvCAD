import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import {
  parseClientMessage,
  type AgentConfiguration,
  type ClientMessage,
  type ProviderCapability,
  type ServerMessage,
  type ToolResult
} from '../src/agent/protocol'

const WS_PORT = 8787
const CONTROL_PORT = 8788
const HOST = '127.0.0.1'

let webSocketServer: WebSocketServer | undefined
let nextCallId = 1
let userMessageCount = 0
let toolResultCount = 0
let completionDelayMs = 0
let visualResultMode: 'success' | 'failure' = 'success'
let currentScenario = 'ready'
let lastVisualResultEvidence:
  | {
      provider: AgentConfiguration['provider']
      model: string
      toolName: 'inspect_sheet_preview'
      success: boolean
      mimeType?: string
      width?: number
      height?: number
      byteLength?: number
      rasterSha256?: string
      svgSha256?: string
    }
  | undefined
let lastPromptEvidence:
  | {
      provider: AgentConfiguration['provider']
      characters: number
      utf8Bytes: number
      sha256: string
      hasBeginSentinel: boolean
      hasMiddleSentinel: boolean
      hasEndSentinel: boolean
    }
  | undefined
const readyProviders: ProviderCapability[] = [
  {
    id: 'claude-code' as const,
    displayName: 'Claude Code',
    status: 'ready' as const,
    statusMessage: 'Fake Claude Code is ready.',
    executableVersion: 'test',
    models: [
      {
        id: 'fake-claude',
        invocationName: 'fake-claude',
        displayName: 'Fake Claude',
        description: 'Deterministic E2E model',
        inputModalities: ['text', 'image'],
        supportedEfforts: [
          {
            value: 'low',
            displayName: 'Low',
            description: 'Fast fake Claude effort',
            isDefault: false
          },
          {
            value: 'high',
            displayName: 'High',
            description: 'Quality fake Claude effort',
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
    statusMessage: 'Fake Codex is ready using ChatGPT login.',
    executableVersion: '0.145.0-test',
    models: [
      {
        id: 'fake-codex-balanced',
        invocationName: 'fake-codex-balanced',
        displayName: 'Fake Codex Balanced',
        description: 'Deterministic balanced E2E model',
        inputModalities: ['text', 'image'],
        supportedEfforts: [
          {
            value: 'low',
            displayName: 'Low',
            description: 'Fast fake Codex effort',
            isDefault: false
          },
          {
            value: 'medium',
            displayName: 'Medium',
            description: 'Balanced fake Codex effort',
            isDefault: true
          }
        ],
        defaultEffort: 'medium',
        isDefault: true
      },
      {
        id: 'fake-codex-fast',
        invocationName: 'fake-codex-fast',
        displayName: 'Fake Codex Fast',
        description: 'Deterministic fast E2E model',
        inputModalities: ['text', 'image'],
        supportedEfforts: [
          {
            value: 'low',
            displayName: 'Low',
            description: 'Only supported fake Codex effort',
            isDefault: true
          }
        ],
        defaultEffort: 'low',
        isDefault: false
      }
    ]
  }
]
let providers = readyProviders

function clonedCatalog(catalog: readonly ProviderCapability[]): ProviderCapability[] {
  return structuredClone([...catalog])
}

function setScenario(name: string): boolean {
  if (name === 'ready') {
    providers = clonedCatalog(readyProviders)
  } else if (name === 'codex-text-only') {
    providers = clonedCatalog(readyProviders).map((provider) =>
      provider.id === 'openai-codex'
        ? {
            ...provider,
            models: provider.models.map((model) => ({
              ...model,
              inputModalities: ['text']
            }))
          }
        : provider
    )
  } else if (name === 'codex-missing') {
    providers = clonedCatalog(readyProviders).map((provider) =>
      provider.id === 'openai-codex'
        ? {
            ...provider,
            status: 'missing',
            statusMessage:
              'Codex CLI was not found. Install Codex CLI, run "codex login", then refresh.',
            models: []
          }
        : provider
    )
  } else if (name === 'both-unavailable') {
    providers = clonedCatalog(readyProviders).map((provider) => ({
      ...provider,
      status: 'authentication-required',
      statusMessage:
        provider.id === 'claude-code'
          ? 'Claude Code is signed out. Run "claude auth login", then refresh.'
          : 'Codex CLI is signed out. Run "codex login", then refresh.',
      models: []
    }))
  } else {
    return false
  }
  currentScenario = name
  if (webSocketServer) {
    for (const client of webSocketServer.clients) {
      send(client, {
        type: 'ai_capabilities',
        providers,
        refreshing: false
      })
    }
  }
  return true
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

function waitForToolResult(socket: WebSocket, callId: string): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for tool_result ${callId}`))
    }, 15_000)

    const onMessage = (raw: Buffer) => {
      let decoded: unknown
      try {
        decoded = JSON.parse(raw.toString())
      } catch {
        return
      }
      const parsed = parseClientMessage(decoded)
      if (!parsed.ok || parsed.value.type !== 'tool_result') return
      if (parsed.value.callId !== callId) return
      toolResultCount += 1
      cleanup()
      resolve(parsed.value.result)
    }

    const onClose = () => {
      cleanup()
      reject(new Error(`Socket closed before tool_result ${callId}`))
    }

    const cleanup = () => {
      clearTimeout(timeout)
      socket.off('message', onMessage)
      socket.off('close', onClose)
    }

    socket.on('message', onMessage)
    socket.on('close', onClose)
  })
}

async function runScriptedExchange(
  socket: WebSocket,
  message: Extract<ClientMessage, { type: 'user_message' }>,
  configuration: AgentConfiguration
): Promise<void> {
  userMessageCount += 1
  lastPromptEvidence = {
    provider: configuration.provider,
    characters: message.text.length,
    utf8Bytes: Buffer.byteLength(message.text, 'utf8'),
    sha256: createHash('sha256').update(message.text, 'utf8').digest('hex'),
    hasBeginSentinel: message.text.includes('BEGIN-LONG-PROMPT-SENTINEL'),
    hasMiddleSentinel: message.text.includes('MIDDLE-LONG-PROMPT-SENTINEL'),
    hasEndSentinel: message.text.includes('END-LONG-PROMPT-SENTINEL')
  }
  const callId = `fake-call-${nextCallId++}`
  const visualRequest = message.text.includes(
    'Inspect the current Sheet Preview.'
  )
  send(socket, { type: 'status', state: 'thinking' })
  send(socket, {
    type: 'assistant_text_delta',
    text: visualRequest
      ? 'I will inspect the actual Sheet Preview image. '
      : 'I will move the attached entities by exactly 5 drawing units. '
  })
  send(socket, {
    type: 'tool_call',
    callId,
    name: visualRequest ? 'inspect_sheet_preview' : 'move_entities',
    input: visualRequest
      ? { view: visualResultMode === 'success' ? 'full' : 'outside-page' }
      : {
          entityIds: [...message.selectionSnapshot.ids],
          dx: 5,
          dy: 0
        }
  })

  const result = await waitForToolResult(socket, callId)
  if (visualRequest) {
    const data =
      result.data && typeof result.data === 'object'
        ? (result.data as Record<string, unknown>)
        : undefined
    lastVisualResultEvidence = {
      provider: configuration.provider,
      model: configuration.model,
      toolName: 'inspect_sheet_preview',
      success: Boolean(result.image) && !result.error,
      ...(result.image
        ? {
            mimeType: result.image.mimeType,
            width: result.image.width,
            height: result.image.height,
            byteLength: result.image.byteLength,
            rasterSha256: result.image.sha256
          }
        : {}),
      ...(typeof data?.svgSha256 === 'string'
        ? { svgSha256: data.svgSha256 }
        : {})
    }
  }
  if (completionDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, completionDelayMs))
  }
  send(socket, {
    type: 'assistant_text_delta',
    text: result.error
      ? `${visualRequest ? 'The inspection' : 'The move'} failed: ${result.error}`
      : visualRequest
        ? 'The scripted visual inspection completed.'
        : 'The scripted move completed.'
  })
  send(socket, {
    type: 'assistant_done',
    provider: configuration.provider,
    model: configuration.model,
    ...(configuration.effort ? { effort: configuration.effort } : {}),
    metrics: { totalMs: 1, toolCalls: 1 }
  })
  send(socket, { type: 'status', state: 'idle' })
}

function handleSocket(socket: WebSocket): void {
  let busy = false
  let configuration: AgentConfiguration = {
    provider: 'claude-code',
    model: 'fake-claude'
  }
  send(socket, {
    type: 'ai_capabilities',
    providers,
    refreshing: false
  })
  socket.on('message', (raw) => {
    let decoded: unknown
    try {
      decoded = JSON.parse(raw.toString())
    } catch {
      send(socket, { type: 'error', message: 'Malformed browser JSON' })
      return
    }
    const parsed = parseClientMessage(decoded)
    if (!parsed.ok) {
      send(socket, { type: 'error', message: parsed.error })
      return
    }

    if (parsed.value.type === 'set_ai_configuration') {
      const newConversation =
        configuration.provider !== parsed.value.configuration.provider ||
        configuration.model !== parsed.value.configuration.model ||
        configuration.effort !== parsed.value.configuration.effort
      configuration = { ...parsed.value.configuration }
      send(socket, {
        type: 'ai_configuration_applied',
        revision: parsed.value.revision,
        configuration,
        newConversation
      })
    } else if (parsed.value.type === 'refresh_ai_capabilities') {
      send(socket, {
        type: 'ai_capabilities',
        providers,
        refreshing: false
      })
    } else if (parsed.value.type === 'user_message') {
      if (busy) {
        send(socket, { type: 'error', message: 'A scripted turn is already running' })
        return
      }
      busy = true
      void runScriptedExchange(socket, parsed.value, configuration)
        .catch((error) => {
          send(socket, {
            type: 'error',
            message: error instanceof Error ? error.message : String(error)
          })
          send(socket, { type: 'status', state: 'idle' })
        })
        .finally(() => {
          busy = false
        })
    } else if (parsed.value.type === 'interrupt') {
      send(socket, { type: 'status', state: 'idle' })
    } else if (parsed.value.type === 'reset') {
      send(socket, {
        type: 'ai_configuration_applied',
        revision: parsed.value.revision,
        configuration,
        newConversation: true
      })
    }
  })
}

async function startWebSocketServer(): Promise<void> {
  if (webSocketServer) return
  await new Promise<void>((resolve, reject) => {
    const server = new WebSocketServer({ host: HOST, port: WS_PORT })
    server.once('listening', () => {
      webSocketServer = server
      console.log(`[fake-sidecar] WebSocket listening on ws://${HOST}:${WS_PORT}`)
      resolve()
    })
    server.once('error', reject)
    server.on('connection', handleSocket)
  })
}

async function stopWebSocketServer(): Promise<void> {
  const server = webSocketServer
  if (!server) return
  webSocketServer = undefined
  for (const client of server.clients) client.close(1001, 'Fake sidecar paused by E2E test')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  console.log('[fake-sidecar] WebSocket listener stopped')
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function handleControl(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const requestUrl = new URL(request.url ?? '/', `http://${HOST}:${CONTROL_PORT}`)
  if (request.method === 'GET' && requestUrl.pathname === '/health') {
    json(response, 200, { ok: true, wsRunning: Boolean(webSocketServer) })
    return
  }
  if (request.method === 'GET' && requestUrl.pathname === '/stats') {
    json(response, 200, {
      wsRunning: Boolean(webSocketServer),
      userMessageCount,
      toolResultCount,
      scenario: currentScenario,
      completionDelayMs,
      visualResultMode,
      lastPromptEvidence,
      lastVisualResultEvidence
    })
    return
  }
  if (request.method === 'POST' && requestUrl.pathname === '/start') {
    await startWebSocketServer()
    json(response, 200, { wsRunning: true })
    return
  }
  if (request.method === 'POST' && requestUrl.pathname === '/stop') {
    await stopWebSocketServer()
    json(response, 200, { wsRunning: false })
    return
  }
  if (request.method === 'POST' && requestUrl.pathname === '/reset-stats') {
    userMessageCount = 0
    toolResultCount = 0
    lastPromptEvidence = undefined
    lastVisualResultEvidence = undefined
    json(response, 200, { ok: true })
    return
  }
  if (request.method === 'POST' && requestUrl.pathname === '/scenario') {
    const name = requestUrl.searchParams.get('name') ?? ''
    if (!setScenario(name)) {
      json(response, 400, { error: `Unknown scenario ${name}` })
      return
    }
    json(response, 200, { ok: true, name })
    return
  }
  if (request.method === 'POST' && requestUrl.pathname === '/delay') {
    const value = Number(requestUrl.searchParams.get('ms'))
    if (!Number.isSafeInteger(value) || value < 0 || value > 5_000) {
      json(response, 400, { error: 'Delay must be an integer from 0 to 5000 ms' })
      return
    }
    completionDelayMs = value
    json(response, 200, { ok: true, completionDelayMs })
    return
  }
  if (request.method === 'POST' && requestUrl.pathname === '/visual-result') {
    const mode = requestUrl.searchParams.get('mode')
    if (mode !== 'success' && mode !== 'failure') {
      json(response, 400, { error: 'Visual result mode must be success or failure' })
      return
    }
    visualResultMode = mode
    json(response, 200, { ok: true, visualResultMode })
    return
  }
  json(response, 404, { error: 'Not found' })
}

const controlServer = createServer((request, response) => {
  void handleControl(request, response).catch((error) => {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) })
  })
})

async function shutdown(): Promise<void> {
  await stopWebSocketServer()
  await new Promise<void>((resolve) => controlServer.close(() => resolve()))
}

process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)))
process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)))

await startWebSocketServer()
controlServer.listen(CONTROL_PORT, HOST, () => {
  console.log(`[fake-sidecar] Control API listening on http://${HOST}:${CONTROL_PORT}`)
})
