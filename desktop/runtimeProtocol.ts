export const ENVCAD_WEBSOCKET_PROTOCOL = 'envcad.v1'
export const DEVELOPMENT_SESSION_TOKEN = 'browser-development'
export const DESKTOP_IPC = {
  getRuntimeConfig: 'envcad:get-runtime-config',
  sidecarStatus: 'envcad:sidecar-status',
  openLogFolder: 'envcad:open-log-folder'
} as const

export type SidecarStatusType =
  | 'starting'
  | 'ready'
  | 'authentication-required'
  | 'unsafe-api-key-environment'
  | 'failed'
  | 'stopped'

export interface SidecarConnectionConfig {
  url: string
  protocols: [typeof ENVCAD_WEBSOCKET_PROTOCOL, string]
}

export type SidecarStatus =
  | { type: 'starting'; message: string }
  | { type: 'ready'; message: string; connection: SidecarConnectionConfig }
  | { type: 'authentication-required'; message: string }
  | { type: 'unsafe-api-key-environment'; message: string }
  | { type: 'failed'; message: string }
  | { type: 'stopped'; message: string }

export interface DesktopRuntimeConfig {
  mode: 'desktop'
  rendererOrigin: string
  sidecar: SidecarStatus
}

export interface SidecarWorkerStartMessage {
  type: 'start'
  host: string
  port: number
  permittedOrigin: string
  sessionToken: string
  claudeExecutablePath: string
}

export interface SidecarWorkerShutdownMessage {
  type: 'shutdown'
}

export type SidecarWorkerCommand = SidecarWorkerStartMessage | SidecarWorkerShutdownMessage

export type SidecarWorkerEvent =
  | { type: 'starting'; message: string }
  | { type: 'ready'; host: string; port: number; message: string }
  | { type: 'authentication-required'; message: string }
  | { type: 'unsafe-api-key-environment'; message: string }
  | { type: 'failed'; message: string }
  | { type: 'stopped'; message: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }

export interface EnvCadDesktopApi {
  getRuntimeConfig(): Promise<DesktopRuntimeConfig>
  onSidecarStatus(callback: (status: SidecarStatus) => void): () => void
  openLogFolder(): Promise<{ ok: boolean; error?: string }>
}

export function sessionTokenProtocol(token: string): string {
  return `envcad.session.${token}`
}

export function desktopConnectionConfig(
  host: string,
  port: number,
  sessionToken: string
): SidecarConnectionConfig {
  return {
    url: `ws://${host}:${port}`,
    protocols: [ENVCAD_WEBSOCKET_PROTOCOL, sessionTokenProtocol(sessionToken)]
  }
}

export function isSidecarWorkerCommand(value: unknown): value is SidecarWorkerCommand {
  if (!value || typeof value !== 'object') return false
  const type = (value as { type?: unknown }).type
  if (type === 'shutdown') return true
  if (type !== 'start') return false
  const candidate = value as Partial<SidecarWorkerStartMessage>
  return (
    typeof candidate.host === 'string' &&
    Number.isInteger(candidate.port) &&
    typeof candidate.permittedOrigin === 'string' &&
    typeof candidate.sessionToken === 'string' &&
    candidate.sessionToken.length >= 32 &&
    typeof candidate.claudeExecutablePath === 'string' &&
    candidate.claudeExecutablePath.length > 0
  )
}

export function isSidecarWorkerEvent(value: unknown): value is SidecarWorkerEvent {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { type?: unknown; message?: unknown }
  if (typeof candidate.type !== 'string' || typeof candidate.message !== 'string') return false
  if (candidate.type === 'ready') {
    const ready = value as { host?: unknown; port?: unknown }
    return typeof ready.host === 'string' && Number.isInteger(ready.port)
  }
  if (candidate.type === 'log') {
    const log = value as { level?: unknown }
    return log.level === 'info' || log.level === 'warn' || log.level === 'error'
  }
  return (
    candidate.type === 'starting' ||
    candidate.type === 'authentication-required' ||
    candidate.type === 'unsafe-api-key-environment' ||
    candidate.type === 'failed' ||
    candidate.type === 'stopped'
  )
}

export function isSidecarStatus(value: unknown): value is SidecarStatus {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { type?: unknown; message?: unknown; connection?: unknown }
  if (typeof candidate.type !== 'string' || typeof candidate.message !== 'string') return false
  if (candidate.type === 'ready') {
    const connection = candidate.connection as
      | { url?: unknown; protocols?: unknown }
      | null
      | undefined
    return (
      Boolean(connection) &&
      typeof connection?.url === 'string' &&
      Array.isArray(connection.protocols) &&
      connection.protocols.length === 2 &&
      connection.protocols.every((protocol) => typeof protocol === 'string')
    )
  }
  return (
    candidate.type === 'starting' ||
    candidate.type === 'authentication-required' ||
    candidate.type === 'unsafe-api-key-environment' ||
    candidate.type === 'failed' ||
    candidate.type === 'stopped'
  )
}
