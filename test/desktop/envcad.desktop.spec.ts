import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { WebSocket } from 'ws'

const ELECTRON_DRIVER = path.join(
  process.cwd(),
  'node_modules',
  'electron',
  'dist',
  'electron.exe'
)
const PRODUCTION_ASAR = path.join(
  process.cwd(),
  'out',
  'EnvCAD-win32-x64',
  'resources',
  'app.asar'
)
const FIXTURE = path.join(process.cwd(), 'test', 'fixtures', 'sample-site.dxf')
const SCREENSHOT = path.join(process.cwd(), 'output', 'desktop', 'packaged-envcad.png')

function cleanEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env)
      .filter(([name, value]) => value !== undefined && !name.startsWith('ANTHROPIC_'))
      .map(([name, value]) => [name, value!])
  )
}

function rejectedWebSocket(
  url: string,
  origin: string,
  protocols: string[]
): Promise<number | undefined> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, protocols, { origin })
    socket.once('unexpected-response', (_request, response) => resolve(response.statusCode))
    socket.once('error', () => resolve(undefined))
    socket.once('open', () => {
      socket.close()
      resolve(101)
    })
  })
}

test('packaged EnvCAD opens, edits without a browser, authenticates its sidecar, and stays single-instance', async () => {
  const startedAt = performance.now()
  let closedSidecar: { url: string; origin: string } | undefined
  const application = await electron.launch({
    executablePath: ELECTRON_DRIVER,
    args: [PRODUCTION_ASAR],
    env: cleanEnvironment()
  })
  try {
    const page = await application.firstWindow()
    await expect(page).toHaveTitle('EnvCAD')
    await expect(page.getByRole('button', { name: 'Open', exact: true })).toBeVisible()
    const startupMs = Math.round(performance.now() - startedAt)
    test.info().annotations.push({ type: 'startup-ms', description: String(startupMs) })

    expect(await page.evaluate(() => typeof window.envcadDesktop)).toBe('object')
    expect(await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)).toBe(
      'undefined'
    )

    await page.locator('input[accept=".dxf,.dwg"]').setInputFiles(FIXTURE)
    await expect(page.getByRole('button', { name: 'Save DXF' })).toBeEnabled()
    await expect(page.locator('.canvas-host canvas:visible').first()).toBeVisible()
    await page.getByRole('button', { name: 'Zoom Extents' }).click()
    await page.getByRole('button', { name: 'Layers', exact: true }).click()
    await expect(page.locator('.layers-dock')).toBeVisible()
    await page.getByRole('button', { name: 'Page Setup', exact: true }).click()
    await expect(page.locator('.dialog-header span', { hasText: 'Page Setup' })).toBeVisible()
    await page.locator('.dialog-header .icon-btn').click()

    await expect
      .poll(async () => page.locator('.status-text').textContent())
      .toMatch(/Idle|Offline/)

    const runtime = await page.evaluate(() => window.envcadDesktop!.getRuntimeConfig())
    if (runtime.sidecar.type === 'ready') {
      closedSidecar = {
        url: runtime.sidecar.connection.url,
        origin: runtime.rendererOrigin
      }
      const status = await rejectedWebSocket(runtime.sidecar.connection.url, runtime.rendererOrigin, [
        'envcad.v1',
        'envcad.session.invalid-token'
      ])
      expect(status).toBe(403)
    }

    const process = spawn(ELECTRON_DRIVER, [PRODUCTION_ASAR], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore'
    })
    await new Promise<void>((resolve) => process.once('exit', () => resolve()))
    expect(application.windows()).toHaveLength(1)

    await mkdir(path.dirname(SCREENSHOT), { recursive: true })
    await page.screenshot({ path: SCREENSHOT })
  } finally {
    await application.close()
  }
  if (closedSidecar) {
    expect(
      await rejectedWebSocket(closedSidecar.url, closedSidecar.origin, [
        'envcad.v1',
        'envcad.session.invalid-token'
      ])
    ).toBeUndefined()
  }
})

test('packaged EnvCAD keeps CAD available when API-key authentication is present', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'envcad-api-key-profile-'))
  const environment = cleanEnvironment()
  const secret = 'test-value-must-never-be-logged'
  environment.ANTHROPIC_API_KEY = secret
  environment.APPDATA = path.join(profile, 'AppData', 'Roaming')
  environment.LOCALAPPDATA = path.join(profile, 'AppData', 'Local')
  environment.USERPROFILE = profile
  await Promise.all([
    mkdir(environment.APPDATA, { recursive: true }),
    mkdir(environment.LOCALAPPDATA, { recursive: true })
  ])
  const application = await electron.launch({
    executablePath: ELECTRON_DRIVER,
    args: [PRODUCTION_ASAR],
    env: environment
  })
  try {
    const page = await application.firstWindow()
    await expect(page.getByRole('button', { name: 'Open', exact: true })).toBeVisible()
    await expect(page.locator('.offline-banner')).toContainText('ANTHROPIC_API_KEY')
    await page.locator('input[accept=".dxf,.dwg"]').setInputFiles(FIXTURE)
    await expect(page.getByRole('button', { name: 'Save DXF' })).toBeEnabled()
  } finally {
    await application.close()
  }
  const log = await readFile(
    path.join(environment.APPDATA, 'EnvCAD', 'logs', 'main.log'),
    'utf8'
  )
  expect(log).not.toContain(secret)
  await rm(profile, { recursive: true })
})

test('packaged EnvCAD keeps CAD available without Claude Code or Node on PATH', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'envcad-clean-profile-'))
  const environment = cleanEnvironment()
  environment.PATH = path.join(environment.SystemRoot ?? 'C:\\Windows', 'System32')
  environment.APPDATA = path.join(profile, 'AppData', 'Roaming')
  environment.LOCALAPPDATA = path.join(profile, 'AppData', 'Local')
  environment.USERPROFILE = profile
  await Promise.all([
    mkdir(environment.APPDATA, { recursive: true }),
    mkdir(environment.LOCALAPPDATA, { recursive: true })
  ])
  const application = await electron.launch({
    executablePath: ELECTRON_DRIVER,
    args: [PRODUCTION_ASAR],
    env: environment
  })
  try {
    const page = await application.firstWindow()
    await expect(page.getByRole('button', { name: 'Open', exact: true })).toBeVisible()
    await expect(page.locator('.offline-banner')).toContainText('Claude Code was not found')
    await page.locator('input[accept=".dxf,.dwg"]').setInputFiles(FIXTURE)
    await expect(page.getByRole('button', { name: 'Save DXF' })).toBeEnabled()
    await expect(page.locator('.canvas-host canvas:visible').first()).toBeVisible()
  } finally {
    await application.close()
    await rm(profile, { recursive: true })
  }
})
