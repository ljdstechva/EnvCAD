import path from 'node:path'
import {
  discoverClaudeExecutable,
  isClaudeAuthenticated,
  type ClaudeDiscoveryResult
} from './claudeExecutable'
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
  fork: UtilityProcessFork
  onStatus(status: SidecarStatus): void
  logger: SidecarProcessLogger
  environment?: NodeJS.ProcessEnv
  discover?: typeof discoverClaudeExecutable
  authenticate?: typeof isClaudeAuthenticated
  shutdownTimeoutMs?: number
}

function sanitizedWorkerEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const blocked = new Set([
    'anthropic_api_key',
    'anthropic_auth_token',
    'claude_code_oauth_token'
  ])
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !blocked.has(name.toLowerCase()))
  )
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
  private lifecycleAbortController: AbortController | undefined
  private stoppedResolver: (() => void) | undefined
  private currentStatus: SidecarStatus = {
    type: 'starting',
    message: 'Starting AI Assistant…'
  }

  constructor(private readonly options: SidecarProcessOptions) {}

  get status(): SidecarStatus {
    return this.currentStatus
  }

  private emit(status: SidecarStatus): void {
    this.currentStatus = status
    this.options.onStatus(status)
    if (status.type === 'failed') this.options.logger.error(status.message)
    else if (status.type === 'authentication-required') this.options.logger.warn(status.message)
    else if (status.type === 'unsafe-api-key-environment') this.options.logger.warn(status.message)
    else this.options.logger.info(status.message)
  }

  async start(): Promise<void> {
    if (this.closing || this.child) return
    this.emit({ type: 'starting', message: 'Starting AI Assistant…' })
    const environment = this.options.environment ?? process.env
    if (environment.ANTHROPIC_API_KEY?.trim()) {
      this.emit({
        type: 'unsafe-api-key-environment',
        message:
          'AI Assistant is disabled because ANTHROPIC_API_KEY is set. EnvCAD only permits the Claude Code subscription login. Remove the variable and relaunch EnvCAD.'
      })
      return
    }

    this.lifecycleAbortController = new AbortController()
    let discovery: ClaudeDiscoveryResult
    try {
      discovery = await (this.options.discover ?? discoverClaudeExecutable)({
        environment,
        signal: this.lifecycleAbortController.signal
      })
    } catch (error) {
      if (this.closing) return
      this.emit({
        type: 'failed',
        message: `AI Assistant could not check Claude Code: ${
          error instanceof Error ? error.message : String(error)
        }. CAD editing remains available.`
      })
      return
    }
    if (this.closing) return

    if (discovery.status === 'missing') {
      this.emit({
        type: 'authentication-required',
        message:
          'Claude Code was not found. Install Claude Code, run "claude auth login", and relaunch EnvCAD. CAD editing remains available.'
      })
      return
    }
    if (discovery.status === 'incompatible') {
      this.emit({
        type: 'authentication-required',
        message:
          `Claude Code ${discovery.version} is incompatible; EnvCAD requires ${discovery.expectedVersion}. ` +
          'Update Claude Code and relaunch EnvCAD. CAD editing remains available.'
      })
      return
    }
    let authenticated: boolean
    try {
      authenticated = await (this.options.authenticate ?? isClaudeAuthenticated)(
        discovery.executablePath,
        {
          signal: this.lifecycleAbortController.signal
        }
      )
    } catch (error) {
      if (this.closing) return
      this.emit({
        type: 'failed',
        message: `AI Assistant could not check Claude Code authentication: ${
          error instanceof Error ? error.message : String(error)
        }. CAD editing remains available.`
      })
      return
    }
    if (!authenticated) {
      if (this.closing) return
      this.emit({
        type: 'authentication-required',
        message:
          'Claude Code is installed but not signed in. Run "claude auth login", then relaunch EnvCAD. CAD editing remains available.'
      })
      return
    }
    if (this.closing) return
    this.lifecycleAbortController = undefined

    const startCommand: SidecarWorkerStartMessage = {
      type: 'start',
      host: '127.0.0.1',
      port: 0,
      permittedOrigin: this.options.permittedOrigin,
      sessionToken: this.options.sessionToken,
      claudeExecutablePath: discovery.executablePath
    }
    let child: UtilityProcessLike | undefined
    try {
      child = this.options.fork(path.resolve(this.options.workerPath), {
        env: sanitizedWorkerEnvironment(environment),
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
        this.options.logger.warn('AI Assistant startup cleanup could not terminate its utility process.')
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
        connection: desktopConnectionConfig(event.host, event.port, this.options.sessionToken)
      })
      return
    }
    this.emit(event)
    if (event.type === 'stopped') this.stoppedResolver?.()
  }

  private logWorkerEvent(event: Extract<SidecarWorkerEvent, { type: 'log' }>): void {
    if (event.level === 'error') this.options.logger.error(event.message)
    else if (event.level === 'warn') this.options.logger.warn(event.message)
    else this.options.logger.info(event.message)
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.lifecycleAbortController?.abort()
    this.lifecycleAbortController = undefined
    this.closePromise = (async () => {
      const child = this.child
      if (!child) {
        this.emit({ type: 'stopped', message: 'AI Assistant stopped.' })
        return
      }

      const stopped = new Promise<void>((resolve) => {
        this.stoppedResolver = resolve
      })
      child.postMessage({ type: 'shutdown' })
      const timeoutMs = this.options.shutdownTimeoutMs ?? WORKER_SHUTDOWN_TIMEOUT_MS
      const timedOut = await Promise.race([
        stopped.then(() => false),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(true), timeoutMs)
          timer.unref()
        })
      ])
      if (timedOut && this.child === child) {
        this.options.logger.warn('AI Assistant did not stop in time; terminating its utility process.')
        child.kill()
      }
      this.child = undefined
      if (this.currentStatus.type !== 'stopped') {
        this.emit({ type: 'stopped', message: 'AI Assistant stopped.' })
      }
    })()
    return this.closePromise
  }
}
