import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import {
  parseClientMessage,
  type ClientMessage,
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
  message: Extract<ClientMessage, { type: 'user_message' }>
): Promise<void> {
  userMessageCount += 1
  const callId = `fake-call-${nextCallId++}`
  send(socket, { type: 'status', state: 'thinking' })
  send(socket, {
    type: 'assistant_text_delta',
    text: 'I will move the attached entities by exactly 5 drawing units. '
  })
  send(socket, {
    type: 'tool_call',
    callId,
    name: 'move_entities',
    input: {
      entityIds: [...message.selectionSnapshot.ids],
      dx: 5,
      dy: 0
    }
  })

  const result = await waitForToolResult(socket, callId)
  send(socket, {
    type: 'assistant_text_delta',
    text: result.error ? `The move failed: ${result.error}` : 'The scripted move completed.'
  })
  send(socket, { type: 'assistant_done' })
  send(socket, { type: 'status', state: 'idle' })
}

function handleSocket(socket: WebSocket): void {
  let busy = false
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

    if (parsed.value.type === 'user_message') {
      if (busy) {
        send(socket, { type: 'error', message: 'A scripted turn is already running' })
        return
      }
      busy = true
      void runScriptedExchange(socket, parsed.value)
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
    } else if (parsed.value.type === 'interrupt' || parsed.value.type === 'reset') {
      send(socket, { type: 'status', state: 'idle' })
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
  if (request.method === 'GET' && request.url === '/health') {
    json(response, 200, { ok: true, wsRunning: Boolean(webSocketServer) })
    return
  }
  if (request.method === 'GET' && request.url === '/stats') {
    json(response, 200, {
      wsRunning: Boolean(webSocketServer),
      userMessageCount,
      toolResultCount
    })
    return
  }
  if (request.method === 'POST' && request.url === '/start') {
    await startWebSocketServer()
    json(response, 200, { wsRunning: true })
    return
  }
  if (request.method === 'POST' && request.url === '/stop') {
    await stopWebSocketServer()
    json(response, 200, { wsRunning: false })
    return
  }
  if (request.method === 'POST' && request.url === '/reset-stats') {
    userMessageCount = 0
    toolResultCount = 0
    json(response, 200, { ok: true })
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
