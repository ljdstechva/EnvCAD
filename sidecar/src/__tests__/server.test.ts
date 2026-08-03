import { randomBytes } from 'node:crypto'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ENVCAD_WEBSOCKET_PROTOCOL,
  sessionTokenProtocol
} from '../../../desktop/runtimeProtocol'
import { startSidecar, type SidecarHandle } from '../server'
import { ProviderManager } from '../providers/providerManager'
import { FakeProvider } from './fakeProviders'

const ORIGIN = 'http://127.0.0.1:45678'
const RUNTIME_DIRECTORY = 'C:\\Users\\test\\AppData\\Local\\EnvCAD\\ai-runtime\\test'
const INPUT_STORE_DIRECTORY =
  'C:\\Users\\test\\AppData\\Roaming\\EnvCAD\\agent-journal-v2\\inputs-test'
const handles: SidecarHandle[] = []

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()))
})

function connect(
  url: string,
  protocols: string[],
  origin: string
): Promise<{ opened: boolean; status?: number; socket: WebSocket }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, protocols, { origin })
    socket.once('open', () => resolve({ opened: true, socket }))
    socket.once('unexpected-response', (_request, response) => {
      resolve({ opened: false, status: response.statusCode, socket })
    })
    socket.once('error', () => resolve({ opened: false, socket }))
  })
}

describe('startSidecar', () => {
  const managerFactory = () =>
    new ProviderManager([
      new FakeProvider('claude-code'),
      new FakeProvider('openai-codex')
    ])

  it('allocates a dynamic port, accepts the exact origin and token, and closes repeatedly', async () => {
    const token = randomBytes(32).toString('base64url')
    const logger = { log: vi.fn(), error: vi.fn() }
    const handle = startSidecar({
      host: '127.0.0.1',
      port: 0,
      permittedOrigin: ORIGIN,
      sessionToken: token,
      runtimeDirectory: RUNTIME_DIRECTORY,
      inputStoreDirectory: INPUT_STORE_DIRECTORY,
      providerManagerFactory: managerFactory,
      logger
    })
    handles.push(handle)
    const address = await handle.ready

    expect(address.port).toBeGreaterThan(0)
    expect(address.url).toBe(`ws://127.0.0.1:${address.port}`)
    const result = await connect(
      address.url,
      [ENVCAD_WEBSOCKET_PROTOCOL, sessionTokenProtocol(token)],
      ORIGIN
    )
    expect(result.opened).toBe(true)
    expect(result.socket.protocol).toBe(ENVCAD_WEBSOCKET_PROTOCOL)
    result.socket.close()

    const firstClose = handle.close()
    const secondClose = handle.close()
    expect(secondClose).toBe(firstClose)
    await firstClose
  })

  it.each([
    {
      label: 'missing token',
      protocols: [ENVCAD_WEBSOCKET_PROTOCOL],
      origin: ORIGIN
    },
    {
      label: 'incorrect token',
      protocols: [ENVCAD_WEBSOCKET_PROTOCOL, sessionTokenProtocol('incorrect-token')],
      origin: ORIGIN
    },
    {
      label: 'incorrect origin',
      protocols: [ENVCAD_WEBSOCKET_PROTOCOL, sessionTokenProtocol('TOKEN')],
      origin: 'http://127.0.0.1:45679'
    },
    {
      label: 'missing EnvCAD protocol',
      protocols: [sessionTokenProtocol('TOKEN')],
      origin: ORIGIN
    }
  ])('rejects $label', async ({ protocols, origin }) => {
    const token = 'TOKEN'
    const handle = startSidecar({
      host: '127.0.0.1',
      port: 0,
      permittedOrigin: ORIGIN,
      sessionToken: token,
      runtimeDirectory: RUNTIME_DIRECTORY,
      inputStoreDirectory: INPUT_STORE_DIRECTORY,
      providerManagerFactory: managerFactory,
      logger: { log: vi.fn(), error: vi.fn() }
    })
    handles.push(handle)
    const address = await handle.ready
    const result = await connect(address.url, protocols, origin)
    expect(result.opened).toBe(false)
    expect(result.status).toBe(403)
  })
})
