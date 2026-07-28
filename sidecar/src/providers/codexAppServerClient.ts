import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import { redactProviderDiagnostic, sanitizedProviderEnvironment } from './environment'
import type { ProviderLogger } from './types'
import { buildCodexProcessOverrides } from './codexSecurityConfig'

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000
const MAX_JSONL_LINE_LENGTH = 2 * 1024 * 1024

type RequestId = number | string

interface PendingRequest {
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export interface CodexNotification {
  method: string
  params: unknown
  emittedAtMs?: number
}

export interface CodexServerRequest {
  id: RequestId
  method: string
  params: unknown
}

export type CodexNotificationListener = (notification: CodexNotification) => void
export type CodexProtocolErrorListener = (error: Error) => void
export type CodexServerRequestHandler = (request: CodexServerRequest) => Promise<unknown>

export interface CodexAppServerClientOptions {
  executablePath: string
  runtimeDirectory: string
  environment?: NodeJS.ProcessEnv
  logger?: ProviderLogger
  requestTimeoutMs?: number
  closeTimeoutMs?: number
  spawnProcess?: typeof spawn
  disabledMcpServerNames?: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRequestId(value: unknown): value is RequestId {
  return (
    (typeof value === 'number' && Number.isSafeInteger(value)) ||
    (typeof value === 'string' && value.length > 0 && value.length <= 200)
  )
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every((key) => keys.has(key))
}

function responseError(method: string, value: unknown): Error {
  if (!isRecord(value)) return new Error(`${method} failed with an invalid app-server error`)
  const message =
    typeof value.message === 'string' && value.message.trim()
      ? value.message
      : 'unknown app-server error'
  const code =
    typeof value.code === 'number' || typeof value.code === 'string'
      ? ` (${String(value.code)})`
      : ''
  return new Error(`${method} failed${code}: ${redactProviderDiagnostic(message)}`)
}

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | undefined
  private readline: ReadlineInterface | undefined
  private nextRequestId = 1
  private readonly pending = new Map<string, PendingRequest>()
  private readonly notificationListeners = new Set<CodexNotificationListener>()
  private readonly protocolErrorListeners = new Set<CodexProtocolErrorListener>()
  private serverRequestHandler: CodexServerRequestHandler | undefined
  private closePromise: Promise<void> | undefined
  private started = false
  private closing = false
  private readonly logger: ProviderLogger

  constructor(private readonly options: CodexAppServerClientOptions) {
    this.logger = options.logger ?? console
  }

