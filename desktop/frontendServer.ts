import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import sirv from 'sirv'

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "connect-src 'self' ws://127.0.0.1:*",
  "media-src 'none'"
].join('; ')

export interface FrontendServerOptions {
  root: string
  host?: string
  port?: number
}

export interface FrontendServerHandle {
  origin: string
  url: string
  port: number
  close(): Promise<void>
}

function reject(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store'
  })
  response.end(message)
}

function safeRequestPath(request: IncomingMessage): string | undefined {
  const rawPath = (request.url ?? '/').split('?', 1)[0]
  try {
    const decoded = decodeURIComponent(rawPath)
    const segments = decoded.split('/')
    if (
      !decoded.startsWith('/') ||
      decoded.includes('\0') ||
      decoded.includes('\\') ||
      segments.includes('..')
    ) {
      return undefined
    }
    return decoded
  } catch {
    return undefined
  }
}

export async function startFrontendServer(
  options: FrontendServerOptions
): Promise<FrontendServerHandle> {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 0
  if (host !== '127.0.0.1') throw new Error('The packaged renderer must bind to 127.0.0.1')
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('port must be an integer from 0 through 65535')
  }

  const root = path.resolve(options.root)
  const serve = sirv(root, {
    dev: false,
    dotfiles: false,
    etag: true,
    maxAge: 0,
    immutable: false,
    setHeaders(response, pathname) {
      response.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY)
      response.setHeader('X-Content-Type-Options', 'nosniff')
      response.setHeader('Referrer-Policy', 'no-referrer')
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
      response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
      response.setHeader(
        'Cache-Control',
        pathname.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable'
      )
    }
  })

  const server = createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      reject(response, 405, 'Method not allowed')
      return
    }
    const pathname = safeRequestPath(request)
    if (!pathname) {
      reject(response, 400, 'Invalid request path')
      return
    }

    // EnvCAD currently has one application route. Missing assets and arbitrary
    // paths must remain 404s rather than receiving the SPA shell.
    if (pathname === '/') {
      const query = request.url?.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''
      request.url = `/index.html${query}`
    }
    serve(request, response, () => reject(response, 404, 'Not found'))
  })

  await new Promise<void>((resolve, rejectListen) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      rejectListen(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })

  const address = server.address() as AddressInfo
  const origin = `http://${host}:${address.port}`
  let closePromise: Promise<void> | undefined
  return {
    origin,
    url: `${origin}/`,
    port: address.port,
    close() {
      closePromise ??= new Promise<void>((resolve, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolve()))
        server.closeAllConnections()
      })
      return closePromise
    }
  }
}
