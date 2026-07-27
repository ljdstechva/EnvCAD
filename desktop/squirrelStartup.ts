import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app } from 'electron'

const INSTALL_EVENTS = new Set(['--squirrel-install', '--squirrel-updated'])
const UNINSTALL_EVENT = '--squirrel-uninstall'
const OBSOLETE_EVENT = '--squirrel-obsolete'

export const UNINSTALL_CLEANUP_SCRIPT = String.raw`
param(
  [Parameter(Mandatory = $true)][string] $InstallRoot,
  [Parameter(Mandatory = $true)][string] $CleanupDirectory,
  [Parameter(Mandatory = $true)][string] $InstalledExecutable,
  [int] $GraceMilliseconds = 30000,
  [int] $DeadlineSeconds = 300
)

$ErrorActionPreference = 'SilentlyContinue'

# Squirrel may terminate the application before its child-process callback
# runs. Start this helper early, but let shortcut removal and updater shutdown
# settle before touching the installation root.
[Threading.Thread]::Sleep([Math]::Max(0, $GraceMilliseconds))
$deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(1, $DeadlineSeconds))

function Test-InstallProcess {
  $installPrefix = $InstallRoot.TrimEnd('\') + '\'
  $processes = Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue
  foreach ($process in $processes) {
    $executablePath = [string] $process.ExecutablePath
    if ($executablePath.StartsWith(
      $installPrefix,
      [StringComparison]::OrdinalIgnoreCase
    )) {
      return $true
    }
  }
  return $false
}

function Test-ReplacementInstall {
  $replacementMarkers = @(
    $InstalledExecutable,
    (Join-Path $InstallRoot 'EnvCAD.exe'),
    (Join-Path $InstallRoot 'RELEASES'),
    (Join-Path $InstallRoot 'packages')
  )
  foreach ($marker in $replacementMarkers) {
    if (Test-Path -LiteralPath $marker) {
      return $true
    }
  }
  return $false
}

$cancelCleanup = $false

do {
  if (Test-ReplacementInstall) {
    $cancelCleanup = $true
    break
  }
  if (-not (Test-InstallProcess)) {
    break
  }
  [Threading.Thread]::Sleep(1000)
} while ([DateTime]::UtcNow -lt $deadline)

if (-not $cancelCleanup -and
    -not (Test-InstallProcess) -and
    -not (Test-ReplacementInstall) -and
    (Test-Path -LiteralPath $InstallRoot)) {
  # Delete the residual root at most once. Never poll for and delete a root
  # that disappears and is later recreated by a replacement installation.
  Remove-Item -LiteralPath $InstallRoot -Recurse -Force -ErrorAction SilentlyContinue
}

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
    writeFileSync(scriptPath, UNINSTALL_CLEANUP_SCRIPT, { encoding: 'utf8', mode: 0o600 })
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
      quoteArgument(cleanupDirectory),
      '-InstalledExecutable',
      quoteArgument(process.execPath)
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
    // Squirrel can terminate this process before runUpdate's callback fires, so
    // schedule deferred cleanup first. The helper has its own grace/process
    // checks and cannot touch Update.exe while shortcut removal is active.
    launchUninstallCleanup()
    runUpdate([`--removeShortcut=${target}`], () => app.quit())
    return true
  }
  if (command === OBSOLETE_EVENT) {
    app.quit()
    return true
  }
  return false
}
