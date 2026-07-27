import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, readdirSync } from 'node:fs'
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import type { AgentConfiguration, ProviderId } from '../src/agent/protocol'

const TASK_A =
  'Create a layer named AI_BENCHMARK with color #00a86b. On that layer, draw a ' +
  'closed axis-aligned rectangle from corner (0, 0) to corner (20, 10). Calculate ' +
  'its exact area using the CAD measurement tool, zoom to extents, and report the ' +
  'entity ID, dimensions, area, and units. Do not create anything else.'
export const TASK_B =
  'On AI_BENCHMARK, draw a circle centered at (30, 10) with radius 5 m. Add a ' +
  'radius dimension using the actual circle entity, then place the text AI BENCHMARK ' +
  'at (30, 17) with text height 1 m. Report every created entity ID and the exact ' +
  'radius. Do not modify the rectangle.'
const SMOKE_PROMPT =
  'Call get_drawing_context exactly once and report the drawing units. Do not create or modify anything.'
const MAX_NEW_LIVE_TURNS = 16
const TURN_TIMEOUT_MS = 180_000
const PROVIDERS: ProviderId[] = ['claude-code', 'openai-codex']
let downloadSequence = 0

interface CliOptions {
  live: boolean
  executable?: string
  outputDirectory?: string
  resumeDirectory?: string
}

export interface BenchmarkLaunchTarget {
  requestedExecutable: string
  applicationExecutable: string
  applicationAsar: string
  automationDriver: string
}

interface EffortCatalog {
  value: string
  displayName: string
  description: string
  isDefault: boolean
}

export interface ModelCatalog {
  id: string
  invocationName: string
  resolvedModel?: string
  displayName: string
  description: string
  defaultEffort?: string
  isDefault: boolean
  efforts: EffortCatalog[]
}

export interface ProviderCatalog {
  id: ProviderId
  displayName: string
  version?: string
  discoveryMs?: number
  models: ModelCatalog[]
}

interface ToolCall {
  name: string
  input: unknown
  result: { data?: unknown; error?: string }
}

interface TurnEvidence {
  prompt: string
  assistantText: string
  tools: ToolCall[]
  wallClockMs?: number
  evidenceMode?:
    | 'live'
    | 'recovered-from-live-screenshot'
    | 'recovered-from-live-error'
  failure?: string
  metrics: {
    providerReadyMs?: number
    conversationStartupMs?: number
    firstTextMs?: number
    firstToolCallMs?: number
    totalMs: number
    toolCalls: number
    retries: number
    inputTokens?: number
    outputTokens?: number
  }
}

interface DxfPair {
  code: number
  value: string
}

interface DxfEntity {
  type: string
  handle?: string
  layer: string
  points?: Array<{ x: number; y: number }>
  closed?: boolean
  center?: { x: number; y: number }
  radius?: number
  position?: { x: number; y: number }
  height?: number
  text?: string
  blockName?: string
}

interface DxfInspection {
  acadVersion?: string
  unitsCode?: number
  layers: Array<{ name: string; trueColor?: number; colorIndex?: number }>
  entities: DxfEntity[]
}

interface BenchmarkConfiguration {
  label: string
  provider: ProviderId
  model: ModelCatalog
  effort?: string
}

interface ConfigurationResult {
  configuration: AgentConfiguration
  label: string
  score: number
  totalMs: number
  slow: boolean
  issues: string[]
  taskA: TurnEvidence
  taskB: TurnEvidence
  files: {
    taskA: string
    taskAReopened: string
    taskB: string
    taskBReopened: string
    taskAScreenshot: string
    taskBScreenshot: string
  }
}

interface TaskAStage {
  schemaVersion: 1
  label: string
  configuration: AgentConfiguration
  taskA: TurnEvidence
  files: {
    taskA: string
    taskAReopened: string
    taskAScreenshot: string
  }
  recoveryNote?: string
}

interface BenchmarkProgress {
  schemaVersion: 1
  turnsUsed: number
  warmups: Array<{
    provider: ProviderId
    configuration: AgentConfiguration
    result: TurnEvidence
  }>
  smoke: Array<{
    label: string
    configuration: AgentConfiguration
    result: TurnEvidence
  }>
  results: ConfigurationResult[]
  recovery?: {
    sourceRun: string
    priorExcludedTurnsCompleted: number
    note: string
    artifactRecovery?: {
      installedAsarSha256: string
      recoveredConfigurations: string[]
      note: string
    }
    failedTurns?: Array<{
      turn: number
      label: string
      task: 'A' | 'B'
      error: string
      retried: false
    }>
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
    } else if (argument === '--resume') {
      options.resumeDirectory = argv[++index]
    } else if (argument.startsWith('--resume=')) {
      options.resumeDirectory = argument.slice('--resume='.length)
    } else {
      throw new Error(`Unknown benchmark argument: ${argument}`)
    }
  }
  if (options.outputDirectory && options.resumeDirectory) {
    throw new Error('--output and --resume cannot be used together.')
  }
  return options
}

function compareSquirrelAppDirectories(left: string, right: string): number {
  const parse = (value: string) =>
    /^app-(\d+)\.(\d+)\.(\d+)(?:[.-](.*))?$/i.exec(value)
  const leftVersion = parse(left)
  const rightVersion = parse(right)
  if (!leftVersion || !rightVersion) return right.localeCompare(left)
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(rightVersion[index]) - Number(leftVersion[index])
    if (difference !== 0) return difference
  }
  const leftSuffix = leftVersion[4] ?? ''
  const rightSuffix = rightVersion[4] ?? ''
  if (!leftSuffix && rightSuffix) return -1
  if (leftSuffix && !rightSuffix) return 1
  return rightSuffix.localeCompare(leftSuffix)
}

