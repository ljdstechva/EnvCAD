import path from 'node:path'
import {
  ACCEPTANCE_EVIDENCE_ENVIRONMENT_NAME,
  BLOCKED_SECRET_ENVIRONMENT_NAMES,
  sanitizedProviderEnvironment
} from '../sidecar/src/providers/environment'
import {
  desktopConnectionConfig,
  isSidecarWorkerEvent,
  type SidecarStatus,
  type SidecarWorkerEvent,
  type SidecarWorkerStartMessage
} from './runtimeProtocol'

const WORKER_SHUTDOWN_TIMEOUT_MS = 3_000

export interface UtilityProcessLike {
  postMessage(message: unknown): void
  kill(): boolean
  on(event: 'message', listener: (message: unknown) => void): this
  on(event: 'exit', listener: (code: number) => void): this
  on(event: 'error', listener: (error: unknown) => void): this
}

export type UtilityProcessFork = (
  modulePath: string,
  options: { env: NodeJS.ProcessEnv; serviceName: string }
) => UtilityProcessLike

export interface SidecarProcessLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface SidecarProcessOptions {
  workerPath: string
  permittedOrigin: string
  sessionToken: string
  runtimeDirectory: string
  fork: UtilityProcessFork
  onStatus(status: SidecarStatus): void
  logger: SidecarProcessLogger
  environment?: NodeJS.ProcessEnv
  shutdownTimeoutMs?: number
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  requestedName: string
): string | undefined {
  const key = Object.keys(environment).find(
    (name) => name.toLowerCase() === requestedName.toLowerCase()
  )
  return key ? environment[key] : undefined
}

/**
 * Utility processes receive only provider-runtime essentials. If a forbidden
 * key exists in the parent, pass a non-secret sentinel under the same name so
 * the affected adapter can visibly reject that authentication path.
 */
export function sanitizedWorkerEnvironment(
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const evidencePath = environmentValue(
    environment,
    ACCEPTANCE_EVIDENCE_ENVIRONMENT_NAME
  )
  const safe = sanitizedProviderEnvironment(
    environment,
    evidencePath
      ? { [ACCEPTANCE_EVIDENCE_ENVIRONMENT_NAME]: evidencePath }
      : {}
  )
  for (const name of BLOCKED_SECRET_ENVIRONMENT_NAMES) {
    if (environmentValue(environment, name)?.trim()) {
      safe[name] = '[blocked-by-envcad]'
    }
  }
  return safe
}

function workerMessage(value: unknown): unknown {
  if (value && typeof value === 'object' && 'data' in value) {
    return (value as { data: unknown }).data
  }
  return value
}

export class SidecarProcess {
  private child: UtilityProcessLike | undefined
  private closePromise: Promise<void> | undefined
  private closing = false
  private stoppedResolver: (() => void) | undefined
  private currentStatus: SidecarStatus = {
    type: 'starting',
    message: 'Starting AI Assistant...'
  }

  constructor(private readonly options: SidecarProcessOptions) {}

  get status(): SidecarStatus {
    return this.currentStatus
  }

  private emit(status: SidecarStatus): void {
    this.currentStatus = status
    this.options.onStatus(status)
    if (status.type === 'failed') this.options.logger.error(status.message)
    else if (
      status.type === 'authentication-required' ||
      status.type === 'unsafe-api-key-environment'
    ) {
      this.options.logger.warn(status.message)
    } else {
      this.options.logger.info(status.message)
    }
  }