  async start(): Promise<void> {
    if (this.started) return
    if (this.closing) throw new Error('Codex app-server client is closing.')
    this.started = true
    const child = (this.options.spawnProcess ?? spawn)(
      this.options.executablePath,
      [
        ...buildCodexProcessOverrides(
          this.options.disabledMcpServerNames ?? []
        ).flatMap((override) => ['-c', override]),
        'app-server',
        '--stdio'
      ],
      {
        cwd: this.options.runtimeDirectory,
        env: sanitizedProviderEnvironment(this.options.environment ?? process.env),
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    ) as ChildProcessWithoutNullStreams
    this.child = child
    child.stderr.on('data', () => {
      // App-server stderr may include machine paths or auth diagnostics. Never
      // forward it to the renderer or logs; process exit is reported generically.
    })
    child.once('error', (error) => {
      if (this.child === child) this.child = undefined
      this.fail(new Error(`Codex app-server failed to start: ${error.message}`))
    })
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = undefined
      if (!this.closing) {
        const detail = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`
        this.fail(new Error(`Codex app-server exited unexpectedly (${detail}).`))
      }
    })
    this.readline = createInterface({ input: child.stdout })
    this.readline.on('line', (line) => this.handleLine(line))

    await this.request('initialize', {
      clientInfo: {
        name: 'envcad',
        title: 'EnvCAD',
        version: '0.2.1'
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false
      }
    })
    this.notify('initialized', {})
  }

  onNotification(listener: CodexNotificationListener): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  onProtocolError(listener: CodexProtocolErrorListener): () => void {
    this.protocolErrorListeners.add(listener)
    return () => this.protocolErrorListeners.delete(listener)
  }

  setServerRequestHandler(handler: CodexServerRequestHandler | undefined): void {
    this.serverRequestHandler = handler
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.child || this.closing) {
      return Promise.reject(new Error(`Cannot call ${method}: Codex app-server is not running.`))
    }
    const id = this.nextRequestId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id))
        reject(new Error(`Codex app-server request ${method} timed out.`))
      }, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
      this.pending.set(String(id), {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer
      })
      try {
        this.write({ method, id, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(String(id))
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params })
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.closePromise = (async () => {
      const child = this.child
      this.child = undefined
      this.readline?.close()
      this.readline = undefined
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error(`Codex app-server closed while waiting for ${pending.method}.`))
      }
      this.pending.clear()
      this.notificationListeners.clear()
      this.protocolErrorListeners.clear()
      this.serverRequestHandler = undefined
      if (!child) return

      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      try {
        child.stdin.end()
      } catch {
        // The process may already have exited.
      }
      let closeTimer: ReturnType<typeof setTimeout> | undefined
      const timedOut = await Promise.race([
        exited.then(() => false),
        new Promise<boolean>((resolve) => {
          closeTimer = setTimeout(
            () => resolve(true),
            this.options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS
          )
        })
      ])
      clearTimeout(closeTimer)
      if (timedOut) {
        child.kill()
        await Promise.race([
          exited,
          new Promise<void>((resolve) => setTimeout(resolve, 1_000))
        ])
      }
    })()
    return this.closePromise
  }

  private write(message: unknown): void {
    const child = this.child
    if (!child || child.stdin.destroyed || !child.stdin.writable) {
      throw new Error('Codex app-server stdin is unavailable.')
    }
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private handleLine(line: string): void {
    if (line.length > MAX_JSONL_LINE_LENGTH) {
      this.protocolViolation('Codex app-server emitted an oversized JSONL message.')
      return
    }
    let decoded: unknown
    try {
      decoded = JSON.parse(line)
    } catch {
      this.protocolViolation('Codex app-server emitted malformed JSONL.')
      return
    }
    if (!isRecord(decoded)) {
      this.protocolViolation('Codex app-server emitted a non-object message.')
      return
    }

    if (hasOwn(decoded, 'id') && (hasOwn(decoded, 'result') || hasOwn(decoded, 'error'))) {
      if (
        !isRequestId(decoded.id) ||
        !hasOnlyKeys(decoded, ['id', 'result', 'error']) ||
        hasOwn(decoded, 'result') === hasOwn(decoded, 'error')
      ) {
        this.protocolViolation('Codex app-server response has an invalid request id.')
        return
      }
      const pending = this.pending.get(String(decoded.id))
      if (!pending) {
        this.protocolViolation(`Codex app-server response referenced unknown request id "${String(decoded.id)}".`)
        return
      }
      clearTimeout(pending.timer)
      this.pending.delete(String(decoded.id))
      if (hasOwn(decoded, 'error')) pending.reject(responseError(pending.method, decoded.error))
      else pending.resolve(decoded.result)
      return
    }

    if (hasOwn(decoded, 'id') && hasOwn(decoded, 'method')) {
      if (
        !isRequestId(decoded.id) ||
        typeof decoded.method !== 'string' ||
        !hasOwn(decoded, 'params') ||
        !hasOnlyKeys(decoded, ['id', 'method', 'params'])
      ) {
        this.protocolViolation('Codex app-server emitted a malformed server request.')
        return
      }
      void this.handleServerRequest({
        id: decoded.id,
        method: decoded.method,
        params: decoded.params
      }).catch((error) => {
        this.protocolViolation(
          `Codex server-request handling failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      })
      return
    }

    if (
      !hasOwn(decoded, 'id') &&
      typeof decoded.method === 'string' &&
      hasOwn(decoded, 'params') &&
      hasOnlyKeys(decoded, ['method', 'params', 'emittedAtMs']) &&
      (decoded.emittedAtMs === undefined ||
        (Number.isSafeInteger(decoded.emittedAtMs) &&
          (decoded.emittedAtMs as number) >= 0))
    ) {
      const notification = {
        method: decoded.method,
        params: decoded.params,
        ...(typeof decoded.emittedAtMs === 'number'
          ? { emittedAtMs: decoded.emittedAtMs }
          : {})
      }
      for (const listener of this.notificationListeners) {
        try {
          listener(notification)
        } catch (error) {
          this.protocolViolation(
            `Codex notification handler failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
          return
        }
      }
      return
    }

    this.protocolViolation(
      `Codex app-server emitted an unrecognized message shape (keys: ${Object.keys(
        decoded
      )
        .sort()
        .join(', ')}).`
    )
  }

  private async handleServerRequest(request: CodexServerRequest): Promise<void> {
    if (request.method !== 'item/tool/call' || !this.serverRequestHandler) {
      const error = new Error(
        `Codex security boundary rejected server request "${request.method}".`
      )
      this.write({
        id: request.id,
        error: { code: -32_000, message: error.message }
      })
      this.protocolViolation(error.message)
      return
    }
    try {
      const result = await this.serverRequestHandler(request)
      this.write({ id: request.id, result })
    } catch (error) {
      const message = redactProviderDiagnostic(
        error instanceof Error ? error.message : String(error)
      )
      this.write({
        id: request.id,
        error: { code: -32_000, message }
      })
      this.protocolViolation(`Codex dynamic tool request failed: ${message}`)
    }
  }

  private protocolViolation(message: string): void {
    const error = new Error(redactProviderDiagnostic(message))
    this.logger.error(`[sidecar] ${error.message}`)
    for (const listener of this.protocolErrorListeners) listener(error)
  }

  private fail(error: Error): void {
    const safe = new Error(redactProviderDiagnostic(error.message))
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(safe)
    }
    this.pending.clear()
    for (const listener of this.protocolErrorListeners) listener(safe)
  }
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}