function resolveApplicationAsar(executable: string): {
  applicationExecutable: string
  applicationAsar: string
} {
  const executableDirectory = path.dirname(executable)
  const adjacentAsar = path.join(executableDirectory, 'resources', 'app.asar')
  if (existsSync(adjacentAsar)) {
    return {
      applicationExecutable: executable,
      applicationAsar: adjacentAsar
    }
  }

  let appDirectories: string[] = []
  try {
    appDirectories = readdirSync(executableDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^app-\d+\.\d+\.\d+/i.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareSquirrelAppDirectories)
  } catch {
    // The explicit error below includes the resolved executable for diagnosis.
  }
  for (const appDirectory of appDirectories) {
    const applicationDirectory = path.join(executableDirectory, appDirectory)
    const applicationAsar = path.join(applicationDirectory, 'resources', 'app.asar')
    const applicationExecutable = path.join(applicationDirectory, 'EnvCAD.exe')
    if (existsSync(applicationAsar) && existsSync(applicationExecutable)) {
      return { applicationExecutable, applicationAsar }
    }
  }
  throw new Error(
    `EnvCAD application resources were not found beside ${executable}. Reinstall EnvCAD or pass the versioned application executable.`
  )
}

export function resolveBenchmarkLaunchTarget(
  explicit: string | undefined
): BenchmarkLaunchTarget {
  if (explicit && !existsSync(explicit)) {
    throw new Error(`The requested EnvCAD executable does not exist: ${path.resolve(explicit)}`)
  }
  const candidates = [
    explicit,
    process.env.ENVCAD_BENCHMARK_EXECUTABLE,
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'EnvCAD', 'EnvCAD.exe')
      : undefined,
    path.join(process.cwd(), 'out', 'EnvCAD-win32-x64', 'EnvCAD.exe')
  ].filter((candidate): candidate is string => Boolean(candidate))
  const executable = candidates.find((candidate) => existsSync(candidate))
  if (!executable) {
    throw new Error(
      'Installed EnvCAD was not found. Install v0.2.0 or pass --executable <EnvCAD.exe>.'
    )
  }
  const requestedExecutable = path.resolve(executable)
  const automationDriver = path.join(
    process.cwd(),
    'node_modules',
    'electron',
    'dist',
    'electron.exe'
  )
  if (!existsSync(automationDriver)) {
    throw new Error(
      'The Electron automation driver is missing. Run npm ci before the live benchmark.'
    )
  }
  return {
    requestedExecutable,
    ...resolveApplicationAsar(requestedExecutable),
    automationDriver
  }
}

function cleanEnvironment(): Record<string, string> {
  const blocked = new Set(
    [
      'OPENAI_API_KEY',
      'CODEX_API_KEY',
      'CODEX_ACCESS_TOKEN',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN'
    ].map((name) => name.toLowerCase())
  )
  return Object.fromEntries(
    Object.entries(process.env)
      .filter(
        ([name, value]) => value !== undefined && !blocked.has(name.toLowerCase())
      )
      .map(([name, value]) => [name, value!])
  )
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

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T
}

function sameConfiguration(
  left: AgentConfiguration,
  right: AgentConfiguration
): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.effort === right.effort
  )
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

async function loadProgress(outputRoot: string): Promise<BenchmarkProgress> {
  const progressPath = path.join(outputRoot, 'benchmark-progress.json')
  const progress = await readJson<BenchmarkProgress>(progressPath)
  if (
    progress.schemaVersion !== 1 ||
    !Number.isInteger(progress.turnsUsed) ||
    progress.turnsUsed < 0 ||
    progress.turnsUsed > MAX_NEW_LIVE_TURNS ||
    !Array.isArray(progress.warmups) ||
    !Array.isArray(progress.smoke) ||
    !Array.isArray(progress.results)
  ) {
    throw new Error(`Benchmark progress is invalid: ${progressPath}`)
  }
  return progress
}

async function loadTaskAStage(
  outputRoot: string,
  entry: BenchmarkConfiguration
): Promise<TaskAStage | undefined> {
  const directory = path.join(
    outputRoot,
    entry.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  )
  const stagePath = path.join(directory, 'task-a-stage.json')
  if (!existsSync(stagePath)) return undefined
  const stage = await readJson<TaskAStage>(stagePath)
  const expectedConfiguration = configurationValue(entry)
  if (
    stage.schemaVersion !== 1 ||
    stage.label !== entry.label ||
    !sameConfiguration(stage.configuration, expectedConfiguration) ||
    !stage.taskA ||
    !stage.files ||
    ![stage.files.taskA, stage.files.taskAReopened, stage.files.taskAScreenshot].every(
      (candidate) =>
        typeof candidate === 'string' &&
        pathInside(outputRoot, path.resolve(candidate)) &&
        existsSync(candidate)
    )
  ) {
    throw new Error(`Task A resume stage is invalid: ${stagePath}`)
  }
  return stage
}

function dxfPairs(text: string): DxfPair[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const pairs: DxfPair[] = []
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = Number(lines[index].trim())
    if (!Number.isInteger(code)) throw new Error(`Invalid DXF group code at line ${index + 1}`)
    pairs.push({ code, value: lines[index + 1].trimEnd() })
  }
  return pairs
}

export function cleanBenchmarkDxf(source: string): string {
  const pairs = dxfPairs(source)
  const output: DxfPair[] = []
  let section = ''
  let skipEntities = false
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index]
    if (
      pair.code === 0 &&
      pair.value === 'SECTION' &&
      pairs[index + 1]?.code === 2
    ) {
      section = pairs[index + 1].value
      skipEntities = section === 'ENTITIES'
      output.push(pair, pairs[index + 1])
      index += 1
      continue
    }
    if (skipEntities && !(pair.code === 0 && pair.value === 'ENDSEC')) continue
    output.push(pair)
    if (pair.code === 0 && pair.value === 'ENDSEC') {
      section = ''
      skipEntities = false
    }
  }
  setHeaderVariable(output, '$ACADVER', 1, 'AC1018')
  setHeaderVariable(output, '$INSUNITS', 70, '6')
  return `${output.flatMap((pair) => [String(pair.code), pair.value]).join('\r\n')}\r\n`
}

function setHeaderVariable(
  pairs: DxfPair[],
  name: string,
  valueCode: number,
  value: string
): void {
  const header = sectionPairs(pairs, 'HEADER')
  const marker = header.findIndex(
    (pair) => pair.code === 9 && pair.value === name
  )
  if (marker < 0) throw new Error(`Benchmark fixture is missing ${name}.`)
  const nextMarker = header.findIndex(
    (pair, index) => index > marker && pair.code === 9
  )
  const candidate = header
    .slice(marker + 1, nextMarker < 0 ? header.length : nextMarker)
    .find((pair) => pair.code === valueCode)
  if (!candidate) {
    throw new Error(`Benchmark fixture has no group ${valueCode} value for ${name}.`)
  }
  candidate.value = value
}

