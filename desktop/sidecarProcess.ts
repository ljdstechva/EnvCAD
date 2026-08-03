import path from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  turnJournalResultSchema,
  type TurnJournalPort
} from '../shared/agent-contracts'
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
  type SidecarWorkerStartMessage,
  type SidecarWorkerTurnJournalRequest
} from './runtimeProtocol'

const WORKER_SHUTDOWN_TIMEOUT_MS = 3_000
const DEFAULT_RESTART_BASE_DELAY_MS = 100
const DEFAULT_RESTART_MAX_DELAY_MS = 2_000
const DEFAULT_RESTART_WINDOW_MS = 60_000
const DEFAULT_MAX_RESTARTS = 5

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
  inputStoreDirectory: string
  fork: UtilityProcessFork
  onStatus(status: SidecarStatus): void
  logger: SidecarProcessLogger
  turnJournal: TurnJournalPort
  environment?: NodeJS.ProcessEnv
  shutdownTimeoutMs?: number
  sessionTokenFactory?: () => string
  restartBaseDelayMs?: number
  restartMaxDelayMs?: number
  restartWindowMs?: number
  maxRestarts?: number
  random?: () => number
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
  private readonly inFlightTurnJournalRequests = new Set<Promise<void>>()
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private readonly restartTimestamps: number[] = []
  private consecutiveRestarts = 0
  private spawnCount = 0
  private currentSessionToken: string
  private currentStatus: SidecarStatus = {
    type: 'starting',
    message: 'Starting AI Assistant...'
  }

  constructor(private readonly options: SidecarProcessOptions) {
    this.currentSessionToken = options.sessionToken
  }

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
    if (this.closing || this.child || this.restartTimer) return
    await this.spawn('Starting AI Assistant...')
  }

  private async spawn(message: string): Promise<void> {
    if (this.closing || this.child) return
    this.emit({ type: 'starting', message })
    this.currentSessionToken = this.nextSessionToken()
    this.spawnCount += 1
    const startCommand: SidecarWorkerStartMessage = {
      type: 'start',
      host: '127.0.0.1',
      port: 0,
      permittedOrigin: this.options.permittedOrigin,
      sessionToken: this.currentSessionToken,
      runtimeDirectory: this.options.runtimeDirectory,
      inputStoreDirectory: this.options.inputStoreDirectory
    }
    let child: UtilityProcessLike | undefined
    try {
      child = this.options.fork(path.resolve(this.options.workerPath), {
        env: sanitizedWorkerEnvironment(this.options.environment ?? process.env),
        serviceName: 'EnvCAD AI Assistant'
      })
      this.child = child
      const startedChild = child
      child.on('message', (message) =>
        this.handleWorkerEvent(workerMessage(message), startedChild)
      )
      child.on('error', (error) => {
        if (this.closing || this.child !== startedChild) return
        this.options.logger.warn(
          `AI Assistant process error before exit: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      })
      child.on('exit', (code) => {
        if (this.child !== startedChild) return
        this.child = undefined
        this.stoppedResolver?.()
        if (!this.closing) this.scheduleRestart(code)
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
        this.options.logger.error(
          `AI Assistant process could not start: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        this.scheduleRestart(undefined)
      }
    }
  }

  private scheduleRestart(exitCode: number | undefined): void {
    if (this.closing || this.restartTimer) return
    const now = Date.now()
    const restartWindow =
      this.options.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS
    while (
      this.restartTimestamps.length > 0 &&
      now - this.restartTimestamps[0] > restartWindow
    ) {
      this.restartTimestamps.shift()
    }
    const maximumRestarts = this.options.maxRestarts ?? DEFAULT_MAX_RESTARTS
    if (this.restartTimestamps.length >= maximumRestarts) {
      this.emit({
        type: 'failed',
        message:
          'AI Assistant restart circuit opened after repeated crashes. CAD editing remains available; restart EnvCAD after reviewing diagnostics.'
      })
      return
    }
    this.restartTimestamps.push(now)
    this.consecutiveRestarts += 1
    const baseDelay =
      this.options.restartBaseDelayMs ?? DEFAULT_RESTART_BASE_DELAY_MS
    const maximumDelay =
      this.options.restartMaxDelayMs ?? DEFAULT_RESTART_MAX_DELAY_MS
    const exponential = Math.min(
      maximumDelay,
      baseDelay * 2 ** Math.max(0, this.consecutiveRestarts - 1)
    )
    const random = this.options.random ?? Math.random
    const delayMs = Math.max(
      0,
      Math.round(exponential * (0.75 + random() * 0.5))
    )
    const detail =
      exitCode === undefined ? 'could not start' : `exited with code ${exitCode}`
    this.emit({
      type: 'starting',
      message: `AI Assistant ${detail}; recovering in ${delayMs} ms...`
    })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      void this.spawn('Restarting AI Assistant after an unexpected stop...')
    }, delayMs)
  }

  private nextSessionToken(): string {
    if (this.spawnCount === 0) return this.options.sessionToken
    return (
      this.options.sessionTokenFactory?.() ??
      randomBytes(32).toString('base64url')
    )
  }

  private handleWorkerEvent(
    event: unknown,
    source: UtilityProcessLike
  ): void {
    if (!isSidecarWorkerEvent(event)) {
      this.options.logger.warn('Ignored an invalid AI Assistant worker event.')
      return
    }
    if (source !== this.child) {
      if (event.type === 'turn-journal-request') {
        this.replyTurnJournalFailure(
          source,
          event.requestId,
          'turn-journal-unavailable',
          'Durable turn state is unavailable for this AI runtime.'
        )
      }
      return
    }
    if (event.type === 'log') {
      this.logWorkerEvent(event)
      return
    }
    if (event.type === 'turn-journal-request') {
      const request = this.handleTurnJournalRequest(event, source)
      this.inFlightTurnJournalRequests.add(request)
      void request.then(
        () => this.inFlightTurnJournalRequests.delete(request),
        () => this.inFlightTurnJournalRequests.delete(request)
      )
      return
    }
    if (event.type === 'ready') {
      this.emit({
        type: 'ready',
        message: event.message,
        connection: desktopConnectionConfig(
          event.host,
          event.port,
          this.currentSessionToken
        )
      })
      this.consecutiveRestarts = 0
      return
    }
    this.emit(event)
    if (event.type === 'stopped') this.stoppedResolver?.()
  }

  private async handleTurnJournalRequest(
    event: SidecarWorkerTurnJournalRequest,
    source: UtilityProcessLike
  ): Promise<void> {
    if (source !== this.child) {
      this.replyTurnJournalFailure(
        source,
        event.requestId,
        'turn-journal-unavailable',
        'Durable turn state is unavailable for this AI runtime.'
      )
      return
    }
    try {
      const result = turnJournalResultSchema.parse(
        await this.options.turnJournal.execute(event.command)
      )
      source.postMessage({
        type: 'turn-journal-response',
        requestId: event.requestId,
        ok: true,
        result
      })
    } catch (error) {
      this.options.logger.error(
        `Durable turn journal request failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      this.replyTurnJournalFailure(
        source,
        event.requestId,
        'turn-journal-failed',
        'Durable turn state could not be updated.'
      )
    }
  }

  private replyTurnJournalFailure(
    source: UtilityProcessLike,
    requestId: string,
    code: string,
    message: string
  ): void {
    try {
      source.postMessage({
        type: 'turn-journal-response',
        requestId,
        ok: false,
        error: { code, message }
      })
    } catch (error) {
      this.options.logger.error(
        `Could not return a turn-journal response to the AI runtime: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
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
    clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    this.closePromise = (async () => {
      try {
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
      } finally {
        await Promise.allSettled([...this.inFlightTurnJournalRequests])
      }
    })()
    return this.closePromise
  }
}
