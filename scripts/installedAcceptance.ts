import { createHash } from 'node:crypto'
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import type { ProviderId } from '../src/agent/protocol'
import {
  cleanBenchmarkDxf,
  inspectDxf,
  resolveBenchmarkLaunchTarget
} from './aiBenchmark'

const MAX_WEBSOCKET_PAYLOAD_BYTES = 2 * 1024 * 1024
const TURN_TIMEOUT_MS = 240_000
const PROVIDERS: ProviderId[] = ['openai-codex', 'claude-code']

interface CliOptions {
  live: boolean
  executable?: string
  outputDirectory?: string
}

interface PromptEvidence {
  recordedAt: string
  provider: ProviderId
  promptCharacters: number
  promptUtf8Bytes: number
  promptSha256: string
  userTextCharacters: number
  userTextUtf8Bytes: number
  userTextSha256: string
  beginSentinelIndex: number
  middleSentinelIndex: number
  endSentinelIndex: number
}

interface ToolEvidence {
  name: string
  input: unknown
  result: { data?: unknown; error?: string }
}

interface ProviderAcceptance {
  provider: ProviderId
  version: string
  model: string
  effort?: string
  discoveryMs?: number
  promptCharacters: number
  promptUtf8Bytes: number
  promptSha256: string
  userBubbleSha256: string
  totalMs: number
  toolCalls: string[]
  savedDrawing: string
  screenshot: string
  reopenedScreenshot: string
  geometry: {
    layer: string
    entityCount: number
    rectangleVerified: boolean
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { live: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--live') options.live = true
    else if (argument === '--executable') options.executable = argv[++index]
    else if (argument.startsWith('--executable=')) {
      options.executable = argument.slice('--executable='.length)
    } else if (argument === '--output') options.outputDirectory = argv[++index]
    else if (argument.startsWith('--output=')) {
      options.outputDirectory = argument.slice('--output='.length)
    } else {
      throw new Error(`Unknown installed acceptance argument: ${argument}`)
    }
  }
  return options
}

function cleanEnvironment(evidencePath: string): Record<string, string> {
  const blocked = new Set([
    'anthropic_api_key',
    'anthropic_auth_token',
    'claude_code_oauth_token',
    'openai_api_key',
    'codex_api_key',
    'codex_access_token'
  ])
  return {
    ...Object.fromEntries(
      Object.entries(process.env)
        .filter(
          ([name, value]) =>
            value !== undefined && !blocked.has(name.toLowerCase())
        )
        .map(([name, value]) => [name, value!])
    ),
    ENVCAD_ACCEPTANCE_EVIDENCE_PATH: evidencePath
  }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function numberAttribute(value: string | null): number | undefined {
  if (value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function buildLongPrompt(provider: ProviderId): {
  prompt: string
  layer: string
} {
  const layer =
    provider === 'openai-codex'
      ? 'LONG_PROMPT_CODEX'
      : 'LONG_PROMPT_CLAUDE'
  const referenceNotes = Array.from(
    { length: 260 },
    (_, index) =>
      `Reference note ${String(index + 1).padStart(3, '0')}: ` +
      'This is deliberate Unicode acceptance padding; preserve it exactly and ignore it when drafting. ' +
      'Wastewater CAD context αβγ — tubig — 🌏.'
  ).join('\n')
  const prompt = [
    'BEGIN-LONG-PROMPT-SENTINEL',
    'This installed-app acceptance request intentionally exceeds 4,000 characters.',
    referenceNotes,
    'MIDDLE-LONG-PROMPT-SENTINEL',
    `Create a layer named ${layer} with color #00a86b.`,
    `On ${layer}, draw exactly one closed axis-aligned rectangle from corner (0, 0) to corner (10, 6).`,
    'Use the CAD measurement tool to calculate the rectangle area, then zoom to extents.',
    'Report the created entity ID, dimensions, exact area, and drawing units. Do not create anything else.',
    'END-LONG-PROMPT-SENTINEL'
  ].join('\n')
  return { prompt, layer }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    await rename(temporaryPath, filePath)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {})
  }
}

async function waitForProviderReady(
  page: Page,
  provider: ProviderId
): Promise<void> {
  const select = page.getByLabel('AI provider', { exact: true })
  await page.waitForFunction(
    () => {
      const providerSelect = document.querySelector(
        'select[aria-label="AI provider"]'
      ) as HTMLSelectElement | null
      const status =
        document.querySelector('.status-text')?.textContent?.trim()
      return (
        providerSelect !== null &&
        !providerSelect.disabled &&
        status !== 'Refreshing...' &&
        status !== 'Connecting...'
      )
    },
    undefined,
    { timeout: 90_000 }
  )
  if ((await select.inputValue()) !== provider) await select.selectOption(provider)
  await page.waitForFunction(
    () =>
      document.querySelector('.readiness-badge')?.textContent?.trim() !==
      'checking',
    undefined,
    { timeout: 90_000 }
  )
  const status = (await page.locator('.readiness-badge').textContent())?.trim()
  if (status !== 'ready') {
    const message = (await page.locator('.provider-message').textContent())?.trim()
    throw new Error(
      `${provider} is ${status ?? 'unavailable'}: ${message ?? 'no status detail'}`
    )
  }
  await page.waitForFunction(
    () =>
      !(document.querySelector('.chat-textarea') as HTMLTextAreaElement | null)
        ?.disabled,
    undefined,
    { timeout: 90_000 }
  )
}

async function refreshProviders(page: Page): Promise<void> {
  const refresh = page.getByRole('button', {
    name: 'Refresh models and provider status'
  })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await refresh.click()
    await page.waitForFunction(
      () =>
        document.querySelector('.status-text')?.textContent?.trim() ===
        'Refreshing...'
    )
    await page.waitForFunction(
      () =>
        document.querySelector('.status-text')?.textContent?.trim() === 'Idle',
      undefined,
      { timeout: 90_000 }
    )
  }
}

async function resetConversation(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: 'New chat', exact: true })
  await page.waitForFunction(
    () =>
      !(document.querySelector('.new-chat-btn') as HTMLButtonElement | null)
        ?.disabled
  )
  page.once('dialog', (dialog) => void dialog.accept())
  await button.click()
  await page.locator('.empty-state').waitFor({ state: 'visible' })
}

