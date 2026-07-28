export const ENVCAD_WEBSOCKET_PROTOCOL = 'envcad.v1'
export const DEVELOPMENT_SESSION_TOKEN = 'browser-development'
export const DESKTOP_IPC = {
  getRuntimeConfig: 'envcad:get-runtime-config',
  sidecarStatus: 'envcad:sidecar-status',
  openLogFolder: 'envcad:open-log-folder',
  getAiPreferences: 'envcad:get-ai-preferences',
  saveAiPreferences: 'envcad:save-ai-preferences',
  getSheetPreference: 'envcad:get-sheet-preference',
  saveSheetPreference: 'envcad:save-sheet-preference'
} as const

import type { AiPreferences } from './aiPreferences'
import type { SheetDefinition } from '../src/sheet/types'

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
  runtimeDirectory: string
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
  getAiPreferences(): Promise<AiPreferences>
  saveAiPreferences(preferences: AiPreferences): Promise<AiPreferences>
  getSheetPreference(documentName: string): Promise<SheetDefinition | undefined>
  saveSheetPreference(
    documentName: string,
    sheet: SheetDefinition
  ): Promise<SheetDefinition>
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}

export function isSidecarWorkerCommand(value: unknown): value is SidecarWorkerCommand {
  if (!isRecord(value)) return false
  const type = value.type
  if (type === 'shutdown') return hasOnlyKeys(value, ['type'])
  if (type !== 'start') return false
  return (
    hasOnlyKeys(value, [
      'type',
      'host',
      'port',
      'permittedOrigin',
      'sessionToken',
      'runtimeDirectory'
    ]) &&
    value.host === '127.0.0.1' &&
    value.port === 0 &&
    typeof value.permittedOrigin === 'string' &&
    value.permittedOrigin.length <= 500 &&
    typeof value.sessionToken === 'string' &&
    value.sessionToken.length >= 32 &&
    value.sessionToken.length <= 200 &&
    typeof value.runtimeDirectory === 'string' &&
    value.runtimeDirectory.length > 0 &&
    value.runtimeDirectory.length <= 1_000
  )
}

export function isSidecarWorkerEvent(value: unknown): value is SidecarWorkerEvent {
  if (!isRecord(value)) return false
  if (
    typeof value.type !== 'string' ||
    typeof value.message !== 'string' ||
    value.message.length > 8_000
  ) {
    return false
  }
  if (value.type === 'ready') {
    return (
      hasOnlyKeys(value, ['type', 'host', 'port', 'message']) &&
      value.host === '127.0.0.1' &&
      Number.isInteger(value.port) &&
      (value.port as number) >= 1 &&
      (value.port as number) <= 65_535
    )
  }
  if (value.type === 'log') {
    return (
      hasOnlyKeys(value, ['type', 'level', 'message']) &&
      (value.level === 'info' ||
        value.level === 'warn' ||
        value.level === 'error')
    )
  }
  return (
    hasOnlyKeys(value, ['type', 'message']) &&
    (value.type === 'starting' ||
      value.type === 'authentication-required' ||
      value.type === 'unsafe-api-key-environment' ||
      value.type === 'failed' ||
      value.type === 'stopped')
  )
}

export function isSidecarStatus(value: unknown): value is SidecarStatus {
  if (
    !isRecord(value) ||
    typeof value.type !== 'string' ||
    typeof value.message !== 'string' ||
    value.message.length > 8_000
  ) {
    return false
  }
  if (value.type === 'ready') {
    const connection = value.connection
    return (
      hasOnlyKeys(value, ['type', 'message', 'connection']) &&
      isRecord(connection) &&
      hasOnlyKeys(connection, ['url', 'protocols']) &&
      typeof connection.url === 'string' &&
      /^ws:\/\/127\.0\.0\.1:\d{1,5}$/.test(connection.url) &&
      Array.isArray(connection.protocols) &&
      connection.protocols.length === 2 &&
      connection.protocols[0] === ENVCAD_WEBSOCKET_PROTOCOL &&
      typeof connection.protocols[1] === 'string' &&
      connection.protocols[1].startsWith('envcad.session.') &&
      connection.protocols[1].length <= 300
    )
  }
  return (
    hasOnlyKeys(value, ['type', 'message']) &&
    (value.type === 'starting' ||
      value.type === 'authentication-required' ||
      value.type === 'unsafe-api-key-environment' ||
      value.type === 'failed' ||
      value.type === 'stopped')
  )
}
