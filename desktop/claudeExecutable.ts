import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export const EXPECTED_CLAUDE_CODE_VERSION = '2.1.220'

const COMMAND_TIMEOUT_MS = 8_000
const MAX_OUTPUT_BYTES = 16 * 1024

export interface CommandResult {
  exitCode: number
  stdout: string
}

export type SafeCommandRunner = (
  executablePath: string,
  args: readonly string[],
  signal?: AbortSignal
) => Promise<CommandResult>

export type ClaudeDiscoveryResult =
  | { status: 'ready'; executablePath: string; version: string }
  | { status: 'missing' }
  | {
      status: 'incompatible'
      executablePath: string
      version: string
      expectedVersion: string
    }

function getEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  requestedName: string
): string | undefined {
  const key = Object.keys(environment).find(
    (name) => name.toLowerCase() === requestedName.toLowerCase()
  )
  return key ? environment[key] : undefined
}

function candidatePaths(environment: NodeJS.ProcessEnv): string[] {
  const executableName = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const candidates: string[] = []
  const pathValue = getEnvironmentValue(environment, 'PATH')
  if (pathValue) {
    for (const entry of pathValue.split(path.delimiter)) {
      const directory = entry.trim().replace(/^"(.*)"$/, '$1')
      if (directory) candidates.push(path.join(directory, executableName))
    }
  }

  const userProfile = getEnvironmentValue(environment, 'USERPROFILE')
  const localAppData = getEnvironmentValue(environment, 'LOCALAPPDATA')
  const appData = getEnvironmentValue(environment, 'APPDATA')
  if (userProfile) candidates.push(path.join(userProfile, '.local', 'bin', executableName))
  if (localAppData) {
    candidates.push(
      path.join(localAppData, 'Programs', 'Claude', executableName),
      path.join(localAppData, 'Programs', 'Claude Code', executableName),
      path.join(localAppData, 'Programs', 'claude-code', executableName)
    )
  }
  if (appData) candidates.push(path.join(appData, 'npm', executableName))

  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = path.resolve(candidate).toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function canonicalExecutablePath(candidate: string): Promise<string | undefined> {
  try {
    await access(candidate, fsConstants.X_OK)
    const canonical = await realpath(candidate)
    const metadata = await stat(canonical)
    if (!metadata.isFile()) return undefined
    if (process.platform === 'win32' && path.basename(canonical).toLowerCase() !== 'claude.exe') {
      return undefined
    }
    return canonical
  } catch {
    return undefined
  }
}

function extractVersion(output: string): string | undefined {
  return output.match(/\b(\d+\.\d+\.\d+)\b/)?.[1]
}

export const runSafeCommand: SafeCommandRunner = (executablePath, args, signal) =>
  new Promise<CommandResult>((resolve, reject) => {
    let stdout = ''
    let stderrBytes = 0
    let settled = false
    const child = spawn(executablePath, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      callback()
    }
    const abort = () => {
      child.kill()
      finish(() => reject(new Error('Claude Code check was cancelled')))
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(() => reject(new Error('Claude Code check timed out')))
    }, COMMAND_TIMEOUT_MS)
    timer.unref()

    child.stdout.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stdout) >= MAX_OUTPUT_BYTES) return
      stdout += chunk.toString('utf8', 0, Math.max(0, MAX_OUTPUT_BYTES - Buffer.byteLength(stdout)))
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes = Math.min(MAX_OUTPUT_BYTES, stderrBytes + chunk.length)
    })
    child.once('error', (error) => finish(() => reject(error)))
    child.once('close', (code) =>
      finish(() => resolve({ exitCode: code ?? 1, stdout: stdout.trim() }))
    )

    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })

export async function discoverClaudeExecutable(options: {
  environment?: NodeJS.ProcessEnv
  expectedVersion?: string
  runner?: SafeCommandRunner
  signal?: AbortSignal
} = {}): Promise<ClaudeDiscoveryResult> {
  const environment = options.environment ?? process.env
  const expectedVersion = options.expectedVersion ?? EXPECTED_CLAUDE_CODE_VERSION
  const runner = options.runner ?? runSafeCommand
  let incompatible: Exclude<ClaudeDiscoveryResult, { status: 'ready' | 'missing' }> | undefined

  for (const candidate of candidatePaths(environment)) {
    if (options.signal?.aborted) throw new Error('Claude Code discovery was cancelled')
    const executablePath = await canonicalExecutablePath(candidate)
    if (!executablePath) continue
    try {
      const result = await runner(executablePath, ['--version'], options.signal)
      const version = result.exitCode === 0 ? extractVersion(result.stdout) : undefined
      if (!version) continue
      if (version === expectedVersion) return { status: 'ready', executablePath, version }
      incompatible ??= {
        status: 'incompatible',
        executablePath,
        version,
        expectedVersion
      }
    } catch {
      // Keep checking supported locations; a stale PATH entry must not hide a
      // healthy native installation elsewhere.
    }
  }

  return incompatible ?? { status: 'missing' }
}

export async function isClaudeAuthenticated(
  executablePath: string,
  options: { runner?: SafeCommandRunner; signal?: AbortSignal } = {}
): Promise<boolean> {
  try {
    const result = await (options.runner ?? runSafeCommand)(
      executablePath,
      ['auth', 'status', '--json'],
      options.signal
    )
    if (result.exitCode !== 0) return false
    const status = JSON.parse(result.stdout) as { loggedIn?: unknown }
    return status.loggedIn === true
  } catch {
    return false
  }
}
