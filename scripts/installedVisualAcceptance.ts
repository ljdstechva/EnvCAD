import { createHash } from 'node:crypto'
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import type { ProviderId } from '../src/agent/protocol'
import {
  inspectDxf,
  resolveBenchmarkLaunchTarget
} from './aiBenchmark'
import {
  compareVisualAnswer,
  HIDDEN_MARKER_PROMPT,
  parseVisualModelAnswer,
  STRUCTURE_ONLY_PROMPT,
  type VisualModelAnswer
} from './visualAcceptance'
import {
  createVisualFixtureDxf,
  visualFixtureExpectation,
  type VisualFixtureId,
  type VisualFixtureExpectation
} from './visualFixtures'
import { envCadClaudeProjectDirectoryPattern } from '../desktop/claudeTranscriptCleanup'

const TURN_TIMEOUT_MS = 300_000
const PROVIDERS: ProviderId[] = ['claude-code', 'openai-codex']
const INSPECT_WITH_AI_PROMPT =
  'Inspect the current Sheet Preview. State whether it is blank, clipped, unreadable, low-contrast, or overlapping, and describe only what you can actually see.'

interface CliOptions {
  live: boolean
  executable?: string
  outputDirectory?: string
  provider?: ProviderId
  drawing?: string
  scope: 'markers' | 'full'
  useAutomationDriver: boolean
}

interface CatalogModel {
  value: string
  displayName: string
  resolvedModel?: string
  inputModalities?: string[]
  isDefault: boolean
}

interface SelectedConfiguration {
  provider: ProviderId
  providerVersion: string
  model: string
  modelDisplayName: string
  advertisedResolvedModel?: string
  inputModalities?: string[]
  effort?: string
  selectionReason: string
}

interface PromptEvidence {
  evidenceType: 'prompt'
  recordedAt: string
  provider: ProviderId
  userTextSha256: string
  userTextCharacters: number
  userTextUtf8Bytes: number
}

interface VisualEvidence {
  evidenceType: 'visual-image'
  recordedAt: string
  provider: ProviderId
  requestedModel: string
  effort?: string
  transport: 'claude-mcp-image' | 'codex-dynamic-inputImage'
  mimeType: 'image/png' | 'image/webp'
  width: number
  height: number
  byteLength: number
  rasterSha256: string
  svgSha256?: string
  captureId: string
  renderRevision: number
}

type AcceptanceEvidence = PromptEvidence | VisualEvidence

interface PreviewEvidence {
  screenshot: string
  windowScreenshot: string
  svgSha256: string
  renderRevision: number
  renderStatus: string
  drawableElements: number
  unitMismatch: boolean
  warnings: string[]
}

interface TurnEvidence {
  prompt: string
  promptSha256: string
  provider: ProviderId
  requestedModel: string
  resolvedModel: string
  resolvedModelSource:
    | 'provider-response'
    | 'advertised-alias'
    | 'concrete-invocation'
  effort?: string
  wallClockMs: number
  firstToolCallMs: number
  totalMs: number
  toolCalls: Array<{
    name: string
    input: unknown
    status: 'ok' | 'error' | 'pending'
    summary: string
  }>
  response: string
  promptEvidence: PromptEvidence
  visualEvidence: VisualEvidence[]
}

interface FixtureResult {
  fixture: string
  expected?: VisualFixtureExpectation
  observed?: VisualModelAnswer
  preview: PreviewEvidence
  turn: TurnEvidence
}

interface ProviderResult {
  configuration: SelectedConfiguration
  markers: FixtureResult[]
  blank?: FixtureResult
  defect?: FixtureResult
  m01?: {
    drawing: string
    preview: PreviewEvidence
    turn: TurnEvidence
    visuallyNonblank: boolean
    structureDescribed: boolean
  }
}

interface ClaudeTranscriptSnapshot {
  directories: number
  files: number
  bytes: number
  entries: Map<string, { size: number; mtimeMs: number }>
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    live: false,
    scope: 'full',
    useAutomationDriver: true
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--live') options.live = true
    else if (argument === '--executable') options.executable = argv[++index]
    else if (argument.startsWith('--executable=')) {
      options.executable = argument.slice('--executable='.length)
    } else if (argument === '--output') {
      options.outputDirectory = argv[++index]
    } else if (argument.startsWith('--output=')) {
      options.outputDirectory = argument.slice('--output='.length)
    } else if (argument === '--provider') {
      options.provider = parseProvider(argv[++index])
    } else if (argument.startsWith('--provider=')) {
      options.provider = parseProvider(argument.slice('--provider='.length))
    } else if (argument === '--drawing') {
      options.drawing = argv[++index]
    } else if (argument.startsWith('--drawing=')) {
      options.drawing = argument.slice('--drawing='.length)
    } else if (argument === '--scope') {
      options.scope = parseScope(argv[++index])
    } else if (argument.startsWith('--scope=')) {
      options.scope = parseScope(argument.slice('--scope='.length))
    } else if (argument === '--automation-driver') {
      options.useAutomationDriver = true
    } else if (argument === '--direct-installed-executable') {
      options.useAutomationDriver = false
    } else {
      throw new Error(`Unknown installed visual acceptance argument: ${argument}`)
    }
  }
  if (options.scope === 'full' && !options.drawing) {
    throw new Error(
      'Full installed visual acceptance requires --drawing <M-01.dxf>.'
    )
  }
  return options
}