function sectionPairs(pairs: DxfPair[], name: string): DxfPair[] {
  for (let index = 0; index < pairs.length - 1; index += 1) {
    if (
      pairs[index].code === 0 &&
      pairs[index].value === 'SECTION' &&
      pairs[index + 1].code === 2 &&
      pairs[index + 1].value === name
    ) {
      const start = index + 2
      const end = pairs.findIndex(
        (pair, candidate) =>
          candidate >= start && pair.code === 0 && pair.value === 'ENDSEC'
      )
      return pairs.slice(start, end < 0 ? pairs.length : end)
    }
  }
  return []
}

function records(pairs: DxfPair[], type?: string): DxfPair[][] {
  const output: DxfPair[][] = []
  let current: DxfPair[] = []
  for (const pair of pairs) {
    if (pair.code === 0) {
      if (current.length > 0) output.push(current)
      current = [pair]
    } else if (current.length > 0) {
      current.push(pair)
    }
  }
  if (current.length > 0) output.push(current)
  return type
    ? output.filter((record) => record[0]?.value === type)
    : output
}

function first(record: DxfPair[], code: number): string | undefined {
  return record.find((pair) => pair.code === code)?.value
}

function numberValue(record: DxfPair[], code: number): number | undefined {
  const value = first(record, code)
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function pointValue(record: DxfPair[], xCode: number, yCode: number) {
  const x = numberValue(record, xCode)
  const y = numberValue(record, yCode)
  return x === undefined || y === undefined ? undefined : { x, y }
}

function polylinePoints(record: DxfPair[]): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = []
  for (let index = 0; index < record.length; index += 1) {
    if (record[index].code !== 10) continue
    const x = Number(record[index].value)
    const yPair = record.slice(index + 1).find((pair) => pair.code === 20)
    const y = yPair ? Number(yPair.value) : Number.NaN
    if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y })
  }
  return points
}

export function inspectDxf(text: string): DxfInspection {
  const pairs = dxfPairs(text)
  const header = sectionPairs(pairs, 'HEADER')
  const versionMarker = header.findIndex(
    (pair) => pair.code === 9 && pair.value === '$ACADVER'
  )
  const acadVersion =
    versionMarker < 0
      ? undefined
      : header.slice(versionMarker + 1).find((pair) => pair.code === 1)?.value
  const unitsMarker = header.findIndex(
    (pair) => pair.code === 9 && pair.value === '$INSUNITS'
  )
  const unitsCode =
    unitsMarker < 0
      ? undefined
      : Number(
          header.slice(unitsMarker + 1).find((pair) => pair.code === 70)?.value
        )
  const layerRecords = records(sectionPairs(pairs, 'TABLES'), 'LAYER')
  const layers = layerRecords.map((record) => ({
    name: first(record, 2) ?? '',
    ...(numberValue(record, 420) !== undefined
      ? { trueColor: numberValue(record, 420) }
      : {}),
    ...(numberValue(record, 62) !== undefined
      ? { colorIndex: numberValue(record, 62) }
      : {})
  }))
  const entities = records(sectionPairs(pairs, 'ENTITIES'))
    .filter((record) => !['SECTION', 'ENDSEC'].includes(record[0]?.value))
    .map((record): DxfEntity => {
      const type = record[0]?.value ?? ''
      const entity: DxfEntity = {
        type,
        handle: first(record, 5),
        layer: first(record, 8) ?? '0'
      }
      if (type === 'LWPOLYLINE') {
        entity.points = polylinePoints(record)
        entity.closed = ((numberValue(record, 70) ?? 0) & 1) === 1
      } else if (type === 'CIRCLE') {
        entity.center = pointValue(record, 10, 20)
        entity.radius = numberValue(record, 40)
      } else if (type === 'TEXT' || type === 'MTEXT') {
        entity.position = pointValue(record, 10, 20)
        entity.height = numberValue(record, 40)
        entity.text = first(record, 1)
      } else if (type === 'INSERT') {
        entity.position = pointValue(record, 10, 20)
        entity.blockName = first(record, 2)
      }
      return entity
    })
  return { acadVersion, unitsCode, layers, entities }
}

function closeNumber(left: number | undefined, right: number, tolerance = 1e-8): boolean {
  return left !== undefined && Math.abs(left - right) <= tolerance
}

function rectangleEntity(inspection: DxfInspection): DxfEntity | undefined {
  return inspection.entities.find((entity) => {
    if (entity.type !== 'LWPOLYLINE' || !entity.closed || entity.points?.length !== 4) {
      return false
    }
    const xs = [...new Set(entity.points.map((point) => point.x))].sort((a, b) => a - b)
    const ys = [...new Set(entity.points.map((point) => point.y))].sort((a, b) => a - b)
    return (
      xs.length === 2 &&
      ys.length === 2 &&
      closeNumber(xs[0], 0) &&
      closeNumber(xs[1], 20) &&
      closeNumber(ys[0], 0) &&
      closeNumber(ys[1], 10)
    )
  })
}

export function geometryFingerprint(inspection: DxfInspection): string {
  return JSON.stringify(
    inspection.entities
      .map(({ handle: _handle, ...entity }) => entity)
      .sort((left, right) =>
        `${left.type}:${left.layer}:${left.text ?? ''}`.localeCompare(
          `${right.type}:${right.layer}:${right.text ?? ''}`
        )
      )
  )
}