async function openDrawing(page: Page, filePath: string): Promise<void> {
  await page.locator('input[accept=".dxf,.dwg"]').setInputFiles(filePath)
  await page.getByRole('button', { name: 'Save DXF' }).waitFor({
    state: 'visible'
  })
  await page.waitForFunction(
    () =>
      !(Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Save DXF'
      ) as HTMLButtonElement | undefined)?.disabled
  )
  await page.waitForFunction(
    () => document.querySelector('.status-bar')?.textContent?.includes('Units: Meters'),
    undefined,
    { timeout: 30_000 }
  )
  await page.getByRole('button', { name: 'Zoom Extents', exact: true }).click()
}

async function saveDrawing(
  application: ElectronApplication,
  page: Page,
  destination: string
): Promise<void> {
  await rm(destination, { force: true })
  await application.evaluate(
    ({ session }, filePath) => {
      session.defaultSession.once('will-download', (_event, item) => {
        item.setSavePath(filePath)
      })
    },
    destination
  )
  await page.getByRole('button', { name: 'Save DXF' }).click()
  const deadline = performance.now() + 30_000
  while (performance.now() < deadline) {
    try {
      if ((await stat(destination)).size > 100) return
    } catch {
      // Keep polling until Electron completes the download.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Electron did not finish saving DXF output: ${destination}`)
}

async function collectTools(page: Page): Promise<ToolEvidence[]> {
  const locators = page.locator('.tool-chip')
  const output: ToolEvidence[] = []
  for (let index = 0; index < (await locators.count()); index += 1) {
    const chip = locators.nth(index)
    const name = (await chip.locator('.tool-name').textContent())?.trim() ?? ''
    await chip.locator('.chip-header').click()
    const details = await chip.locator('.tool-details pre').allTextContents()
    output.push({
      name,
      input: details[0] ? (JSON.parse(details[0]) as unknown) : {},
      result: details[1]
        ? (JSON.parse(details[1]) as ToolEvidence['result'])
        : { error: `${name || 'CAD tool'} did not expose a result.` }
    })
  }
  return output
}

function rectangleVerified(
  points: Array<{ x: number; y: number }> | undefined,
  closed: boolean | undefined
): boolean {
  if (!points || points.length !== 4 || closed !== true) return false
  const xs = [...new Set(points.map((point) => point.x))].sort((a, b) => a - b)
  const ys = [...new Set(points.map((point) => point.y))].sort((a, b) => a - b)
  return (
    xs.length === 2 &&
    ys.length === 2 &&
    xs[0] === 0 &&
    xs[1] === 10 &&
    ys[0] === 0 &&
    ys[1] === 6
  )
}

async function runProviderAcceptance(
  application: ElectronApplication,
  page: Page,
  provider: ProviderId,
  cleanDrawing: string,
  outputRoot: string
): Promise<ProviderAcceptance> {
  await waitForProviderReady(page, provider)
  await openDrawing(page, cleanDrawing)
  await resetConversation(page)

  const { prompt, layer } = buildLongPrompt(provider)
  const textarea = page.locator('.chat-textarea')
  await textarea.fill(prompt)
  if ((await textarea.inputValue()) !== prompt) {
    throw new Error(`${provider} textarea changed the long prompt before send.`)
  }
  const usersBefore = await page.locator('.bubble-row.user').count()
  const startedAt = performance.now()
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page.locator('.turn-metrics').waitFor({
    state: 'visible',
    timeout: TURN_TIMEOUT_MS
  })
  await page.waitForFunction(
    () => document.querySelector('.status-text')?.textContent?.trim() === 'Idle',
    undefined,
    { timeout: TURN_TIMEOUT_MS }
  )
  const totalMs = performance.now() - startedAt
  if ((await page.locator('.bubble-row.user').count()) !== usersBefore + 1) {
    throw new Error(`${provider} did not add exactly one user message.`)
  }
  const userText =
    (await page.locator('.bubble-row.user .bubble-text').last().textContent()) ??
    ''
  if (userText !== prompt) {
    throw new Error(`${provider} changed the long prompt in the chat timeline.`)
  }
  const errors = await page.locator('.bubble.error').allTextContents()
  if (errors.length > 0) {
    throw new Error(`${provider} returned UI errors: ${errors.join(' | ')}`)
  }
  const tools = await collectTools(page)
  const toolErrors = tools.flatMap((tool) =>
    tool.result.error ? [`${tool.name}: ${tool.result.error}`] : []
  )
  if (toolErrors.length > 0) {
    throw new Error(`${provider} CAD tools failed: ${toolErrors.join(' | ')}`)
  }
  for (const required of [
    'create_layer',
    'draw_rectangle',
    'calculate_area',
    'zoom_extents'
  ]) {
    if (!tools.some((tool) => tool.name === required)) {
      throw new Error(`${provider} did not call required CAD tool ${required}.`)
    }
  }

  const screenshot = path.join(outputRoot, `${provider}-long-prompt.png`)
  await page.screenshot({ path: screenshot })
  const savedDrawing = path.join(outputRoot, `${provider}-long-prompt.dxf`)
  await saveDrawing(application, page, savedDrawing)
  await openDrawing(page, savedDrawing)
  const reopenedScreenshot = path.join(
    outputRoot,
    `${provider}-reopened-drawing.png`
  )
  await page.screenshot({ path: reopenedScreenshot })

  const inspection = inspectDxf(await readFile(savedDrawing, 'utf8'))
  if (!inspection.layers.some((candidate) => candidate.name === layer)) {
    throw new Error(`${provider} saved DXF is missing layer ${layer}.`)
  }
  const entities = inspection.entities.filter(
    (entity) => entity.layer === layer
  )
  const verified = entities.some((entity) =>
    rectangleVerified(entity.points, entity.closed)
  )
  if (!verified) {
    throw new Error(`${provider} saved DXF does not contain the requested 10 m by 6 m rectangle.`)
  }

  const providerOption = page.locator(
    `select[aria-label="AI provider"] option[value="${provider}"]`
  )
  const metrics = page.locator('.turn-metrics').last()
  return {
    provider,
    version: (await providerOption.getAttribute('data-version')) ?? 'unknown',
    model: await page.getByLabel('AI model').inputValue(),
    effort: (await page.getByLabel('Reasoning effort').inputValue()) || undefined,
    discoveryMs: numberAttribute(
      await providerOption.getAttribute('data-discovery-ms')
    ),
    promptCharacters: prompt.length,
    promptUtf8Bytes: Buffer.byteLength(prompt, 'utf8'),
    promptSha256: sha256(prompt),
    userBubbleSha256: sha256(userText),
    totalMs:
      numberAttribute(await metrics.getAttribute('data-total-ms')) ?? totalMs,
    toolCalls: tools.map((tool) => tool.name),
    savedDrawing,
    screenshot,
    reopenedScreenshot,
    geometry: {
      layer,
      entityCount: entities.length,
      rectangleVerified: verified
    }
  }
}

async function verifyOversizedRejection(
  page: Page,
  outputRoot: string
): Promise<{
  promptCharacters: number
  promptUtf8Bytes: number
  draftPreserved: boolean
  userMessageSuppressed: boolean
  connectionPreserved: boolean
  screenshot: string
}> {
  await waitForProviderReady(page, 'openai-codex')
  await resetConversation(page)
  const oversized =
    'BEGIN-OVERSIZED-PROMPT\n' +
    '🧪'.repeat(Math.ceil(MAX_WEBSOCKET_PAYLOAD_BYTES / 4) + 2_048) +
    '\nEND-OVERSIZED-PROMPT'
  if (Buffer.byteLength(oversized, 'utf8') <= MAX_WEBSOCKET_PAYLOAD_BYTES) {
    throw new Error('The installed oversized test prompt did not exceed 2 MiB.')
  }
  const usersBefore = await page.locator('.bubble-row.user').count()
  const errorsBefore = await page.locator('.bubble.error').count()
  const textarea = page.locator('.chat-textarea')
  await textarea.fill(oversized)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page.waitForFunction(
    (priorCount) =>
      document.querySelectorAll('.bubble.error').length > priorCount,
    errorsBefore,
    { timeout: 30_000 }
  )
  const error = (await page.locator('.bubble.error').last().textContent()) ?? ''
  if (!/2 MiB|too large|payload/i.test(error)) {
    throw new Error(`Oversized rejection was not actionable: ${error}`)
  }
  const draftPreserved = (await textarea.inputValue()) === oversized
  const userMessageSuppressed =
    (await page.locator('.bubble-row.user').count()) === usersBefore
  const connectionPreserved =
    (await page.locator('.readiness-badge').textContent())?.trim() === 'ready' &&
    (await page.locator('.status-text').textContent())?.trim() === 'Idle' &&
    !(await textarea.isDisabled())
  if (!draftPreserved || !userMessageSuppressed || !connectionPreserved) {
    throw new Error(
      'Oversized rejection did not preserve the draft, suppress the false user message, and retain the connection.'
    )
  }
  const screenshot = path.join(outputRoot, 'oversized-prompt-rejected.png')
  await page.screenshot({ path: screenshot })
  await textarea.fill('')
  return {
    promptCharacters: oversized.length,
    promptUtf8Bytes: Buffer.byteLength(oversized, 'utf8'),
    draftPreserved,
    userMessageSuppressed,
    connectionPreserved,
    screenshot
  }
}

async function canConnect(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (value: boolean) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(1_000)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function launchInstalledApplication(
  automationDriver: string,
  applicationAsar: string,
  environment: Record<string, string>
): Promise<{ application: ElectronApplication; page: Page }> {
  const application = await electron.launch({
    executablePath: automationDriver,
    args: [applicationAsar],
    env: environment
  })
  const page = await application.firstWindow({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Open', exact: true }).waitFor({
    state: 'visible',
    timeout: 60_000
  })
  return { application, page }
}

async function waitForReadyRuntime(page: Page): Promise<{
  sidecar: {
    type: 'ready'
    connection: { url: string }
  }
}> {
  const deadline = performance.now() + 60_000
  while (performance.now() < deadline) {
    const runtime = await page.evaluate(() =>
      window.envcadDesktop?.getRuntimeConfig()
    )
    if (runtime?.sidecar.type === 'ready') {
      return runtime as {
        sidecar: {
          type: 'ready'
          connection: { url: string }
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Installed EnvCAD sidecar did not report a ready runtime within 60 seconds.')
}

async function readEvidence(filePath: string): Promise<PromptEvidence[]> {
  const contents = await readFile(filePath, 'utf8')
  return contents
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PromptEvidence)
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (!options.live) {
    throw new Error(
      'Real provider calls are disabled by default. Re-run with: npm run acceptance:installed -- --live'
    )
  }
  const launchTarget = resolveBenchmarkLaunchTarget(options.executable)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outputRoot = path.resolve(
    options.outputDirectory ??
      path.join(process.cwd(), 'output', 'desktop', 'installed-acceptance', timestamp)
  )
  await mkdir(outputRoot, { recursive: true })
  const evidencePath = path.join(outputRoot, 'provider-prompt-evidence.jsonl')
  await rm(evidencePath, { force: true })
  const cleanDrawing = path.join(outputRoot, 'clean-acceptance.dxf')
  const fixture = await readFile(
    path.join(process.cwd(), 'test', 'fixtures', 'sample-site.dxf'),
    'utf8'
  )
  await writeFile(cleanDrawing, cleanBenchmarkDxf(fixture), 'utf8')
  const environment = cleanEnvironment(evidencePath)
  const results: ProviderAcceptance[] = []
  const ports: number[] = []
  const applicationProcessIds: number[] = []
  let application: ElectronApplication | undefined
  try {
    const launched = await launchInstalledApplication(
      launchTarget.automationDriver,
      launchTarget.applicationAsar,
      environment
    )
    application = launched.application
    const firstApplicationPid = application.process().pid
    if (!firstApplicationPid) {
      throw new Error('Installed EnvCAD did not expose an application process id.')
    }
    applicationProcessIds.push(firstApplicationPid)
    const page = launched.page
    const runtime = await waitForReadyRuntime(page)
    ports.push(Number(new URL(runtime.sidecar.connection.url).port))
    await refreshProviders(page)
    for (const provider of PROVIDERS) {
      results.push(
        await runProviderAcceptance(
          application,
          page,
          provider,
          cleanDrawing,
          outputRoot
        )
      )
    }
    const oversized = await verifyOversizedRejection(page, outputRoot)
    await application.close()
    application = undefined
    if (await canConnect(ports[0])) {
      throw new Error(`First installed sidecar port ${ports[0]} remained open after app close.`)
    }

    const relaunched = await launchInstalledApplication(
      launchTarget.automationDriver,
      launchTarget.applicationAsar,
      environment
    )
    application = relaunched.application
    const secondApplicationPid = application.process().pid
    if (!secondApplicationPid) {
      throw new Error('Relaunched EnvCAD did not expose an application process id.')
    }
    applicationProcessIds.push(secondApplicationPid)
    const secondRuntime = await waitForReadyRuntime(relaunched.page)
    ports.push(Number(new URL(secondRuntime.sidecar.connection.url).port))
    await waitForProviderReady(relaunched.page, 'openai-codex')
    await openDrawing(
      relaunched.page,
      results.find((result) => result.provider === 'openai-codex')!.savedDrawing
    )
    await relaunched.page.locator('.toast[role="alert"]').waitFor({
      state: 'detached',
      timeout: 10_000
    })
    const relaunchScreenshot = path.join(outputRoot, 'relaunch-reopened-drawing.png')
    await relaunched.page.screenshot({ path: relaunchScreenshot })
    await application.close()
    application = undefined
    if (await canConnect(ports[1])) {
      throw new Error(`Relaunched sidecar port ${ports[1]} remained open after app close.`)
    }

    const evidence = await readEvidence(evidencePath)
    if (evidence.length !== PROVIDERS.length) {
      throw new Error(
        `Expected ${PROVIDERS.length} provider prompt evidence rows; found ${evidence.length}.`
      )
    }
    for (const result of results) {
      const row = evidence.find((candidate) => candidate.provider === result.provider)
      if (!row) throw new Error(`Missing provider evidence for ${result.provider}.`)
      if (
        row.userTextCharacters !== result.promptCharacters ||
        row.userTextUtf8Bytes !== result.promptUtf8Bytes ||
        row.userTextSha256 !== result.promptSha256 ||
        row.beginSentinelIndex < 0 ||
        row.middleSentinelIndex < 0 ||
        row.endSentinelIndex < 0
      ) {
        throw new Error(`${result.provider} provider-boundary prompt evidence did not match the exact UI prompt.`)
      }
    }
    const report = {
      schemaVersion: 1,
      status: 'passed',
      generatedAt: new Date().toISOString(),
      launchTarget,
      applicationProcessIds,
      results,
      oversized,
      evidencePath,
      sidecarPorts: ports,
      sidecarPortsClosed: true,
      relaunchScreenshot
    }
    const reportPath = path.join(outputRoot, 'installed-acceptance.json')
    await writeJsonAtomic(reportPath, report)
    console.log(
      JSON.stringify({
        status: 'passed',
        outputRoot,
        reportPath,
        providers: results.map((result) => ({
          provider: result.provider,
          version: result.version,
          model: result.model,
          promptCharacters: result.promptCharacters,
          promptUtf8Bytes: result.promptUtf8Bytes,
          promptSha256: result.promptSha256,
          totalMs: Math.round(result.totalMs),
          toolCalls: result.toolCalls
        })),
        oversized: {
          promptCharacters: oversized.promptCharacters,
          promptUtf8Bytes: oversized.promptUtf8Bytes,
          draftPreserved: oversized.draftPreserved,
          userMessageSuppressed: oversized.userMessageSuppressed,
          connectionPreserved: oversized.connectionPreserved
        },
        sidecarPorts: ports,
        sidecarPortsClosed: true
      })
    )
  } finally {
    if (application) await application.close().catch(() => {})
  }
}

await main()