function parseProvider(value: string | undefined): ProviderId {
  if (!value || !PROVIDERS.includes(value as ProviderId)) {
    throw new Error(`Provider must be ${PROVIDERS.join(' or ')}.`)
  }
  return value as ProviderId
}

function parseScope(value: string | undefined): CliOptions['scope'] {
  if (value !== 'markers' && value !== 'full') {
    throw new Error('Scope must be markers or full.')
  }
  return value
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

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    await rename(temporaryPath, filePath)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {})
  }
}

async function launchApplication(
  executablePath: string,
  applicationAsar: string,
  environment: Record<string, string>,
  useAutomationDriver: boolean
): Promise<{ application: ElectronApplication; page: Page; port: number }> {
  const application = await electron.launch({
    executablePath,
    ...(useAutomationDriver ? { args: [applicationAsar] } : {}),
    env: environment
  })
  const page = await application.firstWindow({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Open', exact: true }).waitFor({
    state: 'visible',
    timeout: 60_000
  })
  const deadline = performance.now() + 60_000
  while (performance.now() < deadline) {
    const runtime = await page.evaluate(() =>
      window.envcadDesktop?.getRuntimeConfig()
    )
    if (runtime?.sidecar.type === 'ready') {
      return {
        application,
        page,
        port: Number(new URL(runtime.sidecar.connection.url).port)
      }
    }
    await delay(100)
  }
  await application.close().catch(() => {})
  throw new Error('Installed EnvCAD sidecar was not ready within 60 seconds.')
}

async function refreshProviders(page: Page): Promise<void> {
  const refresh = page.getByRole('button', {
    name: 'Refresh models and provider status'
  })
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

async function waitForProviderReady(
  page: Page,
  provider: ProviderId
): Promise<void> {
  await page.getByRole('button', { name: 'AI Assistant' }).click()
  const select = page.getByLabel('AI provider', { exact: true })
  if ((await select.inputValue()) !== provider) {
    await select.selectOption(provider)
  }
  await page.waitForFunction(
    (requestedProvider) => {
      const providerSelect = document.querySelector(
        'select[aria-label="AI provider"]'
      ) as HTMLSelectElement | null
      return (
        providerSelect?.value === requestedProvider &&
        document.querySelector('.readiness-badge')?.textContent?.trim() ===
          'ready' &&
        document.querySelector('.status-text')?.textContent?.trim() ===
          'Idle' &&
        !(document.querySelector(
          'select[aria-label="AI model"]'
        ) as HTMLSelectElement | null)?.disabled
      )
    },
    provider,
    { timeout: 90_000 }
  )
}

async function selectBestConfiguration(
  page: Page,
  provider: ProviderId
): Promise<SelectedConfiguration> {
  await waitForProviderReady(page, provider)
  const modelSelect = page.getByLabel('AI model', { exact: true })
  const models = await modelSelect.locator('option').evaluateAll((options) =>
    options.map((option) => {
      const element = option as HTMLOptionElement
      return {
        value: element.value,
        displayName: element.textContent?.trim() ?? element.value,
        resolvedModel: element.dataset.resolvedModel || undefined,
        inputModalities: element.dataset.inputModalities
          ? element.dataset.inputModalities.split(',')
          : undefined,
        isDefault: element.dataset.isDefault === 'true'
      }
    })
  )
  if (models.length === 0) {
    throw new Error(`${provider} advertised no models.`)
  }
  const selected =
    provider === 'claude-code'
      ? chooseClaudeModel(models)
      : chooseCodexModel(models)
  if ((await modelSelect.inputValue()) !== selected.value) {
    await modelSelect.selectOption(selected.value)
    await waitForIdleConfiguration(page, selected.value)
  }

  const effortSelect = page.getByLabel('Reasoning effort', { exact: true })
  const efforts = await effortSelect.locator('option').evaluateAll((options) =>
    options
      .map((option) => (option as HTMLOptionElement).value)
      .filter(Boolean)
  )
  const effort =
    provider === 'claude-code'
      ? chooseClaudeEffort(efforts)
      : chooseCodexEffort(efforts)
  if (effort && (await effortSelect.inputValue()) !== effort) {
    await effortSelect.selectOption(effort)
    await waitForIdleConfiguration(page, selected.value, effort)
  }
  const providerMessage =
    (await page.locator('.readiness-badge').getAttribute('title')) ?? ''
  const version =
    /(?:Claude Code|Codex CLI)\s+([0-9][^\s]*)/i.exec(providerMessage)?.[1] ??
    'not-reported'
  return {
    provider,
    providerVersion: version,
    model: selected.value,
    modelDisplayName: selected.displayName,
    ...(selected.resolvedModel
      ? { advertisedResolvedModel: selected.resolvedModel }
      : {}),
    ...(selected.inputModalities
      ? { inputModalities: selected.inputModalities }
      : {}),
    ...(effort ? { effort } : {}),
    selectionReason:
      provider === 'claude-code'
        ? 'Newest advertised non-preview Opus model; high effort when available.'
        : 'First/newest advertised image-capable Codex model; xhigh or highest non-ultra effort.'
  }
}

function chooseClaudeModel(models: CatalogModel[]): CatalogModel {
  const stable = models.filter(
    (model) =>
      !/(?:preview|experimental|beta)/i.test(
        `${model.value} ${model.displayName} ${model.resolvedModel ?? ''}`
      )
  )
  return (
    stable.find((model) =>
      /\bopus\b/i.test(
        `${model.value} ${model.displayName} ${model.resolvedModel ?? ''}`
      )
    ) ??
    stable[0] ??
    models[0]
  )
}

function chooseCodexModel(models: CatalogModel[]): CatalogModel {
  const stable = models.filter(
    (model) =>
      !/(?:preview|experimental|beta)/i.test(
        `${model.value} ${model.displayName} ${model.resolvedModel ?? ''}`
      )
  )
  const imageCapable = stable.filter(
    (model) =>
      model.inputModalities === undefined ||
      model.inputModalities.includes('image')
  )
  if (imageCapable.length === 0) {
    throw new Error('Codex advertised no image-capable or unknown-modality model.')
  }
  return imageCapable[0]
}

function chooseClaudeEffort(efforts: string[]): string | undefined {
  if (efforts.includes('high')) return 'high'
  return highestEffort(efforts, ['max', 'xhigh', 'high', 'medium', 'low'])
}

function chooseCodexEffort(efforts: string[]): string | undefined {
  if (efforts.includes('xhigh')) return 'xhigh'
  return highestEffort(
    efforts.filter((effort) => effort !== 'ultra'),
    ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none']
  )
}

function highestEffort(
  available: string[],
  preferred: string[]
): string | undefined {
  return preferred.find((effort) => available.includes(effort)) ?? available[0]
}

async function waitForIdleConfiguration(
  page: Page,
  model: string,
  effort?: string
): Promise<void> {
  await page.waitForFunction(
    ({ expectedModel, expectedEffort }) => {
      const modelSelect = document.querySelector(
        'select[aria-label="AI model"]'
      ) as HTMLSelectElement | null
      const effortSelect = document.querySelector(
        'select[aria-label="Reasoning effort"]'
      ) as HTMLSelectElement | null
      return (
        modelSelect?.value === expectedModel &&
        (!expectedEffort || effortSelect?.value === expectedEffort) &&
        document.querySelector('.status-text')?.textContent?.trim() === 'Idle' &&
        !modelSelect?.disabled &&
        !effortSelect?.disabled
      )
    },
    { expectedModel: model, expectedEffort: effort },
    { timeout: 90_000 }
  )
}

async function resetConversation(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'AI Assistant' }).click()
  if (await page.locator('.empty-state').isVisible()) return
  const button = page.getByRole('button', { name: 'New chat', exact: true })
  await button.waitFor({ state: 'visible' })
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
  await page.waitForFunction(
    () =>
      !(Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Save DXF'
      ) as HTMLButtonElement | undefined)?.disabled,
    undefined,
    { timeout: 60_000 }
  )
  await page.waitForFunction(
    () => document.querySelector('.status-bar')?.textContent?.includes('Units:'),
    undefined,
    { timeout: 60_000 }
  )
}