function numberAttribute(value: string | null): number | undefined {
  if (value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

async function readCatalog(page: Page): Promise<ProviderCatalog[]> {
  const output: ProviderCatalog[] = []
  for (const id of PROVIDERS) {
    await selectProvider(page, id)
    const providerOption = page.locator(`select[aria-label="AI provider"] option[value="${id}"]`)
    const displayName = (await providerOption.textContent())?.trim() ?? id
    const version = (await providerOption.getAttribute('data-version')) || undefined
    const discoveryMs = numberAttribute(
      await providerOption.getAttribute('data-discovery-ms')
    )
    const models: ModelCatalog[] = []
    const modelOptions = page.locator('select[aria-label="AI model"] option')
    const count = await modelOptions.count()
    for (let index = 0; index < count; index += 1) {
      const option = modelOptions.nth(index)
      const modelId = await option.getAttribute('value')
      if (!modelId) continue
      await page.getByLabel('AI model').selectOption(modelId)
      await waitForConfiguration(page)
      const efforts = await page
        .locator('select[aria-label="Reasoning effort"] option:not([value=""])')
        .evaluateAll((options) =>
          options.map((option) => {
            const element = option as HTMLOptionElement
            return {
              value: element.value,
              displayName: element.textContent?.replace(' · Recommended', '').trim() ?? element.value,
              description: element.title,
              isDefault: element.dataset.isDefault === 'true'
            }
          })
        )
      models.push({
        id: modelId,
        invocationName:
          (await option.getAttribute('data-invocation-name')) ?? modelId,
        resolvedModel:
          (await option.getAttribute('data-resolved-model')) || undefined,
        displayName:
          (await option.textContent())?.replace(' · Recommended', '').trim() ??
          modelId,
        description: (await option.getAttribute('title')) ?? '',
        defaultEffort:
          (await option.getAttribute('data-default-effort')) || undefined,
        isDefault: (await option.getAttribute('data-is-default')) === 'true',
        efforts
      })
    }
    output.push({ id, displayName, version, discoveryMs, models })
  }
  return output
}

async function selectProvider(page: Page, provider: ProviderId): Promise<void> {
  const select = page.getByLabel('AI provider', { exact: true })
  if ((await select.inputValue()) !== provider) await select.selectOption(provider)
  await page.waitForFunction(
    () => document.querySelector('.readiness-badge')?.textContent?.trim() !== 'checking',
    undefined,
    { timeout: 60_000 }
  )
  const status = (await page.locator('.readiness-badge').textContent())?.trim()
  if (status !== 'ready') {
    const message = (await page.locator('.provider-message').textContent())?.trim()
    throw new Error(`${provider} is ${status ?? 'unavailable'}: ${message ?? 'no status detail'}`)
  }
  await waitForConfiguration(page)
}

async function waitForConfiguration(page: Page): Promise<void> {
  await page.locator('.chat-textarea').waitFor({ state: 'visible', timeout: 60_000 })
  await page.waitForFunction(
    () => !(document.querySelector('.chat-textarea') as HTMLTextAreaElement | null)?.disabled,
    undefined,
    { timeout: 60_000 }
  )
}

async function selectConfiguration(
  page: Page,
  configuration: BenchmarkConfiguration
): Promise<void> {
  await selectProvider(page, configuration.provider)
  const modelSelect = page.getByLabel('AI model')
  if ((await modelSelect.inputValue()) !== configuration.model.id) {
    await modelSelect.selectOption(configuration.model.id)
    await waitForConfiguration(page)
  }
  const effortSelect = page.getByLabel('Reasoning effort')
  const effort = configuration.effort ?? ''
  if ((await effortSelect.inputValue()) !== effort) {
    await effortSelect.selectOption(effort)
    await waitForConfiguration(page)
  }
}

async function resetConversation(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: 'New chat', exact: true })
  await button.waitFor({ state: 'visible' })
  await page.waitForFunction(
    () => !(document.querySelector('.new-chat-btn') as HTMLButtonElement | null)?.disabled
  )
  page.once('dialog', (dialog) => void dialog.accept())
  await button.click()
  await page.locator('.empty-state').waitFor({ state: 'visible' })
  await waitForConfiguration(page)
}

async function openDrawing(page: Page, filePath: string): Promise<void> {
  await page.locator('input[accept=".dxf,.dwg"]').setInputFiles(filePath)
  await page.getByRole('button', { name: 'Save DXF' }).waitFor({ state: 'visible' })
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
}

