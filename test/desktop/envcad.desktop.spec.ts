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
  const blocked = new Set([
    'anthropic_api_key',
    'anthropic_auth_token',
    'claude_code_oauth_token',
    'openai_api_key',
    'codex_api_key',
    'codex_access_token'
  ])
  return Object.fromEntries(
    Object.entries(process.env)
      .filter(
        ([name, value]) =>
          value !== undefined && !blocked.has(name.toLowerCase())
      )
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

function verifyAuthenticatedSidecarRoundTrip(
  url: string,
  origin: string,
  protocols: string[]
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocols, { origin })
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const finish = (error?: Error, message?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.close()
      if (error) reject(error)
      else resolve(message ?? '')
    }
    timer = setTimeout(
      () => finish(new Error('Timed out waiting for the packaged sidecar response')),
      10_000
    )
    socket.once('open', () => socket.send('not-json'))
    socket.on('message', (data) => {
      try {
        const response = JSON.parse(String(data)) as { type?: unknown; message?: unknown }
        if (response.type === 'ai_capabilities') return
        if (response.type !== 'error' || typeof response.message !== 'string') {
          finish(new Error(`Unexpected packaged sidecar response: ${String(data)}`))
          return
        }
        finish(undefined, response.message)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.once('error', (error) => finish(error))
    socket.once('close', () => {
      finish(new Error('Packaged sidecar closed before responding'))
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
    const savedDxf = test.info().outputPath('packaged-save-reopen.dxf')
    await application.evaluate(
      ({ session }, filePath) => {
        session.defaultSession.once('will-download', (_event, item) => {
          item.setSavePath(filePath)
        })
      },
      savedDxf
    )
    await page.getByRole('button', { name: 'Save DXF' }).click()
    await expect
      .poll(async () => {
        try {
          return (await readFile(savedDxf)).byteLength
        } catch {
          return 0
        }
      })
      .toBeGreaterThan(100)
    await page.locator('input[accept=".dxf,.dwg"]').setInputFiles(savedDxf)
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
      await expect(
        verifyAuthenticatedSidecarRoundTrip(
          runtime.sidecar.connection.url,
          runtime.rendererOrigin,
          [...runtime.sidecar.connection.protocols]
        )
      ).resolves.toContain('malformed JSON')
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
    await expect(page.locator('.provider-message')).toContainText('ANTHROPIC_API_KEY')
    await expect(page.locator('.readiness-badge')).toHaveText('failed')
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

test('packaged EnvCAD keeps CAD available when both provider CLIs are missing', async () => {
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
    await expect(page.locator('.provider-message')).toContainText('Claude Code was not found')
    await expect(page.locator('.readiness-badge')).toHaveText('missing')
    await page
      .getByLabel('AI provider', { exact: true })
      .selectOption('openai-codex')
    await expect(page.locator('.provider-message')).toContainText('Codex CLI was not found')
    await expect(page.locator('.readiness-badge')).toHaveText('missing')
    await page.locator('input[accept=".dxf,.dwg"]').setInputFiles(FIXTURE)
    await expect(page.getByRole('button', { name: 'Save DXF' })).toBeEnabled()
    await expect(page.locator('.canvas-host canvas:visible').first()).toBeVisible()
  } finally {
    await application.close()
    await rm(profile, { recursive: true })
  }
})

test('packaged EnvCAD persists non-secret AI preferences across restarts', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'envcad-preferences-profile-'))
  const environment = cleanEnvironment()
  environment.PATH = path.join(environment.SystemRoot ?? 'C:\\Windows', 'System32')
  environment.APPDATA = path.join(profile, 'AppData', 'Roaming')
  environment.LOCALAPPDATA = path.join(profile, 'AppData', 'Local')
  environment.USERPROFILE = profile
  await Promise.all([
    mkdir(environment.APPDATA, { recursive: true }),
    mkdir(environment.LOCALAPPDATA, { recursive: true })
  ])

  let application = await electron.launch({
    executablePath: ELECTRON_DRIVER,
    args: [PRODUCTION_ASAR],
    env: environment
  })
  try {
    const page = await application.firstWindow()
    await expect(page.getByRole('button', { name: 'Open', exact: true })).toBeVisible()
    const provider = page.getByLabel('AI provider', { exact: true })
    await expect(provider.locator('option')).toHaveCount(2)
    await provider.selectOption('openai-codex')
    await expect(provider).toHaveValue('openai-codex')
    await expect
      .poll(async () => {
        const saved = await page.evaluate(() =>
          window.envcadDesktop!.getAiPreferences()
        )
        return saved.selectedProvider
      })
      .toBe('openai-codex')
  } finally {
    await application.close()
  }

  application = await electron.launch({
    executablePath: ELECTRON_DRIVER,
    args: [PRODUCTION_ASAR],
    env: environment
  })
  try {
    const page = await application.firstWindow()
    await expect(page.getByRole('button', { name: 'Open', exact: true })).toBeVisible()
    const provider = page.getByLabel('AI provider', { exact: true })
    await expect(provider.locator('option')).toHaveCount(2)
    await expect(provider).toHaveValue('openai-codex')
    expect(
      (await page.evaluate(() => window.envcadDesktop!.getAiPreferences()))
        .selectedProvider
    ).toBe('openai-codex')
  } finally {
    await application.close()
    await rm(profile, { recursive: true })
  }
})
