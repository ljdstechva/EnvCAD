import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { DEVELOPMENT_SESSION_TOKEN } from '../../desktop/runtimeProtocol'
import { startSidecar } from './server'

const HOST = '127.0.0.1'
const PORT = 8787
const DEVELOPMENT_ORIGIN =
  process.env.ENVCAD_RENDERER_ORIGIN ?? 'http://localhost:5173'

function localRuntimeDirectory(): string {
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) {
    throw new Error('LOCALAPPDATA is required for the isolated AI runtime directory.')
  }
  return path.join(
    path.resolve(localAppData),
    'EnvCAD',
    'ai-runtime',
    `development-${process.pid}-${randomUUID()}`
  )
}

async function main(): Promise<void> {
  const runtimeDirectory = localRuntimeDirectory()
  await mkdir(runtimeDirectory, { recursive: true })
  const sidecar = startSidecar({
    host: HOST,
    port: PORT,
    permittedOrigin: DEVELOPMENT_ORIGIN,
    sessionToken: DEVELOPMENT_SESSION_TOKEN,
    runtimeDirectory,
    environment: process.env
  })
  const address = await sidecar.ready
  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[sidecar] received ${signal}; shutting down ${address.url}`)
    await sidecar.close()
    await rm(runtimeDirectory, { recursive: true, force: true })
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
}

void main().catch((error) => {
  console.error(`[sidecar] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
