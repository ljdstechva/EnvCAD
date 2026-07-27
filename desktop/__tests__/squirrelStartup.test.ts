import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSquirrelInstallRoot } from '../squirrelStartup'

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