async function configureM01(page: Page, screenshot: string): Promise<void> {
  await page.getByRole('button', { name: 'Page Setup', exact: true }).click()
  const dialog = page.locator('.dialog')
  await dialog.waitFor({ state: 'visible' })
  await dialog
    .locator('.field-row')
    .filter({ hasText: 'Paper size' })
    .locator('select')
    .selectOption('A1')
  await dialog.getByRole('button', { name: /Landscape/ }).click()
  await dialog
    .locator('.field-row')
    .filter({ hasText: 'Scale' })
    .locator('select')
    .selectOption('200')
  await dialog
    .locator('.field-row')
    .filter({ hasText: 'Drawing unit' })
    .locator('select')
    .selectOption('mm')
  for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
    await dialog
      .locator('.margins-grid label')
      .filter({ hasText: side })
      .locator('input')
      .fill('10')
  }
  await dialog.getByRole('button', { name: 'Fit extents' }).click()
  await dialog.getByRole('button', { name: /No template/ }).click()
  await page.screenshot({ path: screenshot })
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
}

async function capturePreview(
  page: Page,
  outputRoot: string,
  label: string
): Promise<PreviewEvidence> {
  await page.getByRole('button', { name: 'Sheet Preview' }).click()
  await page.waitForFunction(
    () => {
      const preview = document.querySelector('.preview-viewport')
      const status = preview?.getAttribute('data-render-status')
      return (
        (status === 'ready' || status === 'warning') &&
        /^[a-f0-9]{64}$/.test(
          preview?.getAttribute('data-svg-sha256') ?? ''
        )
      )
    },
    undefined,
    { timeout: 60_000 }
  )
  const preview = page.locator('.preview-viewport')
  const screenshot = path.join(outputRoot, `${label}-preview.png`)
  const windowScreenshot = path.join(outputRoot, `${label}-window.png`)
  await preview.screenshot({ path: screenshot })
  await page.screenshot({ path: windowScreenshot })
  return {
    screenshot,
    windowScreenshot,
    svgSha256: (await preview.getAttribute('data-svg-sha256'))!,
    renderRevision: Number(
      await preview.getAttribute('data-render-revision')
    ),
    renderStatus:
      (await preview.getAttribute('data-render-status')) ?? 'unknown',
    drawableElements: Number(
      await preview.getAttribute('data-drawable-elements')
    ),
    unitMismatch:
      (await preview.getAttribute('data-unit-mismatch')) === 'true',
    warnings: await page.locator('.warning-banner').allTextContents()
  }
}