async function saveDrawing(
  application: ElectronApplication,
  page: Page,
  destination: string
): Promise<void> {
  await rm(destination, { force: true })
  const token = `envcad-benchmark-${process.pid}-${++downloadSequence}`
  await application.evaluate(
    ({ session }, value) => {
      const root = globalThis as typeof globalThis & {
        __envcadBenchmarkDownloads?: Record<string, string>
      }
      const statuses =
        root.__envcadBenchmarkDownloads ??
        (root.__envcadBenchmarkDownloads = {})
      statuses[value.token] = 'waiting'
      session.defaultSession.once('will-download', (_event, item) => {
        item.setSavePath(value.filePath)
        item.once('done', (_doneEvent, state) => {
          statuses[value.token] = state
        })
      })
    },
    { filePath: destination, token }
  )
  await page.getByRole('button', { name: 'Save DXF' }).click()
  const deadline = performance.now() + 30_000
  try {
    while (performance.now() < deadline) {
      const state = await application.evaluate(
        (_electron, statusToken) =>
          (
            globalThis as typeof globalThis & {
              __envcadBenchmarkDownloads?: Record<string, string>
            }
          ).__envcadBenchmarkDownloads?.[statusToken] ?? 'missing',
        token
      )
      if (state === 'completed') {
        if ((await stat(destination)).size < 100) {
          throw new Error(`DXF output is too small: ${destination}`)
        }
        return
      }
      if (state === 'cancelled' || state === 'interrupted') {
        throw new Error(`Electron DXF download ended in state "${state}".`)
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  } finally {
    await application
      .evaluate(
        (_electron, statusToken) => {
          const root = globalThis as typeof globalThis & {
            __envcadBenchmarkDownloads?: Record<string, string>
          }
          if (root.__envcadBenchmarkDownloads) {
            delete root.__envcadBenchmarkDownloads[statusToken]
          }
        },
        token
      )
      .catch((error) => {
        console.warn(
          `Benchmark download-hook cleanup failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      })
  }
  throw new Error(`Electron did not finish saving DXF output: ${destination}`)
}

async function runTurn(
  page: Page,
  prompt: string,
  turnBudget: { used: number },
  onTurnStarted?: (turnsUsed: number) => Promise<void>
): Promise<TurnEvidence> {
  if (turnBudget.used >= MAX_NEW_LIVE_TURNS) {
    throw new Error(`Live benchmark turn budget exhausted at ${turnBudget.used}.`)
  }
  await resetConversation(page)
  turnBudget.used += 1
  await onTurnStarted?.(turnBudget.used)
  const startedAt = performance.now()
  await page.locator('.chat-textarea').fill(prompt)
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
  const errors = await page.locator('.bubble.error').allTextContents()
  const toolLocators = page.locator('.tool-chip')
  const tools: ToolCall[] = []
  for (let index = 0; index < (await toolLocators.count()); index += 1) {
    const chip = toolLocators.nth(index)
    const classes = (await chip.getAttribute('class')) ?? ''
    const completed = classes.split(/\s+/).includes('ok')
    const name = (await chip.locator('.tool-name').textContent())?.trim() ?? ''
    await chip.locator('.chip-header').click()
    const details = await chip.locator('.tool-details pre').allTextContents()
    if (details.length !== 2 && completed) {
      throw new Error('Tool evidence is incomplete.')
    }
    tools.push({
      name,
      input: details[0] ? (JSON.parse(details[0]) as unknown) : {},
      result: details[1]
        ? (JSON.parse(details[1]) as ToolCall['result'])
        : {
            error:
              (await chip.textContent())?.trim() ??
              `${name || 'CAD tool'} did not complete successfully.`
          }
    })
  }
  const metrics = page.locator('.turn-metrics').last()
  const totalMs = numberAttribute(await metrics.getAttribute('data-total-ms'))
  const toolCalls = numberAttribute(await metrics.getAttribute('data-tool-calls'))
  if (totalMs === undefined || toolCalls === undefined) {
    throw new Error('Turn metrics were not attached to the response.')
  }
  if (toolCalls !== tools.length) {
    throw new Error(`Metrics reported ${toolCalls} tool calls but the timeline contains ${tools.length}.`)
  }
  const failures = [
    ...errors,
    ...tools.flatMap((call) => (call.result.error ? [call.result.error] : []))
  ]
  return {
    prompt,
    assistantText: (
      await page.locator('.bubble.assistant .bubble-text').allTextContents()
    ).join('\n'),
    tools,
    ...(failures.length > 0
      ? { failure: `Provider turn failed: ${failures.join(' | ')}` }
      : {}),
    wallClockMs: performance.now() - startedAt,
    metrics: {
      providerReadyMs: numberAttribute(await metrics.getAttribute('data-provider-ready-ms')),
      conversationStartupMs: numberAttribute(
        await metrics.getAttribute('data-conversation-startup-ms')
      ),
      firstTextMs: numberAttribute(await metrics.getAttribute('data-first-text-ms')),
      firstToolCallMs: numberAttribute(
        await metrics.getAttribute('data-first-tool-call-ms')
      ),
      totalMs,
      toolCalls,
      retries: numberAttribute(await metrics.getAttribute('data-retries')) ?? 0,
      inputTokens: numberAttribute(await metrics.getAttribute('data-input-tokens')),
      outputTokens: numberAttribute(await metrics.getAttribute('data-output-tokens'))
    }
  }
}

function tool(turn: TurnEvidence, name: string): ToolCall | undefined {
  return turn.tools.find((candidate) => candidate.name === name)
}

function dataRecord(call: ToolCall | undefined): Record<string, unknown> | undefined {
  const value = call?.result.data
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function createdId(call: ToolCall | undefined): string | undefined {
  const ids = dataRecord(call)?.entityIds
  return Array.isArray(ids) && typeof ids[0] === 'string' ? ids[0] : undefined
}

function includesId(text: string, id: string | undefined): boolean {
  return Boolean(id && text.toLowerCase().includes(id.toLowerCase()))
}

function trueColorIsBenchmark(layer: DxfInspection['layers'][number] | undefined): boolean {
  return layer?.trueColor !== undefined && (layer.trueColor & 0xffffff) === 0x00a86b
}

export function validateConfiguration(
  taskA: TurnEvidence,
  taskB: TurnEvidence,
  taskASaved: DxfInspection,
  taskAReopened: DxfInspection,
  taskBSaved: DxfInspection,
  taskBReopened: DxfInspection
): { score: number; issues: string[] } {
  const issues: string[] = []
  const rectangle = rectangleEntity(taskASaved)
  const rectangleAfter = rectangleEntity(taskBSaved)
  const circle = taskBSaved.entities.find(
    (entity) =>
      entity.type === 'CIRCLE' &&
      closeNumber(entity.center?.x, 30) &&
      closeNumber(entity.center?.y, 10) &&
      closeNumber(entity.radius, 5)
  )
  const annotation = taskBSaved.entities.find(
    (entity) =>
      (entity.type === 'TEXT' || entity.type === 'MTEXT') &&
      entity.text === 'AI BENCHMARK' &&
      closeNumber(entity.position?.x, 30) &&
      closeNumber(entity.position?.y, 17) &&
      closeNumber(entity.height, 1)
  )
  const dimension = taskBSaved.entities.find((entity) => entity.type === 'INSERT')
  const geometryOk = Boolean(
    rectangle &&
      rectangleAfter &&
      circle &&
      annotation &&
      dimension &&
      geometryFingerprint({ ...taskASaved, entities: [rectangle] }) ===
        geometryFingerprint({ ...taskBSaved, entities: [rectangleAfter] })
  )
  if (!geometryOk) issues.push('Geometry or dimensions differ from the deterministic specification.')

  const benchmarkLayerA = taskASaved.layers.find((layer) => layer.name === 'AI_BENCHMARK')
  const benchmarkLayerB = taskBSaved.layers.find((layer) => layer.name === 'AI_BENCHMARK')
  const layersOk =
    trueColorIsBenchmark(benchmarkLayerA) &&
    trueColorIsBenchmark(benchmarkLayerB) &&
    taskBSaved.entities.every((entity) => entity.layer === 'AI_BENCHMARK')
  if (!layersOk) issues.push('Benchmark layer name, color, or entity layer assignment is incorrect.')

  const expectedA = ['create_layer', 'draw_rectangle', 'calculate_area', 'zoom_extents']
  const expectedB = ['draw_circle', 'add_radius_dimension', 'draw_text']
  const circleId = createdId(tool(taskB, 'draw_circle'))
  const dimensionInput = tool(taskB, 'add_radius_dimension')?.input as
    | Record<string, unknown>
    | undefined
  const toolsOk =
    expectedA.every((name) => Boolean(tool(taskA, name))) &&
    expectedB.every((name) => Boolean(tool(taskB, name))) &&
    dimensionInput?.circleEntityId === circleId &&
    dimensionInput?.layer === 'AI_BENCHMARK'
  if (!toolsOk) issues.push('Required CAD tools or actual-circle dimension linkage is missing.')

  const noUnrequestedEdits =
    taskASaved.entities.length === 1 &&
    taskBSaved.entities.length === 4 &&
    taskBSaved.entities.filter((entity) => entity.type === 'CIRCLE').length === 1 &&
    taskBSaved.entities.filter((entity) => entity.type === 'INSERT').length === 1
  if (!noUnrequestedEdits) issues.push('The provider created unrequested model-space entities.')

  const area = dataRecord(tool(taskA, 'calculate_area'))
  const units = String(area?.units ?? '').toLowerCase()
  const measurementsOk =
    closeNumber(
      typeof area?.totalArea === 'number' ? area.totalArea : undefined,
      200
    ) &&
    units.includes('meter') &&
    units.includes('²') &&
    dataRecord(tool(taskB, 'add_radius_dimension'))?.measurement === 5
  if (!measurementsOk) issues.push('Area, radius, or units were not measured and reported exactly.')

  const ids = [
    createdId(tool(taskA, 'draw_rectangle')),
    circleId,
    createdId(tool(taskB, 'add_radius_dimension')),
    createdId(tool(taskB, 'draw_text'))
  ]
  const idsOk =
    ids.every(Boolean) &&
    includesId(taskA.assistantText, ids[0]) &&
    ids.slice(1).every((id) => includesId(taskB.assistantText, id)) &&
    ids.every((id) =>
      [...taskASaved.entities, ...taskBSaved.entities].some(
        (entity) => entity.handle?.toLowerCase() === id?.toLowerCase()
      )
    )
  if (!idsOk) issues.push('Created entity IDs were not preserved and accurately reported.')

  const reopenOk =
    taskASaved.acadVersion === 'AC1018' &&
    taskBSaved.acadVersion === 'AC1018' &&
    taskASaved.unitsCode === 6 &&
    taskBSaved.unitsCode === 6 &&
    geometryFingerprint(taskASaved) === geometryFingerprint(taskAReopened) &&
    geometryFingerprint(taskBSaved) === geometryFingerprint(taskBReopened)
  if (!reopenOk) issues.push('DXF save/reopen changed geometry or metre units.')

  const cleanCompletion =
    [...taskA.tools, ...taskB.tools].every((call) => !call.result.error) &&
    !taskA.failure &&
    !taskB.failure &&
    taskA.metrics.retries === 0 &&
    taskB.metrics.retries === 0
  if (!cleanCompletion) issues.push('The workflow contained a tool failure, retry, or runtime error.')

  const score =
    (geometryOk ? 30 : 0) +
    (layersOk ? 15 : 0) +
    (toolsOk ? 15 : 0) +
    (noUnrequestedEdits ? 10 : 0) +
    (measurementsOk ? 10 : 0) +
    (idsOk ? 10 : 0) +
    (reopenOk ? 5 : 0) +
    (cleanCompletion ? 5 : 0)
  return { score, issues }
}

export function chooseModel(
  provider: ProviderCatalog,
  role: 'default' | 'fast' | 'balanced' | 'quality'
): ModelCatalog {
  const byPattern = (patterns: RegExp[]) => {
    for (const pattern of patterns) {
      const model = provider.models.find((candidate) =>
        pattern.test(
          `${candidate.id} ${candidate.invocationName} ${candidate.displayName}`
        )
      )
      if (model) return model
    }
    return undefined
  }
  const defaultModel =
    provider.models.find((model) => model.isDefault) ?? provider.models[0]
  if (!defaultModel) throw new Error(`${provider.displayName} returned no visible models.`)
  if (role === 'default') return defaultModel
  if (provider.id === 'claude-code') {
    if (role === 'fast') return byPattern([/haiku/i]) ?? provider.models.at(-1) ?? defaultModel
    if (role === 'balanced') return byPattern([/sonnet/i]) ?? defaultModel
    return byPattern([/opus/i, /default/i]) ?? defaultModel
  }
  if (role === 'fast') {
    return byPattern([/spark/i, /mini/i, /luna/i]) ?? provider.models.at(-1) ?? defaultModel
  }
  if (role === 'balanced') return byPattern([/terra/i, /5\.5/i, /5\.4\b/i]) ?? defaultModel
  return byPattern([/5\.6-sol/i, /flagship/i]) ?? defaultModel
}

function qualityEffort(model: ModelCatalog): string | undefined {
  for (const value of ['max', 'xhigh', 'high', 'medium', 'low']) {
    if (model.efforts.some((effort) => effort.value === value)) return value
  }
  return undefined
}

function fastEffort(model: ModelCatalog): string | undefined {
  for (const value of ['low', 'medium', 'high']) {
    if (model.efforts.some((effort) => effort.value === value)) return value
  }
  return undefined
}

function benchmarkMatrix(catalogs: ProviderCatalog[]): {
  full: BenchmarkConfiguration[]
  smoke: BenchmarkConfiguration[]
} {
  const full: BenchmarkConfiguration[] = []
  const smoke: BenchmarkConfiguration[] = []
  for (const provider of catalogs) {
    const defaultModel = chooseModel(provider, 'default')
    const fastModel = chooseModel(provider, 'fast')
    const qualityModel = chooseModel(provider, 'quality')
    const balancedModel = chooseModel(provider, 'balanced')
    full.push(
      {
        label: `${provider.displayName} default`,
        provider: provider.id,
        model: defaultModel
      },
      {
        label: `${provider.displayName} fastest`,
        provider: provider.id,
        model: fastModel,
        effort: fastEffort(fastModel)
      },
      {
        label: `${provider.displayName} quality`,
        provider: provider.id,
        model: qualityModel,
        effort: qualityEffort(qualityModel)
      }
    )
    if (!full.some((entry) => entry.provider === provider.id && entry.model.id === balancedModel.id)) {
      smoke.push({
        label: `${provider.displayName} balanced smoke`,
        provider: provider.id,
        model: balancedModel
      })
    }
  }
  return { full, smoke }
}

function configurationValue(entry: BenchmarkConfiguration): AgentConfiguration {
  return {
    provider: entry.provider,
    model: entry.model.invocationName,
    ...(entry.effort ? { effort: entry.effort } : {})
  }
}

export function recommended(
  results: Array<
    Pick<ConfigurationResult, 'configuration' | 'score' | 'totalMs' | 'issues'>
  >,
  provider: ProviderId
): AgentConfiguration {
  const approved = results.filter(
    (result) =>
      result.configuration.provider === provider &&
      result.score >= 95 &&
      result.issues.every(
        (issue) =>
          !/geometry|measur|security|tool failure|save\/reopen/i.test(issue)
      )
  )
  if (approved.length === 0) {
    throw new Error(`${provider} has no configuration meeting the 95/100 approval threshold.`)
  }
  const frontier = approved.filter(
    (candidate) =>
      !approved.some(
        (other) =>
          other !== candidate &&
          other.score >= candidate.score &&
          other.totalMs <= candidate.totalMs &&
          (other.score > candidate.score || other.totalMs < candidate.totalMs)
      )
  )
  return [...frontier].sort(
    (left, right) => right.score - left.score || left.totalMs - right.totalMs
  )[0].configuration
}

async function completeConfigurationFromTaskA(
  application: ElectronApplication,
  page: Page,
  entry: BenchmarkConfiguration,
  stage: TaskAStage,
  outputRoot: string,
  turnBudget: { used: number },
  onTurnStarted: (turnsUsed: number) => Promise<void>
): Promise<ConfigurationResult> {
  await selectConfiguration(page, entry)
  const directory = path.join(
    outputRoot,
    entry.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  )
  await mkdir(directory, { recursive: true })
  await openDrawing(page, stage.files.taskA)
  const taskB = await runTurn(page, TASK_B, turnBudget, onTurnStarted)
  await writeJsonAtomic(path.join(directory, 'task-b-turn.json'), taskB)
  const taskBScreenshot = path.join(directory, 'task-b.png')
  await page.screenshot({ path: taskBScreenshot })
  const taskBPath = path.join(directory, 'task-b.dxf')
  const taskBReopenedPath = path.join(directory, 'task-b-reopened.dxf')
  await saveDrawing(application, page, taskBPath)
  await openDrawing(page, taskBPath)
  await saveDrawing(application, page, taskBReopenedPath)

  const [taskAText, taskAReopenedText, taskBText, taskBReopenedText] =
    await Promise.all(
      [
        stage.files.taskA,
        stage.files.taskAReopened,
        taskBPath,
        taskBReopenedPath
      ].map((file) => readFile(file, 'utf8'))
    )
  const validation = validateConfiguration(
    stage.taskA,
    taskB,
    inspectDxf(taskAText),
    inspectDxf(taskAReopenedText),
    inspectDxf(taskBText),
    inspectDxf(taskBReopenedText)
  )
  const totalMs = stage.taskA.metrics.totalMs + taskB.metrics.totalMs
  return {
    configuration: configurationValue(entry),
    label: entry.label,
    score: validation.score,
    totalMs,
    slow:
      stage.taskA.metrics.totalMs > 120_000 ||
      taskB.metrics.totalMs > 120_000,
    issues: validation.issues,
    taskA: stage.taskA,
    taskB,
    files: {
      taskA: stage.files.taskA,
      taskAReopened: stage.files.taskAReopened,
      taskB: taskBPath,
      taskBReopened: taskBReopenedPath,
      taskAScreenshot: stage.files.taskAScreenshot,
      taskBScreenshot
    }
  }
}

async function runConfiguration(
  application: ElectronApplication,
  page: Page,
  entry: BenchmarkConfiguration,
  cleanDxfPath: string,
  outputRoot: string,
  turnBudget: { used: number },
  onTurnStarted: (turnsUsed: number) => Promise<void>
): Promise<ConfigurationResult> {
  await selectConfiguration(page, entry)
  const directory = path.join(
    outputRoot,
    entry.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  )
  await mkdir(directory, { recursive: true })
  await openDrawing(page, cleanDxfPath)
  const taskA = await runTurn(page, TASK_A, turnBudget, onTurnStarted)
  await writeJsonAtomic(path.join(directory, 'task-a-turn.json'), taskA)
  const taskAScreenshot = path.join(directory, 'task-a.png')
  await page.screenshot({ path: taskAScreenshot })
  const taskAPath = path.join(directory, 'task-a.dxf')
  const taskAReopenedPath = path.join(directory, 'task-a-reopened.dxf')
  await saveDrawing(application, page, taskAPath)
  await openDrawing(page, taskAPath)
  await saveDrawing(application, page, taskAReopenedPath)

  const stage: TaskAStage = {
    schemaVersion: 1,
    label: entry.label,
    configuration: configurationValue(entry),
    taskA,
    files: {
      taskA: taskAPath,
      taskAReopened: taskAReopenedPath,
      taskAScreenshot
    }
  }
  await writeJsonAtomic(path.join(directory, 'task-a-stage.json'), stage)
  return completeConfigurationFromTaskA(
    application,
    page,
    entry,
    stage,
    outputRoot,
    turnBudget,
    onTurnStarted
  )
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (!options.live) {
    throw new Error(
      'Real provider calls are disabled by default. Re-run with: npm run benchmark:ai -- --live'
    )
  }
  const launchTarget = resolveBenchmarkLaunchTarget(options.executable)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outputRoot = path.resolve(
    options.resumeDirectory ??
      options.outputDirectory ??
      path.join(process.cwd(), 'output', 'desktop', 'ai-benchmark', timestamp)
  )
  if (options.resumeDirectory && !existsSync(outputRoot)) {
    throw new Error(`Benchmark resume directory does not exist: ${outputRoot}`)
  }
  await mkdir(outputRoot, { recursive: true })
  const cleanDxfPath = path.join(outputRoot, 'clean-benchmark.dxf')
  const sourceFixture = await readFile(
    path.join(process.cwd(), 'test', 'fixtures', 'sample-site.dxf'),
    'utf8'
  )
  await writeFile(cleanDxfPath, cleanBenchmarkDxf(sourceFixture), 'utf8')

  const progressPath = path.join(outputRoot, 'benchmark-progress.json')
  const progress: BenchmarkProgress = options.resumeDirectory
    ? await loadProgress(outputRoot)
    : {
        schemaVersion: 1,
        turnsUsed: 0,
        warmups: [],
        smoke: [],
        results: []
      }
  if (!options.resumeDirectory) await writeJsonAtomic(progressPath, progress)
  let application: ElectronApplication | undefined
  const turnsUsedAtStart = progress.turnsUsed
  const turnBudget = { used: progress.turnsUsed }
  const persistTurnUsage = async (turnsUsed: number) => {
    progress.turnsUsed = turnsUsed
    await writeJsonAtomic(progressPath, progress)
  }
  const startedAt = performance.now()
  try {
    application = await electron.launch({
      executablePath: launchTarget.automationDriver,
      args: [launchTarget.applicationAsar],
      env: cleanEnvironment()
    })
    const page = await application.firstWindow({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Open', exact: true }).waitFor({
      state: 'visible',
      timeout: 60_000
    })
    const initialPreferences = await page.evaluate(() =>
      window.envcadDesktop?.getAiPreferences()
    )
    if (!initialPreferences) throw new Error('The installed preferences API is unavailable.')
    const catalogs = await readCatalog(page)
    if (catalogs.some((provider) => provider.models.length === 0)) {
      throw new Error('Both live providers must expose at least one model before benchmarking.')
    }
    const matrix = benchmarkMatrix(catalogs)
    const expectedExcludedTurns = catalogs.length + matrix.smoke.length
    const recoveredExcludedTurns =
      progress.recovery?.priorExcludedTurnsCompleted ?? 0
    if (
      recoveredExcludedTurns > 0 &&
      recoveredExcludedTurns !== expectedExcludedTurns
    ) {
      throw new Error(
        `Resume evidence covers ${recoveredExcludedTurns} excluded turns, but the live catalog requires ${expectedExcludedTurns}.`
      )
    }
    if (recoveredExcludedTurns === 0) {
      for (const provider of catalogs) {
        const entry: BenchmarkConfiguration = {
          label: `${provider.displayName} excluded warm-up`,
          provider: provider.id,
          model: chooseModel(provider, 'default')
        }
        const configuration = configurationValue(entry)
        if (
          progress.warmups.some(
            (warmup) =>
              warmup.provider === provider.id &&
              sameConfiguration(warmup.configuration, configuration)
          )
        ) {
          continue
        }
        await selectConfiguration(page, entry)
        await openDrawing(page, cleanDxfPath)
        const result = await runTurn(
          page,
          SMOKE_PROMPT,
          turnBudget,
          persistTurnUsage
        )
        if (
          result.tools.length !== 1 ||
          result.tools[0].name !== 'get_drawing_context'
        ) {
          throw new Error(`${entry.label} did not make exactly one read-only CAD tool call.`)
        }
        progress.warmups.push({
          provider: provider.id,
          configuration,
          result
        })
        await writeJsonAtomic(progressPath, progress)
      }

      for (const entry of matrix.smoke) {
        const configuration = configurationValue(entry)
        if (
          progress.smoke.some(
            (smoke) =>
              smoke.label === entry.label &&
              sameConfiguration(smoke.configuration, configuration)
          )
        ) {
          continue
        }
        await selectConfiguration(page, entry)
        await openDrawing(page, cleanDxfPath)
        const result = await runTurn(
          page,
          SMOKE_PROMPT,
          turnBudget,
          persistTurnUsage
        )
        if (
          result.tools.length !== 1 ||
          result.tools[0].name !== 'get_drawing_context'
        ) {
          throw new Error(`${entry.label} did not complete a read-only CAD smoke test.`)
        }
        progress.smoke.push({
          label: entry.label,
          configuration,
          result
        })
        await writeJsonAtomic(progressPath, progress)
      }
    }

    const results = progress.results
    for (const entry of matrix.full) {
      const configuration = configurationValue(entry)
      if (
        results.some((result) =>
          sameConfiguration(result.configuration, configuration)
        )
      ) {
        continue
      }
      const stage = await loadTaskAStage(outputRoot, entry)
      const result = stage
        ? await completeConfigurationFromTaskA(
            application,
            page,
            entry,
            stage,
            outputRoot,
            turnBudget,
            persistTurnUsage
          )
        : await runConfiguration(
          application,
          page,
          entry,
          cleanDxfPath,
          outputRoot,
          turnBudget,
          persistTurnUsage
        )
      results.push(result)
      progress.results = results
      progress.turnsUsed = turnBudget.used
      await writeJsonAtomic(progressPath, progress)
    }
    const recommendations = {
      'claude-code': recommended(results, 'claude-code'),
      'openai-codex': recommended(results, 'openai-codex')
    }
    await page.evaluate(
      async ({ preferences, recommendations: selected }) => {
        await window.envcadDesktop?.saveAiPreferences({
          ...preferences,
          recommendedConfigurations: selected
        })
      },
      { preferences: initialPreferences, recommendations }
    )
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      installedArtifact: {
        requestedExecutable: launchTarget.requestedExecutable,
        applicationExecutable: launchTarget.applicationExecutable,
        applicationAsar: launchTarget.applicationAsar
      },
      installedVersion: await application.evaluate(({ app }) => app.getVersion()),
      catalogs,
      turnsUsed: turnBudget.used,
      turnsUsedThisProcess: turnBudget.used - turnsUsedAtStart,
      recovery: progress.recovery,
      warmups: progress.warmups,
      smoke: progress.smoke,
      results,
      recommendations,
      totalBenchmarkMs: performance.now() - startedAt
    }
    await writeJsonAtomic(
      path.join(outputRoot, 'benchmark-results.json'),
      report
    )
    console.log(
      JSON.stringify({
        status: 'passed',
        outputRoot,
        turnsUsed: turnBudget.used,
        recommendations,
        results: results.map((result) => ({
          label: result.label,
          score: result.score,
          totalMs: Math.round(result.totalMs),
          slow: result.slow
        }))
      })
    )
  } finally {
    if (application) {
      try {
        await application.close()
      } catch (error) {
        console.error(
          `Benchmark application cleanup failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        process.exitCode = 1
      }
    }
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  await main()
}