  async start(): Promise<void> {
    if (this.closing || this.child) return
    this.emit({ type: 'starting', message: 'Starting AI Assistant...' })

    const startCommand: SidecarWorkerStartMessage = {
      type: 'start',
      host: '127.0.0.1',
      port: 0,
      permittedOrigin: this.options.permittedOrigin,
      sessionToken: this.options.sessionToken,
      runtimeDirectory: this.options.runtimeDirectory
    }
    let child: UtilityProcessLike | undefined
    try {
      child = this.options.fork(path.resolve(this.options.workerPath), {
        env: sanitizedWorkerEnvironment(this.options.environment ?? process.env),
        serviceName: 'EnvCAD AI Assistant'
      })
      this.child = child
      child.on('message', (message) => this.handleWorkerEvent(workerMessage(message)))
      child.on('error', (error) => {
        if (!this.closing) {
          this.emit({
            type: 'failed',
            message: `AI Assistant process failed: ${
              error instanceof Error ? error.message : String(error)
            }. CAD editing remains available.`
          })
        }
      })
      child.on('exit', (code) => {
        this.child = undefined
        this.stoppedResolver?.()
        if (!this.closing && this.currentStatus.type !== 'failed') {
          this.emit({
            type: 'failed',
            message: `AI Assistant stopped unexpectedly (exit code ${code}). CAD editing remains available.`
          })
        }
      })
      child.postMessage(startCommand)
    } catch (error) {
      this.child = undefined
      try {
        child?.kill()
      } catch {
        this.options.logger.warn(
          'AI Assistant startup cleanup could not terminate its utility process.'
        )
      }
      if (!this.closing) {
        this.emit({
          type: 'failed',
          message: `AI Assistant process could not start: ${
            error instanceof Error ? error.message : String(error)
          }. CAD editing remains available.`
        })
      }
    }
  }

  private handleWorkerEvent(event: unknown): void {
    if (!isSidecarWorkerEvent(event)) {
      this.options.logger.warn('Ignored an invalid AI Assistant worker event.')
      return
    }
    if (event.type === 'log') {
      this.logWorkerEvent(event)
      return
    }
    if (event.type === 'ready') {
      this.emit({
        type: 'ready',
        message: event.message,
        connection: desktopConnectionConfig(
          event.host,
          event.port,
          this.options.sessionToken
        )
      })
      return
    }
    this.emit(event)
    if (event.type === 'stopped') this.stoppedResolver?.()
  }

  private logWorkerEvent(
    event: Extract<SidecarWorkerEvent, { type: 'log' }>
  ): void {
    if (event.level === 'error') this.options.logger.error(event.message)
    else if (event.level === 'warn') this.options.logger.warn(event.message)
    else this.options.logger.info(event.message)
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.closePromise = (async () => {
      const child = this.child
      if (!child) {
        this.emit({ type: 'stopped', message: 'AI Assistant stopped.' })
        return
      }

      const stopped = new Promise<void>((resolve) => {
        this.stoppedResolver = resolve
      })
      try {
        child.postMessage({ type: 'shutdown' })
      } catch (error) {
        this.options.logger.warn(
          `AI Assistant shutdown request failed: ${
            error instanceof Error ? error.message : String(error)
          }; terminating its utility process.`
        )
        try {
          child.kill()
        } catch (killError) {
          this.options.logger.error(
            `AI Assistant utility-process termination failed: ${
              killError instanceof Error
                ? killError.message
                : String(killError)
            }`
          )
        }
        this.child = undefined
        this.emit({ type: 'stopped', message: 'AI Assistant stopped.' })
        return
      }
      const timeoutMs =
        this.options.shutdownTimeoutMs ?? WORKER_SHUTDOWN_TIMEOUT_MS
      let shutdownTimer: ReturnType<typeof setTimeout> | undefined
      const timedOut = await Promise.race([
        stopped.then(() => false),
        new Promise<boolean>((resolve) => {
          shutdownTimer = setTimeout(() => resolve(true), timeoutMs)
        })
      ])
      clearTimeout(shutdownTimer)
      if (timedOut && this.child === child) {
        this.options.logger.warn(
          'AI Assistant did not stop in time; terminating its utility process.'
        )
        try {
          child.kill()
        } catch (error) {
          this.options.logger.error(
            `AI Assistant utility-process termination failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        }
      }
      this.child = undefined
      if (this.currentStatus.type !== 'stopped') {
        this.emit({ type: 'stopped', message: 'AI Assistant stopped.' })
      }
    })()
    return this.closePromise
  }
}
