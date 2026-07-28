import type { AddressInfo } from 'node:net'
import { isAbsolute } from 'node:path'
import { WebSocket, WebSocketServer, type VerifyClientCallbackAsync } from 'ws'
import { BridgeSession } from './bridgeSession'
import {
  ENVCAD_WEBSOCKET_PROTOCOL,
  sessionTokenProtocol
} from '../../desktop/runtimeProtocol'
import { ClaudeProvider } from './providers/claudeProvider'
import { CodexProvider } from './providers/codexProvider'
import { ProviderManager } from './providers/providerManager'
import { MAX_WEBSOCKET_PAYLOAD_BYTES } from '../../src/agent/protocol'

const DEFAULT_CLOSE_TIMEOUT_MS = 2_000

export interface SidecarLogger {
  log(message: string): void
  error(message: string, error?: unknown): void
}

export interface StartSidecarOptions {
  host: string
  port: number
  permittedOrigin: string
  sessionToken: string
  runtimeDirectory: string
  environment?: NodeJS.ProcessEnv
  providerManagerFactory?: () => ProviderManager
  logger?: SidecarLogger
  closeTimeoutMs?: number
}

export interface SidecarAddress {
  host: string
  port: number
  url: string
}

export interface SidecarHandle {
  ready: Promise<SidecarAddress>
  close(): Promise<void>
}

function validatedOrigin(origin: string): string {
  const parsed = new URL(origin)
  if (parsed.origin !== origin || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new Error('permittedOrigin must be an exact HTTP(S) origin without a path')
  }
  return parsed.origin
}

function parseProtocols(header: string | string[] | undefined): Set<string> {
  const value = Array.isArray(header) ? header.join(',') : header ?? ''
  return new Set(
    value
      .split(',')
      .map((protocol) => protocol.trim())
      .filter(Boolean)
  )
}

function createVerifier(options: {
  permittedOrigin: string
  expectedTokenProtocol: string
  logger: SidecarLogger
}): VerifyClientCallbackAsync {
  return (info, done) => {
    if (info.origin !== options.permittedOrigin) {
      options.logger.error('[sidecar] rejected WebSocket connection: renderer origin mismatch')
      done(false, 403, 'Renderer origin rejected')
      return
    }

    const protocols = parseProtocols(info.req.headers['sec-websocket-protocol'])
    if (
      protocols.size !== 2 ||
      !protocols.has(ENVCAD_WEBSOCKET_PROTOCOL) ||
      !protocols.has(options.expectedTokenProtocol)
    ) {
      options.logger.error('[sidecar] rejected WebSocket connection: protocol authentication failed')
      done(false, 403, 'WebSocket authentication rejected')
      return
    }
    done(true)
  }
}

export function startSidecar(options: StartSidecarOptions): SidecarHandle {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error('port must be an integer from 0 through 65535')
  }
  if (!options.sessionToken) throw new Error('sessionToken is required')
  if (!isAbsolute(options.runtimeDirectory)) {
    throw new Error('runtimeDirectory must be an absolute path')
  }

  const permittedOrigin = validatedOrigin(options.permittedOrigin)
  const logger = options.logger ?? console
  const expectedTokenProtocol = sessionTokenProtocol(options.sessionToken)
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS
  const sessions = new Set<BridgeSession>()
  let listening = false
  let closing = false
  let closePromise: Promise<void> | undefined
  let settleReady: ((address: SidecarAddress) => void) | undefined
  let rejectReady: ((error: Error) => void) | undefined

  const ready = new Promise<SidecarAddress>((resolve, reject) => {
    settleReady = resolve
    rejectReady = reject
  })

  const wss = new WebSocketServer({
    host: options.host,
    port: options.port,
    maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
    verifyClient: createVerifier({ permittedOrigin, expectedTokenProtocol, logger }),
    handleProtocols(protocols) {
      return protocols.has(ENVCAD_WEBSOCKET_PROTOCOL) ? ENVCAD_WEBSOCKET_PROTOCOL : false
    }
  })

  wss.once('listening', () => {
    listening = true
    const address = wss.address() as AddressInfo
    const bound: SidecarAddress = {
      host: options.host,
      port: address.port,
      url: `ws://${options.host}:${address.port}`
    }
    logger.log(`[sidecar] listening on ${bound.url}`)
    settleReady?.(bound)
  })

  wss.on('connection', (ws) => {
    if (closing) {
      ws.close(1012, 'Sidecar is shutting down')
      return
    }
    logger.log('[sidecar] renderer connected')
    const providerManager =
      options.providerManagerFactory?.() ??
      new ProviderManager(
        [
          new ClaudeProvider({
            runtimeDirectory: options.runtimeDirectory,
            environment: options.environment,
            logger
          }),
          new CodexProvider({
            runtimeDirectory: options.runtimeDirectory,
            environment: options.environment,
            logger
          })
        ],
        logger
      )
    const session = new BridgeSession(ws, {
      providerManager,
      logger
    })
    sessions.add(session)
    ws.once('close', () => {
      void session.close('Browser connection closed').finally(() => {
        sessions.delete(session)
        logger.log('[sidecar] renderer disconnected')
      })
    })
  })

  wss.on('error', (error) => {
    logger.error('[sidecar] WebSocket server error', error)
    if (!listening) rejectReady?.(error)
  })

  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    closing = true
    closePromise = (async () => {
      await Promise.all(
        [...sessions].map((session) => session.close('Sidecar shutting down'))
      )
      sessions.clear()
      for (const client of wss.clients) client.close(1001, 'Sidecar shutting down')

      await new Promise<void>((resolve) => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          clearTimeout(forceTimer)
          resolve()
        }
        const forceTimer = setTimeout(() => {
          for (const client of wss.clients) client.terminate()
          finish()
        }, closeTimeoutMs)
        forceTimer.unref()

        try {
          wss.close((error) => {
            if (error) logger.error('[sidecar] shutdown error', error)
            finish()
          })
        } catch (error) {
          logger.error('[sidecar] shutdown error', error)
          for (const client of wss.clients) client.terminate()
          finish()
        }
      })
      logger.log('[sidecar] stopped')
    })()
    return closePromise
  }

  return { ready, close }
}
