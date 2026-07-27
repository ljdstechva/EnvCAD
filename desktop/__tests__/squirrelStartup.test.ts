import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSquirrelInstallRoot, UNINSTALL_CLEANUP_SCRIPT } from '../squirrelStartup'

describe('resolveSquirrelInstallRoot', () => {
  it('accepts only the expected per-user Squirrel application location', () => {
    const localAppData = 'C:\\Users\\Example\\AppData\\Local'
    expect(
      resolveSquirrelInstallRoot(
        path.join(localAppData, 'EnvCAD', 'app-0.1.0', 'EnvCAD.exe'),
        localAppData
      )
    ).toBe(path.join(localAppData, 'EnvCAD'))
  })

  it.each([
    ['missing local app data', 'C:\\EnvCAD\\app-0.1.0\\EnvCAD.exe', undefined],
    [
      'different executable',
      'C:\\Users\\Example\\AppData\\Local\\EnvCAD\\app-0.1.0\\Other.exe',
      'C:\\Users\\Example\\AppData\\Local'
    ],
    [
      'different product root',
      'C:\\Users\\Example\\AppData\\Local\\Other\\app-0.1.0\\EnvCAD.exe',
      'C:\\Users\\Example\\AppData\\Local'
    ],
    [
      'non-version directory',
      'C:\\Users\\Example\\AppData\\Local\\EnvCAD\\current\\EnvCAD.exe',
      'C:\\Users\\Example\\AppData\\Local'
    ]
  ])('rejects %s', (_label, executablePath, localAppData) => {
    expect(resolveSquirrelInstallRoot(executablePath, localAppData)).toBeUndefined()
  })
})

describe.skipIf(process.platform !== 'win32')('uninstall cleanup helper', () => {
  function runCleanup(
    installRoot: string,
    cleanupDirectory: string,
    installedExecutable: string
  ) {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
    if (!systemRoot) throw new Error('SystemRoot is required for the Windows cleanup test')
    const powershell = path.join(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
    mkdirSync(cleanupDirectory, { recursive: true })
    const scriptPath = path.join(cleanupDirectory, 'cleanup.ps1')
    writeFileSync(scriptPath, UNINSTALL_CLEANUP_SCRIPT, 'utf8')
    return spawnSync(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-InstallRoot',
        installRoot,
        '-CleanupDirectory',
        cleanupDirectory,
        '-InstalledExecutable',
        installedExecutable,
        '-GraceMilliseconds',
        '0',
        '-DeadlineSeconds',
        '2'
      ],
      { encoding: 'utf8', timeout: 10_000 }
    )
  }

  it('preserves a replacement installation that appears at the same root', () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), 'envcad-squirrel-replacement-'))
    try {
      const installRoot = path.join(testRoot, 'EnvCAD')
      const installedExecutable = path.join(installRoot, 'app-0.1.1', 'EnvCAD.exe')
      mkdirSync(path.dirname(installedExecutable), { recursive: true })
      writeFileSync(installedExecutable, 'replacement application')
      writeFileSync(path.join(installRoot, 'EnvCAD.exe'), 'replacement launcher')

      const result = runCleanup(
        installRoot,
        path.join(testRoot, 'cleanup-helper'),
        installedExecutable
      )

      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      expect(existsSync(installedExecutable)).toBe(true)
    } finally {
      rmSync(testRoot, { recursive: true, force: true })
    }
  }, 15_000)

  it('removes a residual uninstall root when no replacement is present', () => {
    const testRoot = mkdtempSync(path.join(os.tmpdir(), 'envcad-squirrel-residual-'))
    try {
      const installRoot = path.join(testRoot, 'EnvCAD')
      const installedExecutable = path.join(installRoot, 'app-0.1.0', 'EnvCAD.exe')
      mkdirSync(path.dirname(installedExecutable), { recursive: true })
      writeFileSync(path.join(installRoot, 'Update.exe'), 'stale updater')

      const result = runCleanup(
        installRoot,
        path.join(testRoot, 'cleanup-helper'),
        installedExecutable
      )

      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(0)
      expect(existsSync(installRoot)).toBe(false)
    } finally {
      rmSync(testRoot, { recursive: true, force: true })
    }
  }, 15_000)
})