async function runPromptTurn(
  page: Page,
  provider: ProviderId,
  configuration: SelectedConfiguration,
  prompt: string,
  preview: PreviewEvidence,
  evidencePath: string
): Promise<TurnEvidence> {
  await page.getByRole('button', { name: 'AI Assistant' }).click()
  const beforeRows = await readAcceptanceEvidence(evidencePath)
  const assistantBefore = await page.locator('.bubble.assistant').count()
  const toolBefore = await page.locator('.tool-chip').count()
  const errorBefore = await page.locator('.bubble.error').count()
  const startedAt = performance.now()
  await page.locator('.chat-textarea').fill(prompt)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  return collectTurn(
    page,
    provider,
    configuration,
    prompt,
    preview,
    evidencePath,
    beforeRows,
    assistantBefore,
    toolBefore,
    errorBefore,
    startedAt,
    true
  )
}

async function runInspectButtonTurn(
  page: Page,
  provider: ProviderId,
  configuration: SelectedConfiguration,
  preview: PreviewEvidence,
  evidencePath: string
): Promise<TurnEvidence> {
  const beforeRows = await readAcceptanceEvidence(evidencePath)
  const assistantBefore = await page.locator('.bubble.assistant').count()
  const toolBefore = await page.locator('.tool-chip').count()
  const errorBefore = await page.locator('.bubble.error').count()
  const startedAt = performance.now()
  const button = page.locator('.inspect-btn')
  await button.waitFor({ state: 'visible' })
  if (!(await button.isEnabled())) {
    throw new Error('Inspect with AI was disabled for a ready visual turn.')
  }
  await button.click()
  return collectTurn(
    page,
    provider,
    configuration,
    INSPECT_WITH_AI_PROMPT,
    preview,
    evidencePath,
    beforeRows,
    assistantBefore,
    toolBefore,
    errorBefore,
    startedAt,
    false
  )
}

