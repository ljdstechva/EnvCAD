import { DEVELOPMENT_SESSION_TOKEN } from '../../desktop/runtimeProtocol'
import {
  discoverClaudeExecutable,
  isClaudeAuthenticated
} from '../../desktop/claudeExecutable'
import { startSidecar } from './server'

const HOST = '127.0.0.1'
const PORT = 8787
const API_KEY_ENV_NAME = 'ANTHROPIC_API_KEY'
const DEVELOPMENT_ORIGIN = process.env.ENVCAD_RENDERER_ORIGIN ?? 'http://localhost:5173'

async function main(): Promise<void> {
  if (process.env[API_KEY_ENV_NAME]?.trim()) {
    throw new Error(
      `${API_KEY_ENV_NAME} is set. EnvCAD requires the existing Claude Code OAuth subscription login.`
    )
  }

  const discovery = await discoverClaudeExecutable()
  if (discovery.status === 'missing') {
    throw new Error('Claude Code was not found. Install Claude Code and run "claude auth login".')
  }
  if (discovery.status === 'incompatible') {
    throw new Error(
      `Claude Code ${discovery.version} is incompatible; version ${discovery.expectedVersion} is required.`
    )
  }
  if (!(await isClaudeAuthenticated(discovery.executablePath))) {
    throw new Error('Claude Code is installed but not signed in. Run "claude auth login".')
  }

  const sidecar = startSidecar({
    host: HOST,
    port: PORT,
    permittedOrigin: DEVELOPMENT_ORIGIN,
    sessionToken: DEVELOPMENT_SESSION_TOKEN,
    claudeExecutablePath: discovery.executablePath
  })
  const address = await sidecar.ready
  let shuttingDown = false
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[sidecar] received ${signal}; shutting down ${address.url}`)
    await sidecar.close()
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
}

void main().catch((error) => {
  console.error(`[sidecar] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
