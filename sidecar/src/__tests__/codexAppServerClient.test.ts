import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerClient } from '../providers/codexAppServerClient'

class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  kill = vi.fn(() => {
    this.killed = true
    this.emit('exit', null, 'SIGTERM')
    return true
  })

  constructor() {
    super()
    this.stdin.once('finish', () => this.emit('exit', 0, null))
  }
}

interface Harness {
  child: FakeChild
  writes: Array<Record<string, unknown>>
  spawn: ReturnType<typeof vi.fn>
  client: CodexAppServerClient
}

function harness(requestTimeoutMs = 100): Harness {
  const child = new FakeChild()
  const writes: Array<Record<string, unknown>> = []
  let buffer = ''
  child.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    let index: number
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line) continue
      const message = JSON.parse(line) as Record<string, unknown>
      writes.push(message)
      if (message.method === 'initialize' && message.id !== undefined) {
        child.stdout.write(
          `${JSON.stringify({ id: message.id, result: { serverInfo: {} } })}\n`
        )
      }
    }
  })
  const spawn = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams)
  const client = new CodexAppServerClient({
    executablePath: 'C:\\tools\\codex.exe',
    runtimeDirectory:
      'C:\\Users\\test\\AppData\\Local\\EnvCAD\\ai-runtime\\test',
    environment: {
      PATH: 'C:\\tools',
      USERPROFILE: 'C:\\Users\\test',
      OPENAI_API_KEY: 'sk-proj-never-forward',
      UNRELATED_SECRET: 'never-forward'
    },
    requestTimeoutMs,
    closeTimeoutMs: 20,
    spawnProcess: spawn as never,
    logger: { log: vi.fn(), error: vi.fn() }
  })
  return { child, writes, spawn, client }
}

describe('CodexAppServerClient', () => {
  it('uses stdio, performs initialize/initialized, and sanitizes the child environment', async () => {
    const test = harness()
    await test.client.start()

    expect(test.spawn).toHaveBeenCalledWith(
      'C:\\tools\\codex.exe',
      [
        '-c',
        'model_provider="openai"',
        '-c',
        'chatgpt_base_url="https://chatgpt.com/backend-api/"',
        'app-server',
        '--stdio'
      ],
      expect.objectContaining({
        cwd: expect.stringContaining('ai-runtime'),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    )
    const spawnEnvironment = test.spawn.mock.calls[0][2].env
    expect(spawnEnvironment).toMatchObject({
      PATH: 'C:\\tools',
      USERPROFILE: 'C:\\Users\\test'
    })
    expect(spawnEnvironment).not.toHaveProperty('OPENAI_API_KEY')
    expect(spawnEnvironment).not.toHaveProperty('UNRELATED_SECRET')
    expect(test.writes[0]).toMatchObject({
      method: 'initialize',
      params: {
        clientInfo: { name: 'envcad', title: 'EnvCAD', version: '0.2.0' },
        capabilities: { experimentalApi: true }
      }
    })
    expect(test.writes[1]).toEqual({ method: 'initialized', params: {} })
    await test.client.close()
  })

  it('dispatches only item/tool/call server requests and writes their result', async () => {
    const test = harness()
    await test.client.start()
    test.client.setServerRequestHandler(async () => ({
      contentItems: [{ type: 'inputText', text: 'ok' }],
      success: true
    }))
    test.child.stdout.write(
      `${JSON.stringify({
        id: 'server-1',
        method: 'item/tool/call',
        params: { tool: 'zoom_extents' }
      })}\n`
    )
    await vi.waitFor(() => {
      expect(test.writes).toContainEqual({
        id: 'server-1',
        result: {
          contentItems: [{ type: 'inputText', text: 'ok' }],
          success: true
        }
      })
    })
    await test.client.close()
  })

  it.each([
    ['malformed JSONL', '{not-json\n', 'malformed JSONL'],
    [
      'unknown request id',
      `${JSON.stringify({ id: 999, result: {} })}\n`,
      'unknown request id'
    ],
    [
      'forbidden server request',
      `${JSON.stringify({
        id: 7,
        method: 'command/exec',
        params: {}
      })}\n`,
      'rejected server request'
    ]
  ])('reports %s as a protocol violation', async (_label, line, expected) => {
    const test = harness()
    const errors: string[] = []
    await test.client.start()
    test.client.onProtocolError((error) => errors.push(error.message))
    test.child.stdout.write(line)
    await vi.waitFor(() => {
      expect(errors.some((message) => message.includes(expected))).toBe(true)
    })
    await test.client.close()
  })

  it('rejects timed-out requests and pending requests when the child exits early', async () => {
    const timeout = harness(5)
    await timeout.client.start()
    await expect(timeout.client.request('model/list', {})).rejects.toThrow(
      'model/list timed out'
    )
    await timeout.client.close()

    const earlyExit = harness(100)
    await earlyExit.client.start()
    const pending = earlyExit.client.request('model/list', {})
    earlyExit.child.emit('exit', 9, null)
    await expect(pending).rejects.toThrow(
      'Codex app-server exited unexpectedly (exit code 9)'
    )
    await earlyExit.client.close()
  })

  it('closes stdin and does not orphan the child process', async () => {
    const test = harness()
    await test.client.start()
    await test.client.close()
    expect(test.child.stdin.writableEnded).toBe(true)
    expect(test.child.kill).not.toHaveBeenCalled()
  })
})