async function collectTurn(
  page: Page,
  provider: ProviderId,
  configuration: SelectedConfiguration,
  prompt: string,
  preview: PreviewEvidence,
  evidencePath: string,
  beforeRows: AcceptanceEvidence[],
  assistantBefore: number,
  toolBefore: number,
  errorBefore: number,
  startedAt: number,
  strictVisualOnly: boolean
): Promise<TurnEvidence> {
  await page.waitForFunction(
    ({ minimumAssistant, minimumTools }) => {
      const status =
        document.querySelector('.status-text')?.textContent?.trim()
      return (
        status === 'Idle' &&
        document.querySelectorAll('.bubble.assistant').length >
          minimumAssistant &&
        document.querySelectorAll('.tool-chip').length > minimumTools
      )
    },
    { minimumAssistant: assistantBefore, minimumTools: toolBefore },
    { timeout: TURN_TIMEOUT_MS }
  )
  const wallClockMs = performance.now() - startedAt
  const newErrors = await page
    .locator('.bubble.error')
    .evaluateAll((elements, start) =>
      elements.slice(start as number).map((element) => element.textContent ?? ''),
      errorBefore
    )
  if (newErrors.length > 0) {
    throw new Error(`${provider} visual turn failed: ${newErrors.join(' | ')}`)
  }

  const newAssistant = await page
    .locator('.bubble.assistant')
    .evaluateAll((elements, start) =>
      elements
        .slice(start as number)
        .map(
          (element) =>
            element.querySelector('.bubble-text')?.textContent?.trim() ?? ''
        )
        .filter(Boolean),
      assistantBefore
    )
  const response = newAssistant.join('\n').trim()
  if (!response) throw new Error(`${provider} returned no visual response.`)

  const toolChips = page.locator('.tool-chip')
  const toolCalls: TurnEvidence['toolCalls'] = []
  for (let index = toolBefore; index < (await toolChips.count()); index += 1) {
    const chip = toolChips.nth(index)
    const name = (await chip.locator('.tool-name').textContent())?.trim() ?? ''
    const summary =
      (await chip.locator('.tool-input').textContent())?.trim() ?? ''
    const classes = (await chip.getAttribute('class')) ?? ''
    const status: TurnEvidence['toolCalls'][number]['status'] = classes.includes('error')
      ? 'error'
      : classes.includes('ok')
        ? 'ok'
        : 'pending'
    await chip.locator('.chip-header').click()
    const inputText = await chip.locator('.detail-block pre').first().textContent()
    await chip.locator('.chip-header').click()
    let input: unknown
    try {
      input = JSON.parse(inputText ?? 'null')
    } catch {
      input = inputText
    }
    toolCalls.push({ name, input, status, summary })
  }
  const visualToolCalls = toolCalls.filter(
    (tool) => tool.name === 'inspect_sheet_preview'
  )
  const m01ReadOnlyTools = new Set([
    'get_drawing_context',
    'get_sheet_setup',
    'get_view_status',
    'inspect_sheet_preview'
  ])
  const toolUsageIsValid = strictVisualOnly
    ? toolCalls.length > 0 &&
      toolCalls.every(
        (tool) =>
          tool.name === 'inspect_sheet_preview' &&
          tool.status === 'ok' &&
          (tool.input as { view?: unknown } | null)?.view === 'full'
      )
    : visualToolCalls.length > 0 &&
      visualToolCalls.length <= 3 &&
      visualToolCalls.some(
        (tool) =>
          (tool.input as { view?: unknown } | null)?.view === 'full'
      ) &&
      toolCalls.every(
        (tool) => m01ReadOnlyTools.has(tool.name) && tool.status === 'ok'
      )
  if (!toolUsageIsValid) {
    throw new Error(
      `${provider} used invalid visual-inspection tools: ${JSON.stringify(
        toolCalls
      )}`
    )
  }

  const metrics = page.locator('.turn-metrics').last()
  const firstToolCallMs = Number(
    await metrics.getAttribute('data-first-tool-call-ms')
  )
  const totalMs = Number(await metrics.getAttribute('data-total-ms'))
  if (
    !Number.isFinite(firstToolCallMs) ||
    firstToolCallMs < 0 ||
    !Number.isFinite(totalMs) ||
    totalMs <= 0
  ) {
    throw new Error(`${provider} did not report valid visual-turn timing.`)
  }
  const responseMeta = page.locator('.response-meta').last()
  const meta = await responseMeta.locator('span').evaluateAll((spans) =>
    spans.map((span) => ({
      text: span.textContent?.trim() ?? '',
      title: span.getAttribute('title') ?? ''
    }))
  )
  if (meta[0]?.text !== providerDisplayName(provider)) {
    throw new Error(
      `Provider fallback detected: selected ${provider}, response was ${meta[0]?.text}.`
    )
  }
  const providerResolvedModel = meta
    .map((item) => /^Resolved model:\s*(.+)$/i.exec(item.title)?.[1])
    .find(Boolean)
  const resolvedModel =
    providerResolvedModel ??
    configuration.advertisedResolvedModel ??
    configuration.model
  const resolvedModelSource = providerResolvedModel
    ? 'provider-response'
    : configuration.advertisedResolvedModel
      ? 'advertised-alias'
      : 'concrete-invocation'

  const evidence = await waitForNewEvidence(
    evidencePath,
    beforeRows.length,
    visualToolCalls.length
  )
  const promptRows = evidence.filter(
    (row): row is PromptEvidence => row.evidenceType === 'prompt'
  )
  const visualRows = evidence.filter(
    (row): row is VisualEvidence => row.evidenceType === 'visual-image'
  )
  if (
    promptRows.length !== 1 ||
    visualRows.length !== visualToolCalls.length
  ) {
    throw new Error(
      `${provider} provider-boundary evidence count was prompt=${promptRows.length}, visual=${visualRows.length}.`
    )
  }
  const promptHash = sha256(prompt)
  if (
    promptRows[0].provider !== provider ||
    promptRows[0].userTextSha256 !== promptHash ||
    promptRows[0].userTextCharacters !== prompt.length ||
    promptRows[0].userTextUtf8Bytes !== Buffer.byteLength(prompt, 'utf8')
  ) {
    throw new Error(`${provider} prompt-boundary evidence did not match the UI request.`)
  }
  const expectedTransport =
    provider === 'claude-code'
      ? 'claude-mcp-image'
      : 'codex-dynamic-inputImage'
  for (const [index, row] of visualRows.entries()) {
    if (
      row.provider !== provider ||
      row.transport !== expectedTransport ||
      row.requestedModel !== configuration.model ||
      row.effort !== configuration.effort ||
      row.svgSha256 !== preview.svgSha256 ||
      row.byteLength <= 0 ||
      row.byteLength > 1_179_648 ||
      !/^[a-f0-9]{64}$/.test(row.rasterSha256) ||
      !visualToolCalls[index]?.summary.includes(row.rasterSha256.slice(0, 12))
    ) {
      throw new Error(
        `${provider} visual adapter evidence did not match the preview/tool chip.`
      )
    }
  }
  return {
    prompt,
    promptSha256: promptHash,
    provider,
    requestedModel: configuration.model,
    resolvedModel,
    resolvedModelSource,
    ...(configuration.effort ? { effort: configuration.effort } : {}),
    wallClockMs,
    firstToolCallMs,
    totalMs,
    toolCalls,
    response,
    promptEvidence: promptRows[0],
    visualEvidence: visualRows
  }
}

function providerDisplayName(provider: ProviderId): string {
  return provider === 'claude-code' ? 'Claude Code' : 'OpenAI Codex'
}

async function runStructuredFixture(
  page: Page,
  provider: ProviderId,
  configuration: SelectedConfiguration,
  fixturePath: string,
  fixtureId: VisualFixtureId,
  outputRoot: string,
  evidencePath: string,
  requireMarkers: boolean
): Promise<FixtureResult> {
  await openDrawing(page, fixturePath)
  await resetConversation(page)
  const label = `${provider}-${fixtureId}`
  const preview = await capturePreview(page, outputRoot, label)
  const prompt =
    fixtureId === 'a' || fixtureId === 'b'
      ? HIDDEN_MARKER_PROMPT
      : STRUCTURE_ONLY_PROMPT
  const turn = await runPromptTurn(
    page,
    provider,
    configuration,
    prompt,
    preview,
    evidencePath
  )
  if (turn.toolCalls.length !== 1) {
    throw new Error(`${provider} ${fixtureId} used more than one capture.`)
  }
  const expected = visualFixtureExpectation(fixtureId)
  const observed = parseVisualModelAnswer(turn.response)
  const issues = compareVisualAnswer(observed, expected, {
    requireMarkers
  })
  if (issues.length > 0) {
    throw new Error(
      `${provider} misread hidden visual fixture ${fixtureId}: ${issues.join(
        '; '
      )}`
    )
  }
  return {
    fixture: fixturePath,
    expected,
    observed,
    preview,
    turn
  }
}

