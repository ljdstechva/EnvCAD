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
    inputStoreDirectory:
      'C:\\Users\\test\\AppData\\Roaming\\EnvCAD\\agent-journal-v2\\inputs',
    fork: () => child,
    onStatus: vi.fn(),
    logger: logger(),
    turnJournal: {
      execute: vi.fn(async () => ({
        type: 'open-turns-listed' as const,
        turns: []
      }))
    }
  }
}

describe('SidecarProcess', () => {
  it('starts the neutral worker immediately and publishes runtime configuration', async () => {
    vi.useFakeTimers()
    try {
      const child = new FakeUtilityProcess()
      const replacement = new FakeUtilityProcess()
      const token = 'a'.repeat(43)
      const replacementToken = 'b'.repeat(43)
      const statuses: string[] = []
      const children = [child, replacement]
      const processController = new SidecarProcess({
        ...options(child, token),
        fork: () => children.shift()!,
        sessionTokenFactory: () => replacementToken,
        random: () => 0,
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
          'C:\\Users\\test\\AppData\\Local\\EnvCAD\\ai-runtime\\session-test',
        inputStoreDirectory:
          'C:\\Users\\test\\AppData\\Roaming\\EnvCAD\\agent-journal-v2\\inputs'
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
      expect(processController.status).toMatchObject({ type: 'starting' })
      await vi.advanceTimersByTimeAsync(100)
      expect(replacement.messages[0]).toMatchObject({
        type: 'start',
        sessionToken: replacementToken
      })
      replacement.emit('message', {
        type: 'ready',
        host: '127.0.0.1',
        port: 43124,
        message: 'recovered'
      })
      expect(processController.status).toMatchObject({
        type: 'ready',
        connection: {
          url: 'ws://127.0.0.1:43124',
          protocols: ['envcad.v1', sessionTokenProtocol(replacementToken)]
        }
      })
      expect(statuses.filter((status) => status === 'ready')).toHaveLength(2)
      const closing = processController.close()
      replacement.emit('message', { type: 'stopped', message: 'stopped' })
      await closing
    } finally {
      vi.useRealTimers()
    }
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
    vi.useFakeTimers()
    try {
      const child = new FakeUtilityProcess()
      const processController = new SidecarProcess({
        ...options(child),
        maxRestarts: 1,
        restartBaseDelayMs: 1,
        random: () => 0,
        fork: () => {
          throw new Error('worker entry point is unavailable')
        }
      })

      await expect(processController.start()).resolves.toBeUndefined()
      expect(processController.status).toMatchObject({ type: 'starting' })
      await vi.advanceTimersByTimeAsync(1)
      expect(processController.status).toMatchObject({
        type: 'failed',
        message: expect.stringContaining('restart circuit opened')
      })
      await processController.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('terminates a utility process when its start message cannot be posted', async () => {
    const child = new FakeUtilityProcess()
    child.postMessage = () => {
      throw new Error('message channel closed')
    }
    const processController = new SidecarProcess({
      ...options(child),
      maxRestarts: 0
    })

    await processController.start()
    expect(processController.status.type).toBe('failed')
    expect(child.kill).toHaveBeenCalledOnce()
    await processController.close()
  })

  it('opens a bounded restart circuit instead of entering an infinite crash loop', async () => {
    vi.useFakeTimers()
    try {
      const spawned: FakeUtilityProcess[] = []
      const processController = new SidecarProcess({
        ...options(new FakeUtilityProcess()),
        fork: () => {
          const child = new FakeUtilityProcess()
          spawned.push(child)
          return child
        },
        maxRestarts: 2,
        restartBaseDelayMs: 1,
        restartMaxDelayMs: 1,
        random: () => 0
      })
      await processController.start()
      spawned[0].emit('exit', 1)
      await vi.advanceTimersByTimeAsync(1)
      spawned[1].emit('exit', 2)
      await vi.advanceTimersByTimeAsync(1)
      spawned[2].emit('exit', 3)

      expect(processController.status).toMatchObject({
        type: 'failed',
        message: expect.stringContaining('restart circuit opened')
      })
      await processController.close()
    } finally {
      vi.useRealTimers()
    }
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

  it('routes strict turn-journal requests through the main-process authority', async () => {
    const child = new FakeUtilityProcess()
    const execute = vi.fn(async () => ({
      type: 'open-turns-listed' as const,
      turns: []
    }))
    const processController = new SidecarProcess({
      ...options(child),
      turnJournal: { execute }
    })
    await processController.start()

    child.emit('message', {
      type: 'turn-journal-request',
      requestId: 'request-1',
      command: { type: 'list-open-turns' }
    })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
    await vi.waitFor(() =>
      expect(child.messages).toContainEqual({
        type: 'turn-journal-response',
        requestId: 'request-1',
        ok: true,
        result: { type: 'open-turns-listed', turns: [] }
      })
    )

    const closing = processController.close()
    child.emit('message', { type: 'stopped', message: 'stopped' })
    await closing
  })

  it('maps turn-journal failures to a bounded worker error', async () => {
    const child = new FakeUtilityProcess()
    const processLogger = logger()
    const processController = new SidecarProcess({
      ...options(child),
      logger: processLogger,
      turnJournal: {
        execute: vi.fn(async () => {
          throw new Error('C:\\private\\turn-events.jsonl is corrupt')
        })
      }
    })
    await processController.start()
    child.emit('message', {
      type: 'turn-journal-request',
      requestId: 'request-failed',
      command: { type: 'list-open-turns' }
    })
    await vi.waitFor(() =>
      expect(child.messages).toContainEqual({
        type: 'turn-journal-response',
        requestId: 'request-failed',
        ok: false,
        error: {
          code: 'turn-journal-failed',
          message: 'Durable turn state could not be updated.'
        }
      })
    )
    expect(
      JSON.stringify(
        child.messages.find(
          (message) =>
            (message as { requestId?: string }).requestId === 'request-failed'
        )
      )
    ).not.toContain('C:\\private')
    expect(processLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('turn-events.jsonl is corrupt')
    )

    const closing = processController.close()
    child.emit('message', { type: 'stopped', message: 'stopped' })
    await closing
  })

  it('waits for an in-flight turn-journal request during shutdown', async () => {
    const child = new FakeUtilityProcess()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const execute = vi.fn(async () => {
      await gate
      return { type: 'open-turns-listed' as const, turns: [] }
    })
    const processController = new SidecarProcess({
      ...options(child),
      turnJournal: { execute }
    })
    await processController.start()
    child.emit('message', {
      type: 'turn-journal-request',
      requestId: 'request-in-flight',
      command: { type: 'list-open-turns' }
    })
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())

    let closed = false
    const closing = processController.close().then(() => {
      closed = true
    })
    child.emit('message', { type: 'stopped', message: 'stopped' })
    await Promise.resolve()
    expect(closed).toBe(false)
    release()
    await closing
    expect(closed).toBe(true)
  })

  it('accepts a terminal journal append initiated while graceful shutdown drains the worker', async () => {
    const child = new FakeUtilityProcess()
    const execute = vi.fn(async () => ({
      type: 'event-appended' as const,
      duplicate: false,
      envelope: {
        protocolVersion: 2 as const,
        sessionId: 'session-1',
        messageId: 'terminal-event',
        turnId: 'turn-1',
        sequence: 2,
        timestamp: '2026-07-29T08:00:00.000Z',
        payload: {
          type: 'turn_finished' as const,
          turnId: 'turn-1',
          phase: 'cancelled' as const,
          outcome: 'cancelled' as const,
          revision: {
            documentId: 'drawing-1',
            documentRevision: 1,
            contentRevision: 0,
            sheetRevision: 0,
            viewRevision: 0
          },
          revisionTransition: 'same-document' as const,
          finalRevision: {
            documentId: 'drawing-1',
            documentRevision: 1,
            contentRevision: 0,
            sheetRevision: 0,
            viewRevision: 0
          },
          activeSkillIds: ['cad-core', 'dxf-core'],
          provider: 'openai-codex',
          elapsedMs: 5,
          status: 'Turn cancelled during shutdown.',
          metrics: { totalMs: 5, toolCalls: 0 }
        }
      }
    }))
    const processController = new SidecarProcess({
      ...options(child),
      turnJournal: { execute }
    })
    await processController.start()

    const closing = processController.close()
    expect(child.messages.at(-1)).toEqual({ type: 'shutdown' })
    child.emit('message', {
      type: 'turn-journal-request',
      requestId: 'terminal-during-shutdown',
      command: {
        type: 'append-event',
        eventId: 'terminal-event',
        turnId: 'turn-1',
        event: {
          type: 'turn_finished',
          turnId: 'turn-1',
          phase: 'cancelled',
          outcome: 'cancelled',
          revision: {
            documentId: 'drawing-1',
            documentRevision: 1,
            contentRevision: 0,
            sheetRevision: 0,
            viewRevision: 0
          },
          revisionTransition: 'same-document',
          finalRevision: {
            documentId: 'drawing-1',
            documentRevision: 1,
            contentRevision: 0,
            sheetRevision: 0,
            viewRevision: 0
          },
          activeSkillIds: ['cad-core', 'dxf-core'],
          provider: 'openai-codex',
          elapsedMs: 5,
          status: 'Turn cancelled during shutdown.',
          metrics: { totalMs: 5, toolCalls: 0 }
        }
      }
    })

    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
    await vi.waitFor(() =>
      expect(child.messages).toContainEqual(
        expect.objectContaining({
          type: 'turn-journal-response',
          requestId: 'terminal-during-shutdown',
          ok: true
        })
      )
    )
    child.emit('message', { type: 'stopped', message: 'stopped' })
    await closing
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
