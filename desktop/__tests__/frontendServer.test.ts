import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startFrontendServer, type FrontendServerHandle } from '../frontendServer'

const directories: string[] = []
const handles: FrontendServerHandle[] = []

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe('startFrontendServer', () => {
  it('serves only packaged assets with CSP, correct MIME types, and a dynamic loopback port', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'envcad-renderer-'))
    directories.push(root)
    await writeFile(path.join(root, 'index.html'), '<!doctype html><script type="module" src="/app.js"></script>')
    await writeFile(path.join(root, 'app.js'), 'export const ready = true')
    await writeFile(path.join(root, 'worker.wasm'), Buffer.from([0, 97, 115, 109]))

    const handle = await startFrontendServer({ root })
    handles.push(handle)
    expect(handle.port).toBeGreaterThan(0)
    expect(handle.origin).toBe(`http://127.0.0.1:${handle.port}`)

    const rootResponse = await fetch(handle.url)
    expect(rootResponse.status).toBe(200)
    const policy = rootResponse.headers.get('content-security-policy')
    expect(policy).toContain(
      "connect-src 'self' ws://127.0.0.1:* https://cdn.jsdelivr.net"
    )
    expect(policy).not.toContain('connect-src https:')
    expect(await rootResponse.text()).toContain('<!doctype html>')

    const scriptResponse = await fetch(`${handle.origin}/app.js`)
    expect(scriptResponse.headers.get('content-type')).toMatch(/javascript/)
    const wasmResponse = await fetch(`${handle.origin}/worker.wasm`)
    expect(wasmResponse.headers.get('content-type')).toContain('application/wasm')

    expect((await fetch(`${handle.origin}/missing-route`)).status).toBe(404)
    expect((await fetch(`${handle.origin}/..%2fsecret.txt`)).status).toBe(400)

    const firstClose = handle.close()
    expect(handle.close()).toBe(firstClose)
    await firstClose
  })
})
