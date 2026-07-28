import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export const EXPECTED_CODEX_CLI_VERSION = '0.145.0'

const COMMAND_TIMEOUT_MS = 8_000
const MAX_OUTPUT_BYTES = 16 * 1024

export interface CodexCommandResult {
  exitCode: number
  output: string
}

export type SafeCodexCommandRunner = (
  executablePath: string,
  args: readonly string[],
  signal?: AbortSignal
) => Promise<CodexCommandResult>

export type CodexDiscoveryResult =
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
  const candidates: string[] = []
  const pathValue = getEnvironmentValue(environment, 'PATH')
  if (pathValue) {
    for (const entry of pathValue.split(path.delimiter)) {
      const directory = entry.trim().replace(/^"(.*)"$/, '$1')
      if (directory) candidates.push(path.join(directory, 'codex.exe'))
    }
  }

  const userProfile = getEnvironmentValue(environment, 'USERPROFILE')
  const localAppData = getEnvironmentValue(environment, 'LOCALAPPDATA')
  const appData = getEnvironmentValue(environment, 'APPDATA')
  if (userProfile) candidates.push(path.join(userProfile, '.local', 'bin', 'codex.exe'))
  if (localAppData) {
    candidates.push(
      path.join(localAppData, 'Programs', 'Codex', 'codex.exe'),
      path.join(localAppData, 'Programs', 'OpenAI Codex', 'codex.exe')
    )
  }
  if (appData) {
    candidates.push(
      path.join(
        appData,
        'npm',
        'node_modules',
        '@openai',
        'codex',
        'node_modules',
        '@openai',
        'codex-win32-x64',
        'vendor',
        'x86_64-pc-windows-msvc',
        'bin',
        'codex.exe'
      )
    )
  }

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
    if (process.platform === 'win32' && path.basename(canonical).toLowerCase() !== 'codex.exe') {
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

export const runSafeCodexCommand: SafeCodexCommandRunner = (
  executablePath,
  args,
  signal
) =>
  new Promise<CodexCommandResult>((resolve, reject) => {
    let output = ''
    let settled = false
    const child = spawn(executablePath, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const append = (chunk: Buffer) => {
      if (Buffer.byteLength(output) >= MAX_OUTPUT_BYTES) return
      output += chunk.toString(
        'utf8',
        0,
        Math.max(0, MAX_OUTPUT_BYTES - Buffer.byteLength(output))
      )
    }
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      callback()
    }
    const abort = () => {
      child.kill()
      finish(() => reject(new Error('Codex CLI check was cancelled')))
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(() => reject(new Error('Codex CLI check timed out')))
    }, COMMAND_TIMEOUT_MS)
    timer.unref()

    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.once('error', (error) => finish(() => reject(error)))
    child.once('close', (code) =>
      finish(() => resolve({ exitCode: code ?? 1, output: output.trim() }))
    )

    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })

export async function discoverCodexExecutable(options: {
  environment?: NodeJS.ProcessEnv
  expectedVersion?: string
  runner?: SafeCodexCommandRunner
  signal?: AbortSignal
} = {}): Promise<CodexDiscoveryResult> {
  const environment = options.environment ?? process.env
  const expectedVersion = options.expectedVersion ?? EXPECTED_CODEX_CLI_VERSION
  const runner = options.runner ?? runSafeCodexCommand
  let incompatible: Exclude<CodexDiscoveryResult, { status: 'ready' | 'missing' }> | undefined

  for (const candidate of candidatePaths(environment)) {
    if (options.signal?.aborted) throw new Error('Codex CLI discovery was cancelled')
    const executablePath = await canonicalExecutablePath(candidate)
    if (!executablePath) continue
    try {
      const result = await runner(executablePath, ['--version'], options.signal)
      const version = result.exitCode === 0 ? extractVersion(result.output) : undefined
      if (!version) continue
      if (version === expectedVersion) return { status: 'ready', executablePath, version }
      incompatible ??= {
        status: 'incompatible',
        executablePath,
        version,
        expectedVersion
      }
    } catch {
      // Continue through supported locations; stale installations must not
      // hide a healthy native executable elsewhere.
    }
  }

  return incompatible ?? { status: 'missing' }
}

export async function isCodexAuthenticatedWithChatGpt(
  executablePath: string,
  options: { runner?: SafeCodexCommandRunner; signal?: AbortSignal } = {}
): Promise<boolean> {
  try {
    const result = await (options.runner ?? runSafeCodexCommand)(
      executablePath,
      ['login', 'status'],
      options.signal
    )
    return result.exitCode === 0 && /\blogged in using chatgpt\b/i.test(result.output)
  } catch {
    return false
  }
}
