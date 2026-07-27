import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'

const INSTALL_EVENTS = new Set(['--squirrel-install', '--squirrel-updated'])
const UNINSTALL_EVENT = '--squirrel-uninstall'
const OBSOLETE_EVENT = '--squirrel-obsolete'

const CLEANUP_SCRIPT = String.raw`
param(
  [Parameter(Mandatory = $true)][string] $InstallRoot,
  [Parameter(Mandatory = $true)][string] $CleanupDirectory
)

$ErrorActionPreference = 'SilentlyContinue'
$deadline = [DateTime]::UtcNow.AddMinutes(2)

do {
  if (Test-Path -LiteralPath $InstallRoot) {
    Remove-Item -LiteralPath $InstallRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (-not (Test-Path -LiteralPath $InstallRoot)) {
    break
  }
  [Threading.Thread]::Sleep(500)
} while ([DateTime]::UtcNow -lt $deadline)

[Threading.Thread]::Sleep(250)
Remove-Item -LiteralPath $CleanupDirectory -Recurse -Force -ErrorAction SilentlyContinue
`

export function resolveSquirrelInstallRoot(
  executablePath: string,
  localAppData: string | undefined
): string | undefined {
  if (!localAppData || path.basename(executablePath).toLowerCase() !== 'envcad.exe') {
    return undefined
  }
  const applicationDirectory = path.dirname(path.resolve(executablePath))
  if (!/^app-\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(path.basename(applicationDirectory))) {
    return undefined
  }
  const installRoot = path.dirname(applicationDirectory)
  const expectedRoot = path.resolve(localAppData, 'EnvCAD')
  return installRoot.toLowerCase() === expectedRoot.toLowerCase() ? installRoot : undefined
}

function runUpdate(args: string[], done: () => void): void {
  const updateExecutable = path.resolve(path.dirname(process.execPath), '..', 'Update.exe')
  let completed = false
  const finish = () => {
    if (completed) return
    completed = true
    done()
  }
  try {
    const child = spawn(updateExecutable, args, {
      detached: true,
      windowsHide: true,
      stdio: 'ignore'
    })
    child.once('error', finish)
    child.once('close', finish)
  } catch {
    finish()
  }
}

function launchUninstallCleanup(): void {
  const installRoot = resolveSquirrelInstallRoot(process.execPath, process.env.LOCALAPPDATA)
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
  if (!installRoot || !systemRoot) return

  const powershell = path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  try {
    const cleanupDirectory = mkdtempSync(path.join(os.tmpdir(), 'envcad-uninstall-'))
    const scriptPath = path.join(cleanupDirectory, 'cleanup.ps1')
    writeFileSync(scriptPath, CLEANUP_SCRIPT, { encoding: 'utf8', mode: 0o600 })
    const quoteArgument = (value: string) => `"${value.replaceAll('"', '""')}"`
    const cleanupCommandLine = [
      quoteArgument(powershell),
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      quoteArgument(scriptPath),
      '-InstallRoot',
      quoteArgument(installRoot),
      '-CleanupDirectory',
      quoteArgument(cleanupDirectory)
    ].join(' ')
    const powershellLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`
    const wmiLaunch = [
      `$commandLine = ${powershellLiteral(cleanupCommandLine)}`,
      '$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }',
      'if ([int]$result.ReturnValue -ne 0) { exit [int]$result.ReturnValue }'
    ].join('; ')
    const encodedLaunch = Buffer.from(wmiLaunch, 'utf16le').toString('base64')
    const launched = spawnSync(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodedLaunch
      ],
      {
        cwd: os.tmpdir(),
        windowsHide: true,
        stdio: 'ignore',
        timeout: 10_000
      }
    )
    if (launched.error || launched.status !== 0) {
      throw launched.error ?? new Error('Windows could not launch the uninstall cleanup process')
    }
  } catch {
    // Standard Squirrel uninstall still removes the application and shortcuts.
    // The helper exists only to remove Squirrel's updater stubs after it exits.
  }
}

export function handleSquirrelStartup(): boolean {
  if (process.platform !== 'win32') return false
  const command = process.argv[1]
  const target = path.basename(process.execPath)

  if (INSTALL_EVENTS.has(command)) {
    runUpdate([`--createShortcut=${target}`], () => app.quit())
    return true
  }
  if (command === UNINSTALL_EVENT) {
    runUpdate([`--removeShortcut=${target}`], () => {
      // Keep Update.exe available until Squirrel has finished removing shortcuts.
      // The cleanup helper retries the install-root removal after this app exits.
      launchUninstallCleanup()
      app.quit()
    })
    return true
  }
  if (command === OBSOLETE_EVENT) {
    app.quit()
    return true
  }
  return false
}
