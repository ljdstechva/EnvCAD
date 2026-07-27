import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { SidecarProcess, type UtilityProcessLike } from '../sidecarProcess'
import { sessionTokenProtocol } from '../runtimeProtocol'

class FakeUtilityProcess extends EventEmitter implements UtilityProcessLike {
  messages: unknown[] = []
  kill = vi.fn(() => true)

  postMessage(message: unknown): void {
    this.messages.push(message)
  }
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function readyDiscovery() {
  return vi.fn(async () => ({
    status: 'ready' as const,
    executablePath: 'C:\\Claude\\claude.exe',
    version: '2.1.220'
  }))
}

describe('SidecarProcess', () => {
  it('publishes runtime configuration and turns a worker crash into an AI-only failure', async () => {
    const child = new FakeUtilityProcess()
    const statuses: string[] = []
    const token = 'a'.repeat(43)
    const processController = new SidecarProcess({
      workerPath: 'C:\\EnvCAD\\sidecarWorker.cjs',
      permittedOrigin: 'http://127.0.0.1:41234',
      sessionToken: token,
      fork: () => child,
      discover: readyDiscovery(),
      authenticate: vi.fn(async () => true),
      onStatus: (status) => statuses.push(status.type),
      logger: logger()
    })

    await processController.start()
    expect(child.messages[0]).toMatchObject({
      type: 'start',
      host: '127.0.0.1',
      port: 0,
      claudeExecutablePath: 'C:\\Claude\\claude.exe'
    })
    child.emit('message', {
      type: 'ready',
      host: '127.0.0.1',
      port: 43123,
      message: 'ready'
    })
    expect(processController.status).toMatchObject({
      type: 'ready',
      connection: {
        url: 'ws://127.0.0.1:43123',
        protocols: ['envcad.v1', sessionTokenProtocol(token)]
      }
    })

    child.emit('exit', 7)
    expect(processController.status).toMatchObject({ type: 'failed' })
    expect(statuses).toContain('ready')
    expect(statuses.at(-1)).toBe('failed')
  })

  it('disables AI for ANTHROPIC_API_KEY without starting or logging its value', async () => {
    const fork = vi.fn()
    const testLogger = logger()
    const secret = 'sk-ant-do-not-log-this'
    const processController = new SidecarProcess({
      workerPath: 'worker.cjs',
      permittedOrigin: 'http://127.0.0.1:41234',
      sessionToken: 'b'.repeat(43),
      environment: { ANTHROPIC_API_KEY: secret },
      fork,
      onStatus: vi.fn(),
      logger: testLogger
    })

    await processController.start()
    expect(processController.status.type).toBe('unsafe-api-key-environment')
    expect(fork).not.toHaveBeenCalled()
    expect(JSON.stringify(testLogger.warn.mock.calls)).not.toContain(secret)
  })

  it('keeps CAD available when Claude Code is installed but signed out', async () => {
    const fork = vi.fn()
    const processController = new SidecarProcess({
      workerPath: 'worker.cjs',
      permittedOrigin: 'http://127.0.0.1:41234',
      sessionToken: 'd'.repeat(43),
      fork,
      discover: readyDiscovery(),
      authenticate: vi.fn(async () => false),
      onStatus: vi.fn(),
      logger: logger()
    })

    await processController.start()
    expect(processController.status).toMatchObject({
      type: 'authentication-required',
      message: expect.stringContaining('not signed in')
    })
    expect(fork).not.toHaveBeenCalled()
  })

  it('turns synchronous utility-process startup failures into an AI-only failure state', async () => {
    const processController = new SidecarProcess({
      workerPath: 'missing-worker.cjs',
      permittedOrigin: 'http://127.0.0.1:41234',
      sessionToken: 'e'.repeat(43),
      fork: () => {
        throw new Error('worker entry point is unavailable')
      },
      discover: readyDiscovery(),
      authenticate: vi.fn(async () => true),
      onStatus: vi.fn(),
      logger: logger()
    })

    await expect(processController.start()).resolves.toBeUndefined()
    expect(processController.status).toMatchObject({
      type: 'failed',
      message: expect.stringContaining('process could not start')
    })
  })

  it('terminates a utility process when its start message cannot be posted', async () => {
    const child = new FakeUtilityProcess()
    child.postMessage = () => {
      throw new Error('message channel closed')
    }
    const processController = new SidecarProcess({
      workerPath: 'worker.cjs',
      permittedOrigin: 'http://127.0.0.1:41234',
      sessionToken: 'f'.repeat(43),
      fork: () => child,
      discover: readyDiscovery(),
      authenticate: vi.fn(async () => true),
      onStatus: vi.fn(),
      logger: logger()
    })

    await processController.start()
    expect(processController.status.type).toBe('failed')
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('performs graceful shutdown once across repeated close calls', async () => {
    const child = new FakeUtilityProcess()
    const processController = new SidecarProcess({
      workerPath: 'worker.cjs',
      permittedOrigin: 'http://127.0.0.1:41234',
      sessionToken: 'c'.repeat(43),
      fork: () => child,
      discover: readyDiscovery(),
      authenticate: vi.fn(async () => true),
      onStatus: vi.fn(),
      logger: logger()
    })
    await processController.start()

    const firstClose = processController.close()
    expect(processController.close()).toBe(firstClose)
    expect(child.messages.at(-1)).toEqual({ type: 'shutdown' })
    child.emit('message', { type: 'stopped', message: 'stopped' })
    await firstClose
    expect(child.kill).not.toHaveBeenCalled()
  })
})
