import { createHash } from 'node:crypto'
import {
  mkdir,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
import {
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import {
  inspectDxf,
  resolveBenchmarkLaunchTarget
} from './aiBenchmark'

interface CliOptions {
  executable?: string
  drawing?: string
  outputDirectory?: string
}

interface PixelVariance {
  uniqueColors: number
  brightnessRange: number
}

const EXPECTED_M01_EXTENTS = {
  minX: 2_000,
  minY: 2_000,
  maxX: 166_200,
  maxY: 116_800
}
const CAD_COORDINATE_TOLERANCE = 1e-4

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--executable') options.executable = argv[++index]
    else if (argument.startsWith('--executable=')) {
      options.executable = argument.slice('--executable='.length)
    } else if (argument === '--drawing') options.drawing = argv[++index]
    else if (argument.startsWith('--drawing=')) {
      options.drawing = argument.slice('--drawing='.length)
    } else if (argument === '--output') options.outputDirectory = argv[++index]
    else if (argument.startsWith('--output=')) {
      options.outputDirectory = argument.slice('--output='.length)
    } else {
      throw new Error(`Unknown installed M-01 acceptance argument: ${argument}`)
    }
  }
  if (!options.drawing) throw new Error('--drawing <M-01.dxf> is required.')
  return options
}

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

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

type DxfInspection = ReturnType<typeof inspectDxf>

function roundCadNumber(value: number): number {
  return Number(value.toFixed(4))
}

function normalizeSemanticValue(value: unknown): unknown {
  if (typeof value === 'number') return roundCadNumber(value)
  if (Array.isArray(value)) return value.map(normalizeSemanticValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'handle')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeSemanticValue(entry)])
    )
  }
  return value
}

function semanticFingerprint(inspection: DxfInspection): string {
  const normalized = inspection.entities
    .map((entity) => JSON.stringify(normalizeSemanticValue(entity)))
    .sort()
  return sha256(JSON.stringify(normalized))
}

function histogram(values: string[]): Record<string, number> {
  const result: Record<string, number> = {}
  for (const value of values.sort()) result[value] = (result[value] ?? 0) + 1
  return result
}

function entityTypeHistogram(
  inspection: DxfInspection
): Record<string, number> {
  return histogram(inspection.entities.map((entity) => entity.type))
}

function layerAssignmentHistogram(
  inspection: DxfInspection
): Record<string, number> {
  return histogram(
    inspection.entities.map((entity) => `${entity.type}|${entity.layer}`)
  )
}

function inspectedExtents(
  inspection: DxfInspection
): typeof EXPECTED_M01_EXTENTS {
  const points: Array<{ x: number; y: number }> = []
  for (const entity of inspection.entities) {
    if (entity.points) points.push(...entity.points)
    if (entity.position) points.push(entity.position)
    if (entity.center) {
      const radius = entity.radius ?? 0
      points.push(
        { x: entity.center.x - radius, y: entity.center.y - radius },
        { x: entity.center.x + radius, y: entity.center.y + radius }
      )
    }
  }
  if (points.length === 0) throw new Error('DXF semantic extents are empty.')
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y))
  }
}

function sameCadExtents(
  left: typeof EXPECTED_M01_EXTENTS,
  right: typeof EXPECTED_M01_EXTENTS
): boolean {
  return (Object.keys(left) as Array<keyof typeof left>).every(
    (key) => Math.abs(left[key] - right[key]) <= CAD_COORDINATE_TOLERANCE
  )
}