async function runM01(
  page: Page,
  provider: ProviderId,
  configuration: SelectedConfiguration,
  drawing: string,
  outputRoot: string,
  evidencePath: string
): Promise<NonNullable<ProviderResult['m01']>> {
  await openDrawing(page, drawing)
  await configureM01(
    page,
    path.join(outputRoot, `${provider}-m01-page-setup.png`)
  )
  await resetConversation(page)
  const preview = await capturePreview(page, outputRoot, `${provider}-m01`)
  const turn = await runInspectButtonTurn(
    page,
    provider,
    configuration,
    preview,
    evidencePath
  )
  const lower = turn.response.toLowerCase()
  const visuallyNonblank =
    !/(?:page|preview|sheet)\s+(?:is|appears|looks)\s+(?:completely\s+)?blank/.test(
      lower
    ) &&
    !/\bno\s+(?:drawing|content|geometry|linework)\b/.test(lower)
  const structureDescribed =
    turn.response.length >= 80 &&
    /\b(?:border|linework|drawing|layout|page|sheet|title|frame|structure)\b/i.test(
      turn.response
    )
  if (!visuallyNonblank || !structureDescribed) {
    throw new Error(
      `${provider} did not visually confirm the nonblank M-01 page structure: ${turn.response}`
    )
  }
  await page.screenshot({
    path: path.join(outputRoot, `${provider}-m01-response.png`)
  })
  return {
    drawing,
    preview,
    turn,
    visuallyNonblank,
    structureDescribed
  }
}

async function readAcceptanceEvidence(
  filePath: string
): Promise<AcceptanceEvidence[]> {
  try {
    const contents = await readFile(filePath, 'utf8')
    return contents
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AcceptanceEvidence)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function waitForNewEvidence(
  filePath: string,
  priorRows: number,
  expectedVisualRows: number
): Promise<AcceptanceEvidence[]> {
  const deadline = performance.now() + 10_000
  while (performance.now() < deadline) {
    const rows = await readAcceptanceEvidence(filePath)
    const added = rows.slice(priorRows)
    if (
      added.some((row) => row.evidenceType === 'prompt') &&
      added.filter((row) => row.evidenceType === 'visual-image').length >=
        expectedVisualRows
    ) {
      return added
    }
    await delay(50)
  }
  throw new Error('Provider-boundary visual evidence was not flushed within 10 seconds.')
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const finish = (value: boolean) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(1_000)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function waitForPortClosed(port: number): Promise<void> {
  const deadline = performance.now() + 15_000
  while (performance.now() < deadline) {
    if (!(await canConnect(port))) return
    await delay(100)
  }
  throw new Error(`Sidecar port ${port} remained open after application close.`)
}

async function runtimeSessions(): Promise<string[]> {
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) return []
  const root = path.join(localAppData, 'EnvCAD', 'ai-runtime')
  try {
    return (await readdir(root))
      .filter((entry) => entry.startsWith('session-'))
      .sort()
  } catch {
    return []
  }
}

async function claudeTranscriptSnapshot(): Promise<ClaudeTranscriptSnapshot> {
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) {
    throw new Error('LOCALAPPDATA is unavailable for Claude transcript verification.')
  }
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects')
  const projectPattern = envCadClaudeProjectDirectoryPattern(localAppData)
  const entries = new Map<string, { size: number; mtimeMs: number }>()
  let directories = 0
  let bytes = 0
  let projects
  try {
    projects = await readdir(projectsRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { directories: 0, files: 0, bytes: 0, entries }
    }
    throw error
  }

  async function visit(directory: string, relativeRoot: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true })
    for (const child of children) {
      const relative = path.join(relativeRoot, child.name)
      const absolute = path.join(directory, child.name)
      if (child.isDirectory()) {
        await visit(absolute, relative)
      } else if (child.isFile()) {
        const metadata = await stat(absolute)
        entries.set(relative, {
          size: metadata.size,
          mtimeMs: metadata.mtimeMs
        })
        bytes += metadata.size
      }
    }
  }

  for (const project of projects) {
    if (!project.isDirectory() || !projectPattern.test(project.name)) continue
    directories += 1
    await visit(path.join(projectsRoot, project.name), project.name)
  }
  return { directories, files: entries.size, bytes, entries }
}

function changedClaudeTranscriptFiles(
  baseline: ClaudeTranscriptSnapshot,
  final: ClaudeTranscriptSnapshot
): string[] {
  const changed: string[] = []
  for (const [relative, metadata] of final.entries) {
    const previous = baseline.entries.get(relative)
    if (
      !previous ||
      previous.size !== metadata.size ||
      previous.mtimeMs !== metadata.mtimeMs
    ) {
      changed.push(sha256(relative))
    }
  }
  return changed.sort()
}

async function waitForRuntimeCleanup(
  baseline: string[]
): Promise<string[]> {
  const baselineSet = new Set(baseline)
  const deadline = performance.now() + 15_000
  while (performance.now() < deadline) {
    const remaining = (await runtimeSessions()).filter(
      (entry) => !baselineSet.has(entry)
    )
    if (remaining.length === 0) return []
    await delay(100)
  }
  return (await runtimeSessions()).filter(
    (entry) => !baselineSet.has(entry)
  )
}

