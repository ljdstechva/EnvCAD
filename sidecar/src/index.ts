import { WebSocketServer } from 'ws'
import { BridgeSession } from './bridgeSession'

const HOST = '127.0.0.1'
const PORT = 8787
const API_KEY_ENV_NAME = 'ANTHROPIC_API_KEY'
const ALLOWED_ORIGIN_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

if (process.env[API_KEY_ENV_NAME]?.trim()) {
  console.error(
    `[sidecar] refusing to start because ${API_KEY_ENV_NAME} is set. ` +
      'EnvCAD requires the existing Claude Code OAuth subscription login.'
  )
  process.exitCode = 1
} else {
  startSidecar()
}

function isAllowedBrowserOrigin(origin: string | undefined): boolean {
  if (!origin) return false
  try {
    const url = new URL(origin)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      ALLOWED_ORIGIN_HOSTS.has(url.hostname)
    )
  } catch {
    return false
  }
}

function startSidecar() {
  const wss = new WebSocketServer({
    host: HOST,
    port: PORT,
    verifyClient(info, done) {
      if (isAllowedBrowserOrigin(info.origin)) {
        done(true)
        return
      }
      console.error('[sidecar] rejected WebSocket connection from a non-local browser origin')
      done(false, 403, 'Local browser origin required')
    }
  })
  let shuttingDown = false

  wss.on('listening', () => {
    console.log(`[sidecar] listening on ws://${HOST}:${PORT}`)
  })

  wss.on('connection', (ws) => {
    console.log('[sidecar] browser connected')
    const session = new BridgeSession(ws)
    ws.on('close', () => {
      session.close('Browser disconnected')
      console.log('[sidecar] browser disconnected')
    })
  })

  wss.on('error', (error) => {
    console.error('[sidecar] WebSocket server error:', error)
    if (!shuttingDown) process.exitCode = 1
  })

  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[sidecar] received ${signal}; shutting down`)

    for (const client of wss.clients) {
      client.close(1001, 'Sidecar shutting down')
    }

    const forceCloseTimer = setTimeout(() => {
      for (const client of wss.clients) client.terminate()
    }, 2_000)
    forceCloseTimer.unref()

    wss.close((error) => {
      clearTimeout(forceCloseTimer)
      if (error) {
        console.error('[sidecar] shutdown error:', error)
        process.exitCode = 1
      } else {
        console.log('[sidecar] stopped')
      }
    })
  }

  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
}