async function launchInstalledApplication(
  automationDriver: string,
  applicationAsar: string
): Promise<{ application: ElectronApplication; page: Page; port: number }> {
  const application = await electron.launch({
    executablePath: automationDriver,
    args: [applicationAsar],
    env: cleanEnvironment()
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
  throw new Error('Installed EnvCAD sidecar did not become ready within 60 seconds.')
}

async function openDrawing(page: Page, filePath: string): Promise<void> {
  await page.locator('input[accept=".dxf,.dwg"]').setInputFiles(filePath)
  await page.getByRole('button', { name: 'Save DXF' }).waitFor({
    state: 'visible'
  })
  await page.waitForFunction(
    () => {
      const save = Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'Save DXF'
      ) as HTMLButtonElement | undefined
      return (
        save?.disabled === false &&
        document.querySelector('.status-bar')?.textContent?.includes(
          'Units: Millimeters'
        )
      )
    },
    undefined,
    { timeout: 60_000 }
  )
  const drawingName = path.basename(filePath)
  const openError = (
    await page.locator('.toast[role="alert"] .message').allTextContents()
  ).find((message) => message.trim().startsWith(`Couldn't open ${drawingName}`))
  if (openError) {
    throw new Error(`Opening M-01 reported: ${openError.trim()}`)
  }
}

async function configureA1Sheet(
  page: Page,
  screenshotPath: string
): Promise<void> {
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
  if (!(await dialog.textContent())?.includes('Matches sheet')) {
    throw new Error('Page Setup did not report matching database and sheet units.')
  }
  await page.screenshot({ path: screenshotPath })
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
}

async function captureDownload(
  application: ElectronApplication,
  page: Page,
  buttonName: string,
  destination: string
): Promise<void> {
  await rm(destination, { force: true })
  const completion = application.evaluate(
    ({ session }, filePath) => {
      return new Promise<{ state: string; receivedBytes: number }>((resolve) => {
        session.defaultSession.once('will-download', (_event, item) => {
          item.setSavePath(filePath)
          item.once('done', (_doneEvent, state) => {
            resolve({
              state,
              receivedBytes: item.getReceivedBytes()
            })
          })
        })
      })
    },
    destination
  )
  await page.getByRole('button', { name: buttonName, exact: true }).click()
  const result = await Promise.race([
    completion,
    delay(60_000).then(() => {
      throw new Error(`${buttonName} did not complete within 60 seconds.`)
    })
  ])
  if (result.state !== 'completed' || result.receivedBytes <= 100) {
    throw new Error(
      `${buttonName} finished as ${result.state} with ${result.receivedBytes} bytes.`
    )
  }
  try {
    if ((await stat(destination)).size > 100) return
  } catch {
    // Report the missing path below with the accepted destination.
  }
  throw new Error(`Installed EnvCAD did not save ${buttonName}: ${destination}`)
}

function pngPixelVariance(png: Buffer): PixelVariance {
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('Captured model evidence is not a PNG.')
  }
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat: Buffer[] = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.subarray(offset + 4, offset + 8).toString('ascii')
    const bytes = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = bytes.readUInt32BE(0)
      height = bytes.readUInt32BE(4)
      bitDepth = bytes[8]
      colorType = bytes[9]
    } else if (type === 'IDAT') idat.push(bytes)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`Unsupported PNG format: depth ${bitDepth}, type ${colorType}.`)
  }
  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(idat))
  const pixels = Buffer.alloc(stride * height)
  for (let row = 0; row < height; row += 1) {
    const sourceStart = row * (stride + 1)
    const filter = raw[sourceStart]
    const previousStart = (row - 1) * stride
    const targetStart = row * stride
    for (let column = 0; column < stride; column += 1) {
      const encoded = raw[sourceStart + 1 + column]
      const left = column >= channels ? pixels[targetStart + column - channels] : 0
      const up = row > 0 ? pixels[previousStart + column] : 0
      const upLeft =
        row > 0 && column >= channels
          ? pixels[previousStart + column - channels]
          : 0
      let value: number
      if (filter === 0) value = encoded
      else if (filter === 1) value = encoded + left
      else if (filter === 2) value = encoded + up
      else if (filter === 3) value = encoded + Math.floor((left + up) / 2)
      else if (filter === 4) {
        const prediction = left + up - upLeft
        const distanceLeft = Math.abs(prediction - left)
        const distanceUp = Math.abs(prediction - up)
        const distanceUpLeft = Math.abs(prediction - upLeft)
        const predictor =
          distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft
            ? left
            : distanceUp <= distanceUpLeft
              ? up
              : upLeft
        value = encoded + predictor
      } else throw new Error(`Unsupported PNG filter ${filter}.`)
      pixels[targetStart + column] = value & 0xff
    }
  }
  const colors = new Set<number>()
  let minimumBrightness = 255
  let maximumBrightness = 0
  const sampleStep = Math.max(1, Math.floor((width * height) / 100_000))
  for (let pixel = 0; pixel < width * height; pixel += sampleStep) {
    const index = pixel * channels
    const red = pixels[index]
    const green = pixels[index + 1]
    const blue = pixels[index + 2]
    colors.add((red << 16) | (green << 8) | blue)
    const brightness = (red + green + blue) / 3
    minimumBrightness = Math.min(minimumBrightness, brightness)
    maximumBrightness = Math.max(maximumBrightness, brightness)
  }
  return {
    uniqueColors: colors.size,
    brightnessRange: maximumBrightness - minimumBrightness
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

async function waitForPortClosed(port: number): Promise<void> {
  const deadline = performance.now() + 10_000
  while (performance.now() < deadline) {
    if (!(await canConnect(port))) return
    await delay(100)
  }
  throw new Error(`Installed sidecar port ${port} remained open after exit.`)
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const drawing = path.resolve(options.drawing!)
  const sourceInspection = inspectDxf(await readFile(drawing, 'utf8'))
  const sourceExtents = inspectedExtents(sourceInspection)
  if (sourceInspection.unitsCode !== 4 || sourceInspection.entities.length === 0) {
    throw new Error('M-01 acceptance requires a non-empty millimetre DXF.')
  }
  if (!sameCadExtents(sourceExtents, EXPECTED_M01_EXTENTS)) {
    throw new Error(
      `M-01 source extents changed: ${JSON.stringify(sourceExtents)}.`
    )
  }
  const launchTarget = resolveBenchmarkLaunchTarget(options.executable)
  const outputRoot = path.resolve(
    options.outputDirectory ??
      path.join(process.cwd(), 'output', 'desktop', 'installed-m01')
  )
  await mkdir(outputRoot, { recursive: true })
  const screenshots = {
    noDocument: path.join(outputRoot, 'M01_Installed_No_Document.png'),
    beforeFit: path.join(outputRoot, 'M01_Installed_Model_Before_Fit.png'),
    afterFit: path.join(outputRoot, 'M01_Installed_Model_After_Fit.png'),
    afterFitWindow: path.join(
      outputRoot,
      'M01_Installed_Model_After_Fit_Full.png'
    ),
    pageSetup: path.join(outputRoot, 'M01_Installed_Page_Setup_A1_mm.png'),
    sheetPreview: path.join(outputRoot, 'M01_Installed_Sheet_Preview_A1.png'),
    sheetPaper100: path.join(
      outputRoot,
      'M01_Installed_Sheet_Preview_Paper_100.png'
    ),
    relaunched: path.join(outputRoot, 'M01_Installed_Relaunch_Persisted_Sheet.png')
  }
  const savedDxf = path.join(outputRoot, path.basename(drawing))
  const exportedPdf = path.join(
    outputRoot,
    `${path.basename(drawing, path.extname(drawing))}.pdf`
  )
  const processIds: number[] = []
  const ports: number[] = []
  let application: ElectronApplication | undefined
  try {
    const first = await launchInstalledApplication(
      launchTarget.automationDriver,
      launchTarget.applicationAsar
    )
    application = first.application
    const firstPid = application.process().pid
    if (!firstPid) throw new Error('Installed EnvCAD did not expose a process ID.')
    processIds.push(firstPid)
    ports.push(first.port)
    const noDocumentStatus = first.page
      .getByRole('status')
      .filter({ hasText: 'No drawing is open.' })
    await noDocumentStatus.waitFor({ state: 'visible' })
    if (
      !(await noDocumentStatus.textContent())?.includes(
        'Choose New Drawing or Open.'
      )
    ) {
      throw new Error('Installed no-document guidance is incomplete.')
    }
    if (
      (await first.page.getByRole('button', { name: 'Save DXF' }).isEnabled()) ||
      (await first.page.getByRole('button', { name: 'Fit Drawing' }).isEnabled()) ||
      (await first.page.locator('.chat-textarea').isEnabled())
    ) {
      throw new Error('Installed no-document state exposed drawing or AI actions.')
    }
    if ((await first.page.locator('.status-bar').textContent())?.trim() !== 'No document') {
      throw new Error('Installed status bar exposed fallback drawing values.')
    }
    await first.page.screenshot({ path: screenshots.noDocument })

    await openDrawing(first.page, drawing)
    const canvas = first.page.locator('.canvas-host canvas:visible').first()
    await canvas.waitFor({ state: 'visible' })
    const beforeBuffer = await canvas.screenshot({ path: screenshots.beforeFit })
    const beforeVariance = pngPixelVariance(beforeBuffer)

    await configureA1Sheet(first.page, screenshots.pageSetup)
    await first.page
      .getByRole('button', { name: 'Fit Drawing', exact: true })
      .click()
    await delay(12_000)
    const afterBuffer = await canvas.screenshot({ path: screenshots.afterFit })
    await first.page.screenshot({ path: screenshots.afterFitWindow })
    const afterVariance = pngPixelVariance(afterBuffer)
    if (afterVariance.uniqueColors <= 4 || afterVariance.brightnessRange <= 20) {
      throw new Error('Installed M-01 Model view was visually blank after Fit Drawing.')
    }

    await first.page.getByRole('button', { name: 'Sheet Preview' }).click()
    const preview = first.page.locator('.preview-viewport')
    await first.page.waitForFunction(
      () => {
        const element = document.querySelector('.preview-viewport')
        return (
          element?.getAttribute('data-render-status') === 'ready' &&
          Number(element.getAttribute('data-drawable-elements')) > 0 &&
          element.getAttribute('data-unit-mismatch') === 'false'
        )
      },
      undefined,
      { timeout: 60_000 }
    )
    const sheetSvg = first.page.locator('.paper > svg')
    await sheetSvg.waitFor({ state: 'visible' })
    if ((await sheetSvg.getAttribute('viewBox')) !== '0 0 841 594') {
      throw new Error('Installed Sheet Preview is not A1 landscape.')
    }
    if ((await first.page.locator('.warning-banner').count()) !== 0) {
      throw new Error(
        `Installed Sheet Preview warnings: ${(await first.page.locator('.warning-banner').allTextContents()).join(' | ')}`
      )
    }
    const sheetRenderStatus = await preview.getAttribute('data-render-status')
    const sheetDrawableElements = Number(
      await preview.getAttribute('data-drawable-elements')
    )
    await first.page.screenshot({ path: screenshots.sheetPreview })
    await first.page.getByRole('button', { name: '100%', exact: true }).click()
    await delay(100)
    await first.page
      .locator('.paper')
      .screenshot({ path: screenshots.sheetPaper100 })
    await first.page.getByRole('button', { name: 'Fit', exact: true }).click()
    await captureDownload(
      application,
      first.page,
      'Export PDF',
      exportedPdf
    )
    await captureDownload(application, first.page, 'Save DXF', savedDxf)

    await application.close()
    application = undefined
    await waitForPortClosed(first.port)

    const second = await launchInstalledApplication(
      launchTarget.automationDriver,
      launchTarget.applicationAsar
    )
    application = second.application
    const secondPid = application.process().pid
    if (!secondPid) throw new Error('Relaunched EnvCAD did not expose a process ID.')
    processIds.push(secondPid)
    ports.push(second.port)
    await openDrawing(second.page, savedDxf)
    await second.page
      .getByRole('button', { name: 'Page Setup', exact: true })
      .click()
    const dialog = second.page.locator('.dialog')
    const persisted = {
      paper: await dialog
        .locator('.field-row')
        .filter({ hasText: 'Paper size' })
        .locator('select')
        .inputValue(),
      scale: await dialog
        .locator('.field-row')
        .filter({ hasText: 'Scale' })
        .locator('select')
        .inputValue(),
      drawingUnit: await dialog
        .locator('.field-row')
        .filter({ hasText: 'Drawing unit' })
        .locator('select')
        .inputValue(),
      landscape: await dialog
        .getByRole('button', { name: /Landscape/ })
        .getAttribute('class'),
      margins: await dialog
        .locator('.margins-grid input')
        .evaluateAll((inputs) =>
          inputs.map((input) => (input as HTMLInputElement).value)
        )
    }
    if (
      persisted.paper !== 'A1' ||
      persisted.scale !== '200' ||
      persisted.drawingUnit !== 'mm' ||
      !persisted.landscape?.includes('active') ||
      persisted.margins.some((value) => Number(value) !== 10)
    ) {
      throw new Error(`Relaunched sheet state was not preserved: ${JSON.stringify(persisted)}`)
    }
    await second.page.screenshot({ path: screenshots.relaunched })
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    await second.page.getByRole('button', { name: 'Sheet Preview' }).click()
    await second.page.waitForFunction(
      () =>
        document
          .querySelector('.preview-viewport')
          ?.getAttribute('data-render-status') === 'ready',
      undefined,
      { timeout: 60_000 }
    )
    await application.close()
    application = undefined
    await waitForPortClosed(second.port)

    const savedText = await readFile(savedDxf, 'utf8')
    const savedInspection = inspectDxf(savedText)
    const savedExtents = inspectedExtents(savedInspection)
    const pdf = await readFile(exportedPdf)
    const sourceLayers = new Set(
      sourceInspection.layers.map((layer) => layer.name)
    )
    const savedLayers = new Set(
      savedInspection.layers.map((layer) => layer.name)
    )
    const missingLayers = [...sourceLayers].filter(
      (layer) => !savedLayers.has(layer)
    )
    const addedLayers = [...savedLayers].filter(
      (layer) => !sourceLayers.has(layer)
    )
    const sourceTypes = entityTypeHistogram(sourceInspection)
    const savedTypes = entityTypeHistogram(savedInspection)
    const sourceLayerAssignments = layerAssignmentHistogram(sourceInspection)
    const savedLayerAssignments = layerAssignmentHistogram(savedInspection)
    const sourceSemanticFingerprint = semanticFingerprint(sourceInspection)
    const savedSemanticFingerprint = semanticFingerprint(savedInspection)
    if (
      savedInspection.unitsCode !== sourceInspection.unitsCode ||
      savedInspection.entities.length !== sourceInspection.entities.length ||
      missingLayers.length > 0 ||
      addedLayers.some((layer) => layer !== '0') ||
      !sameCadExtents(savedExtents, EXPECTED_M01_EXTENTS) ||
      JSON.stringify(sourceTypes) !== JSON.stringify(savedTypes) ||
      JSON.stringify(sourceLayerAssignments) !==
        JSON.stringify(savedLayerAssignments) ||
      sourceSemanticFingerprint !== savedSemanticFingerprint
    ) {
      throw new Error(
        `Saved/reopened M-01 changed required structure: ` +
          `units ${sourceInspection.unitsCode}->${savedInspection.unitsCode}, ` +
          `entities ${sourceInspection.entities.length}->${savedInspection.entities.length}, ` +
          `missing layers [${missingLayers.join(', ')}], ` +
          `unexpected layers [${addedLayers.join(', ')}], ` +
          `extents ${JSON.stringify(sourceExtents)}->${JSON.stringify(savedExtents)}, ` +
          `semantic fingerprint ${sourceSemanticFingerprint}->${savedSemanticFingerprint}.`
      )
    }
    const report = {
      schemaVersion: 1,
      status: 'passed',
      generatedAt: new Date().toISOString(),
      launchTarget,
      applicationProcessIds: processIds,
      sidecarPorts: ports,
      sidecarPortsClosed: true,
      source: {
        path: drawing,
        unitsCode: sourceInspection.unitsCode,
        entityCount: sourceInspection.entities.length,
        layerCount: sourceInspection.layers.length,
        extents: sourceExtents,
        entityTypes: sourceTypes,
        layerAssignments: sourceLayerAssignments,
        semanticFingerprint: sourceSemanticFingerprint
      },
      savedDxf: {
        path: savedDxf,
        bytes: Buffer.byteLength(savedText, 'utf8'),
        sha256: sha256(savedText),
        unitsCode: savedInspection.unitsCode,
        entityCount: savedInspection.entities.length,
        layerCount: savedInspection.layers.length,
        requiredLayersPreserved: missingLayers.length === 0,
        addedLayers,
        extents: savedExtents,
        entityTypes: savedTypes,
        layerAssignments: savedLayerAssignments,
        semanticFingerprint: savedSemanticFingerprint,
        semanticMatch: true
      },
      exportedPdf: {
        path: exportedPdf,
        bytes: pdf.length,
        sha256: sha256(pdf)
      },
      sheet: {
        paper: 'A1',
        orientation: 'landscape',
        scaleDenominator: 200,
        drawingUnit: 'mm',
        databaseUnit: 'mm',
        marginsMm: 10,
        viewBox: '0 0 841 594',
        renderStatus: sheetRenderStatus,
        drawableElementCount: sheetDrawableElements
      },
      modelPixelVariance: {
        beforeFit: beforeVariance,
        afterFit: afterVariance
      },
      persistence: persisted,
      screenshots
    }
    const reportPath = path.join(outputRoot, 'installed-m01-acceptance.json')
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.log(
      JSON.stringify({
        status: 'passed',
        reportPath,
        sourceEntities: sourceInspection.entities.length,
        savedEntities: savedInspection.entities.length,
        sheet: report.sheet,
        modelPixelVariance: report.modelPixelVariance,
        sidecarPorts: ports,
        sidecarPortsClosed: true
      })
    )
  } finally {
    if (application) await application.close().catch(() => {})
  }
}

await main()