async function logOffset(): Promise<{ path: string; size: number }> {
  const appData = process.env.APPDATA
  const logPath = path.join(
    appData ?? path.join(os.homedir(), 'AppData', 'Roaming'),
    'EnvCAD',
    'logs',
    'main.log'
  )
  try {
    return { path: logPath, size: (await stat(logPath)).size }
  } catch {
    return { path: logPath, size: 0 }
  }
}

async function verifyLogs(
  log: { path: string; size: number },
  fixturePaths: string[],
  m01Drawing?: string
): Promise<{ path: string; scannedBytes: number; checks: string[] }> {
  let bytes = Buffer.alloc(0)
  try {
    bytes = (await readFile(log.path)).subarray(log.size)
  } catch {
    // A missing log is acceptable; it persisted none of the prohibited data.
  }
  const text = bytes.toString('utf8')
  const prohibited = [
    /data:image\/(?:png|webp);base64,/i,
    /[A-Za-z0-9+/]{2000,}={0,2}/,
    /\bsk-(?:ant|proj|svcacct)-[A-Za-z0-9_-]+\b/i,
    /\b(?:Bearer\s+)?eyJ[A-Za-z0-9._-]+\b/i
  ]
  if (prohibited.some((pattern) => pattern.test(text))) {
    throw new Error('Installed EnvCAD logs persisted image bytes or a credential pattern.')
  }
  for (const fixturePath of fixturePaths) {
    if (
      text.includes(fixturePath) ||
      text.includes(path.basename(fixturePath))
    ) {
      throw new Error('Installed EnvCAD logs persisted a visual fixture path.')
    }
  }
  if (m01Drawing) {
    const inspection = inspectDxf(await readFile(m01Drawing, 'utf8'))
    const drawingTexts = inspection.entities
      .map((entity) => entity.text?.trim())
      .filter((value): value is string => Boolean(value && value.length >= 8))
    if (drawingTexts.some((value) => text.includes(value))) {
      throw new Error('Installed EnvCAD logs persisted confidential M-01 drawing text.')
    }
  }
  return {
    path: log.path,
    scannedBytes: bytes.byteLength,
    checks: [
      'no data-image/Base64 payload',
      'no credential pattern',
      'no visual fixture path',
      ...(m01Drawing ? ['no M-01 drawing text'] : [])
    ]
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (!options.live) {
    throw new Error(
      'Real provider calls are disabled by default. Re-run with --live; these calls count against subscription usage.'
    )
  }
  const launchTarget = resolveBenchmarkLaunchTarget(options.executable)
  const providers = options.provider ? [options.provider] : PROVIDERS
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const defaultOutput = path.join(
    process.env.LOCALAPPDATA ?? os.tmpdir(),
    'EnvCAD',
    'acceptance',
    'visual',
    timestamp
  )
  const outputRoot = path.resolve(options.outputDirectory ?? defaultOutput)
  await mkdir(outputRoot, { recursive: true })
  const evidencePath = path.join(outputRoot, 'provider-boundary-evidence.jsonl')
  await rm(evidencePath, { force: true })
  const fixturePaths = Object.fromEntries(
    await Promise.all(
      (['a', 'b', 'blank', 'defect'] as const).map(async (id) => {
        const filePath = path.join(outputRoot, `x-${id}.dxf`)
        await writeFile(filePath, createVisualFixtureDxf(id), 'utf8')
        return [id, filePath]
      })
    )
  ) as Record<VisualFixtureId, string>
  const m01Drawing = options.drawing
    ? path.resolve(options.drawing)
    : undefined
  if (m01Drawing) await stat(m01Drawing)

  const log = await logOffset()
  const baselineSessions = await runtimeSessions()
  const baselineClaudeTranscripts = await claudeTranscriptSnapshot()
  const environment = cleanEnvironment(evidencePath)
  const launchExecutable = options.useAutomationDriver
    ? launchTarget.automationDriver
    : launchTarget.applicationExecutable
  const results: ProviderResult[] = []
  const ports: number[] = []
  const processIds: number[] = []
  let application: ElectronApplication | undefined
  try {
    const launched = await launchApplication(
      launchExecutable,
      launchTarget.applicationAsar,
      environment,
      options.useAutomationDriver
    )
    application = launched.application
    ports.push(launched.port)
    if (application.process().pid) processIds.push(application.process().pid!)
    await refreshProviders(launched.page)

    for (const provider of providers) {
      const configuration = await selectBestConfiguration(
        launched.page,
        provider
      )
      const markerResults = []
      for (const id of ['a', 'b'] as const) {
        markerResults.push(
          await runStructuredFixture(
            launched.page,
            provider,
            configuration,
            fixturePaths[id],
            id,
            outputRoot,
            evidencePath,
            true
          )
        )
      }
      if (
        markerResults[0].turn.response === markerResults[1].turn.response ||
        markerResults[0].turn.visualEvidence[0].rasterSha256 ===
          markerResults[1].turn.visualEvidence[0].rasterSha256
      ) {
        throw new Error(
          `${provider} did not produce distinct evidence for changed arrangements.`
        )
      }
      const result: ProviderResult = {
        configuration,
        markers: markerResults
      }
      if (options.scope === 'full') {
        result.blank = await runStructuredFixture(
          launched.page,
          provider,
          configuration,
          fixturePaths.blank,
          'blank',
          outputRoot,
          evidencePath,
          true
        )
        result.defect = await runStructuredFixture(
          launched.page,
          provider,
          configuration,
          fixturePaths.defect,
          'defect',
          outputRoot,
          evidencePath,
          false
        )
        result.m01 = await runM01(
          launched.page,
          provider,
          configuration,
          m01Drawing!,
          outputRoot,
          evidencePath
        )
      }
      results.push(result)
    }

    await application.close()
    application = undefined
    await waitForPortClosed(ports[0])
    const remainingAfterFirstClose = await waitForRuntimeCleanup(
      baselineSessions
    )
    if (remainingAfterFirstClose.length > 0) {
      throw new Error(
        `AI runtime directories remained after close: ${remainingAfterFirstClose.join(
          ', '
        )}`
      )
    }

    const relaunched = await launchApplication(
      launchExecutable,
      launchTarget.applicationAsar,
      environment,
      options.useAutomationDriver
    )
    application = relaunched.application
    ports.push(relaunched.port)
    if (application.process().pid) processIds.push(application.process().pid!)
    await openDrawing(relaunched.page, fixturePaths.a)
    const relaunchPreview = await capturePreview(
      relaunched.page,
      outputRoot,
      'relaunch-a'
    )
    await application.close()
    application = undefined
    await waitForPortClosed(ports[1])
    const remainingAfterRelaunch = await waitForRuntimeCleanup(
      baselineSessions
    )
    if (remainingAfterRelaunch.length > 0) {
      throw new Error(
        `AI runtime directories remained after relaunch: ${remainingAfterRelaunch.join(
          ', '
        )}`
      )
    }

    const rawEvidence = await readFile(evidencePath, 'utf8')
    if (
      /data:image\/|[A-Za-z0-9+/]{2000,}={0,2}/.test(rawEvidence) ||
      rawEvidence.includes('privateDrawingText')
    ) {
      throw new Error('Provider-boundary evidence persisted image bytes or drawing content.')
    }
    const logVerification = await verifyLogs(
      log,
      Object.values(fixturePaths),
      m01Drawing
    )
    const finalClaudeTranscripts = await claudeTranscriptSnapshot()
    const changedClaudeTranscripts = changedClaudeTranscriptFiles(
      baselineClaudeTranscripts,
      finalClaudeTranscripts
    )
    if (
      finalClaudeTranscripts.directories !== 0 ||
      changedClaudeTranscripts.length > 0
    ) {
      throw new Error(
        'Claude persisted a new or modified EnvCAD runtime transcript.'
      )
    }
    const report = {
      schemaVersion: 1,
      status: 'passed',
      generatedAt: new Date().toISOString(),
      scope: options.scope,
      launch: {
        requestedExecutable: launchTarget.requestedExecutable,
        applicationExecutable: launchTarget.applicationExecutable,
        applicationAsar: launchTarget.applicationAsar,
        automationExecutable: launchExecutable,
        usedInstalledExecutableDirectly: !options.useAutomationDriver,
        applicationProcessIds: processIds
      },
      providers: results,
      evidencePath,
      fixtures: fixturePaths,
      m01Drawing,
      sidecarPorts: ports,
      sidecarPortsClosed: true,
      runtimeCleanup: {
        baselineSessions,
        remainingNewSessions: []
      },
      claudeTranscriptPrivacy: {
        baselineDirectories: baselineClaudeTranscripts.directories,
        baselineFiles: baselineClaudeTranscripts.files,
        baselineBytes: baselineClaudeTranscripts.bytes,
        removedLegacyDirectories: baselineClaudeTranscripts.directories,
        finalDirectories: finalClaudeTranscripts.directories,
        finalFiles: finalClaudeTranscripts.files,
        finalBytes: finalClaudeTranscripts.bytes,
        newOrModifiedFileIds: changedClaudeTranscripts,
        passed: true
      },
      logVerification,
      relaunchPreview
    }
    const reportPath = path.join(
      outputRoot,
      'installed-visual-acceptance.json'
    )
    await writeJsonAtomic(reportPath, report)
    console.log(
      JSON.stringify({
        status: 'passed',
        outputRoot,
        reportPath,
        launch: report.launch,
        providers: results.map((result) => ({
          ...result.configuration,
          turns: [
            ...result.markers.map((entry) => ({
              fixture: entry.expected?.id,
              resolvedModel: entry.turn.resolvedModel,
              firstToolCallMs: Math.round(entry.turn.firstToolCallMs),
              totalMs: Math.round(entry.turn.totalMs),
              rasterSha256:
                entry.turn.visualEvidence[0].rasterSha256
            })),
            ...(result.blank
              ? [
                  {
                    fixture: 'blank',
                    resolvedModel: result.blank.turn.resolvedModel,
                    totalMs: Math.round(result.blank.turn.totalMs)
                  }
                ]
              : []),
            ...(result.defect
              ? [
                  {
                    fixture: 'defect',
                    resolvedModel: result.defect.turn.resolvedModel,
                    totalMs: Math.round(result.defect.turn.totalMs)
                  }
                ]
              : []),
            ...(result.m01
              ? [
                  {
                    fixture: 'm01',
                    resolvedModel: result.m01.turn.resolvedModel,
                    totalMs: Math.round(result.m01.turn.totalMs)
                  }
                ]
              : [])
          ]
        })),
        sidecarPorts: ports,
        sidecarPortsClosed: true,
        evidencePath
      })
    )
  } finally {
    if (application) await application.close().catch(() => {})
  }
}

await main()
