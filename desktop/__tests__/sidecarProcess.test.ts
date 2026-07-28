import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  SidecarProcess,
  sanitizedWorkerEnvironment,
  type UtilityProcessLike
} from '../sidecarProcess'
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

function options(child: FakeUtilityProcess, token = 'a'.repeat(43)) {
  return {
    workerPath: 'C:\\EnvCAD\\sidecarWorker.cjs',
    permittedOrigin: 'http://127.0.0.1:41234',
    sessionToken: token,
    runtimeDirectory:
      'C:\\Users\\test\\AppData\\Local\\EnvCAD\\ai-runtime\\session-test',
    fork: () => child,
    onStatus: vi.fn(),
    logger: logger()
  }
}

describe('SidecarProcess', () => {
  it('starts the neutral worker immediately and publishes runtime configuration', async () => {
    const child = new FakeUtilityProcess()
    const token = 'a'.repeat(43)
    const statuses: string[] = []
    const processController = new SidecarProcess({
      ...options(child, token),
      onStatus: (status) => statuses.push(status.type)
    })

    await processController.start()
    expect(child.messages[0]).toEqual({
      type: 'start',
      host: '127.0.0.1',
      port: 0,
      permittedOrigin: 'http://127.0.0.1:41234',
      sessionToken: token,
      runtimeDirectory:
        'C:\\Users\\test\\AppData\\Local\\EnvCAD\\ai-runtime\\session-test'
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

  it('passes only an allowlisted environment and replaces secret values with sentinels', () => {
    const secret = 'sk-ant-do-not-log-this'
    const environment = sanitizedWorkerEnvironment({
      ENVCAD_ACCEPTANCE_EVIDENCE_PATH:
        'C:\\acceptance\\provider-prompt-evidence.jsonl',
      PATH: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\test',
      ANTHROPIC_API_KEY: secret,
      OPENAI_API_KEY: 'sk-proj-also-secret',
      UNRELATED_SECRET: 'do-not-forward'
    })

    expect(environment).toMatchObject({
      ENVCAD_ACCEPTANCE_EVIDENCE_PATH:
        'C:\\acceptance\\provider-prompt-evidence.jsonl',
      PATH: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\test',
      ANTHROPIC_API_KEY: '[blocked-by-envcad]',
      OPENAI_API_KEY: '[blocked-by-envcad]'
    })
    expect(environment).not.toHaveProperty('UNRELATED_SECRET')
    expect(JSON.stringify(environment)).not.toContain(secret)
    expect(JSON.stringify(environment)).not.toContain('sk-proj-also-secret')
  })

  it('turns synchronous startup failures into an AI-only failure state', async () => {
    const child = new FakeUtilityProcess()
    const processController = new SidecarProcess({
      ...options(child),
      fork: () => {
        throw new Error('worker entry point is unavailable')
      }
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
    const processController = new SidecarProcess(options(child))

    await processController.start()
    expect(processController.status.type).toBe('failed')
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('performs graceful shutdown once across repeated close calls', async () => {
    const child = new FakeUtilityProcess()
    const processController = new SidecarProcess(options(child))
    await processController.start()

    const firstClose = processController.close()
    expect(processController.close()).toBe(firstClose)
    expect(child.messages.at(-1)).toEqual({ type: 'shutdown' })
    child.emit('message', { type: 'stopped', message: 'stopped' })
    await firstClose
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('terminates the utility process if the shutdown message channel has closed', async () => {
    const child = new FakeUtilityProcess()
    const processController = new SidecarProcess(options(child))
    await processController.start()
    child.postMessage = () => {
      throw new Error('message channel closed')
    }

    await expect(processController.close()).resolves.toBeUndefined()
    expect(child.kill).toHaveBeenCalledOnce()
    expect(processController.status).toMatchObject({ type: 'stopped' })
  })
})
