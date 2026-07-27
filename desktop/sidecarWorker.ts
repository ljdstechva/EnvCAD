import type { MessageEvent } from 'electron'
import type { SidecarWorkerCommand, SidecarWorkerEvent } from './runtimeProtocol'
import { isSidecarWorkerCommand } from './runtimeProtocol'
import { startSidecar, type SidecarHandle } from '../sidecar/src/server'

const parentPort = process.parentPort
if (!parentPort) {
  throw new Error('EnvCAD sidecar worker requires an Electron utility-process parent')
}

let handle: SidecarHandle | undefined
let started = false
let stopping = false
let sessionToken = ''

function redact(message: string): string {
  let redacted = message
    .replace(/\bsk-(?:ant|proj|svcacct)-[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/\b(?:Bearer\s+)?eyJ[A-Za-z0-9._-]+\b/gi, '[redacted]')
  if (sessionToken) redacted = redacted.split(sessionToken).join('[redacted]')
  return redacted
}

function post(event: SidecarWorkerEvent): void {
  parentPort.postMessage(event)
}

const logger = {
  log(message: string) {
    post({ type: 'log', level: 'info', message: redact(String(message)) })
  },
  error(message: string, error?: unknown) {
    const detail =
      error instanceof Error
        ? `: ${error.message}`
        : error
          ? `: ${String(error)}`
          : ''
    post({
      type: 'log',
      level: 'error',
      message: redact(`${message}${detail}`)
    })
  }
}

async function shutdown(): Promise<void> {
  if (stopping) return
  stopping = true
  try {
    await handle?.close()
  } finally {
    post({ type: 'stopped', message: 'AI Assistant stopped.' })
    setImmediate(() => process.exit(0))
  }
}

async function start(
  command: Extract<SidecarWorkerCommand, { type: 'start' }>
): Promise<void> {
  if (started) {
    post({
      type: 'failed',
      message: 'AI Assistant worker received a duplicate start request.'
    })
    return
  }
  started = true
  sessionToken = command.sessionToken
  post({ type: 'starting', message: 'Starting AI Assistant...' })

  try {
    handle = startSidecar({
      host: command.host,
      port: command.port,
      permittedOrigin: command.permittedOrigin,
      sessionToken: command.sessionToken,
      runtimeDirectory: command.runtimeDirectory,
      environment: process.env,
      logger
    })
    const address = await handle.ready
    post({
      type: 'ready',
      host: address.host,
      port: address.port,
      message:
        'AI Assistant runtime is ready; checking Claude Code and OpenAI Codex.'
    })
  } catch (error) {
    try {
      await handle?.close()
    } catch (cleanupError) {
      logger.error('AI Assistant startup cleanup failed', cleanupError)
    } finally {
      handle = undefined
    }
    post({
      type: 'failed',
      message: `AI Assistant failed to start: ${
        error instanceof Error ? redact(error.message) : 'unknown error'
      }`
    })
  }
}

parentPort.on('message', (event: MessageEvent) => {
  const command = event.data
  if (!isSidecarWorkerCommand(command)) {
    post({
      type: 'failed',
      message: 'AI Assistant worker received an invalid command.'
    })
    return
  }
  if (command.type === 'shutdown') void shutdown()
  else void start(command)
})

process.once('SIGTERM', () => void shutdown())
process.once('SIGINT', () => void shutdown())
