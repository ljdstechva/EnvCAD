import { expect, test, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
import {
  cleanBenchmarkDxf,
  geometryFingerprint,
  inspectDxf
} from '../../scripts/aiBenchmark'

const FIXTURE = path.join(process.cwd(), 'test', 'fixtures', 'sample-site.dxf')
const CONTROL_URL = 'http://127.0.0.1:8788'
const TRUNCATED_DXF = [
  '0',
  'SECTION',
  '2',
  'HEADER',
  '9',
  '$LWDISPLAY',
  '290',
  '1',
  '0',
  'ENDSEC',
  '0',
  'SECTION',
  '2',
  'ENTITIES',
  '0',
  'LINE',
  '8',
  'BROKEN',
  '10',
  '0',
  '20',
  '0',
  '11',
  '100',
  '21'
].join('\n')

interface TestEntity {
  id: string
  type: string
  layer: string
  bbox: { minX: number; minY: number; maxX: number; maxY: number } | null
}

async function loadFixture(page: Page): Promise<TestEntity[]> {
  await page.goto('/')
  await expect
    .poll(() => page.evaluate(() => Boolean(window.__cadTest)))
    .toBe(true)

  await page.locator('input[accept=".dxf,.dwg"]').setInputFiles(FIXTURE)
  await expect(page.getByRole('button', { name: 'Save DXF' })).toBeEnabled()
  await expect
    .poll(() => page.evaluate(() => window.__cadTest?.entities().length ?? 0))
    .toBeGreaterThan(0)
  const entities = await page.evaluate(() => window.__cadTest?.entities() ?? [])
  await expect
    .poll(() => page.evaluate(() => window.__cadTest?.renderedEntityIds().length ?? 0))
    .toBe(entities.length)
  return entities
}

function pngPixelVariance(png: Buffer): { uniqueColors: number; brightnessRange: number } {
  const signature = png.subarray(0, 8).toString('hex')
  expect(signature).toBe('89504e470d0a1a0a')

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
    } else if (type === 'IDAT') {
      idat.push(bytes)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }

  expect(bitDepth).toBe(8)
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1
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
        row > 0 && column >= channels ? pixels[previousStart + column - channels] : 0
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
      } else {
        throw new Error(`Unsupported PNG filter ${filter}`)
      }
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
    const green = colorType === 0 || colorType === 4 ? red : pixels[index + 1]
    const blue = colorType === 0 || colorType === 4 ? red : pixels[index + 2]
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

function byId(entities: TestEntity[], ids: string[]): TestEntity[] {
  return ids
    .map((id) => entities.find((entity) => entity.id === id))
    .filter((entity): entity is TestEntity => Boolean(entity))
    .sort((a, b) => a.id.localeCompare(b.id))
}

test.describe.serial('EnvCAD preview with scripted fake sidecar', () => {
  let anthropicRequests: string[]

  test.beforeEach(async ({ page, request }) => {
    anthropicRequests = []
    page.on('request', (outgoing) => {
      if (/anthropic/i.test(new URL(outgoing.url()).hostname)) {
        anthropicRequests.push(outgoing.url())
      }
    })
    await request.post(`${CONTROL_URL}/start`)
    await request.post(`${CONTROL_URL}/scenario?name=ready`)
    await request.post(`${CONTROL_URL}/delay?ms=0`)
  })

  test.afterEach(() => {
    expect(anthropicRequests).toEqual([])
  })

  test('loads sample-site.dxf and renders non-blank CAD pixels', async ({ page }) => {
    const entities = await loadFixture(page)
    expect(entities.length).toBeGreaterThan(5)

    const canvases = page.locator('.canvas-host canvas:visible')
    await expect(canvases.first()).toBeVisible()
    const screenshot = await canvases.first().screenshot()
    const variance = pngPixelVariance(screenshot)
    expect(variance.uniqueColors).toBeGreaterThan(4)
    expect(variance.brightnessRange).toBeGreaterThan(20)
  })

  test('paints the themed canvas background after opening and when the theme changes', async ({
    page
  }) => {
    // Opening a drawing makes the viewer library re-read the file's own
    // MODELBKCOLOR, so the theme colour has to be re-applied afterwards.
    await loadFixture(page)
    await expect.poll(() => page.evaluate(() => window.__cadTest?.canvasBackground())).toBe(0xf5f5f5)

    await page.locator('.theme-toggle').click()
    await expect.poll(() => page.evaluate(() => window.__cadTest?.canvasBackground())).toBe(0x1a1a1a)

    await page.locator('.theme-toggle').click()
    await expect.poll(() => page.evaluate(() => window.__cadTest?.canvasBackground())).toBe(0xf5f5f5)
  })

  test('sets A4 portrait and renders a 210 by 297 sheet viewBox', async ({ page }) => {
    await loadFixture(page)
    await page.getByRole('button', { name: 'Page Setup', exact: true }).click()
    const dialog = page.locator('.dialog')
    await dialog.locator('.field-row').filter({ hasText: 'Paper size' }).locator('select').selectOption('A4')
    await dialog.getByRole('button', { name: /Portrait/ }).click()
    await dialog.locator('.dialog-header .icon-btn').click()

    await page.getByRole('button', { name: 'Sheet Preview' }).click()
    const sheetSvg = page.locator('.paper > svg')
    await expect(sheetSvg).toHaveAttribute('viewBox', '0 0 210 297')
  })

  test('downloads non-empty PDF and DXF containing BOUNDARY', async ({ page }) => {
    await loadFixture(page)
    await page.getByRole('button', { name: 'Sheet Preview' }).click()
    await expect(page.locator('.paper > svg')).toBeVisible()

    const pdfDownloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export PDF' }).click()
    const pdfDownload = await pdfDownloadPromise
    const pdfPath = await pdfDownload.path()
    expect(pdfPath).not.toBeNull()
    expect((await fs.stat(pdfPath!)).size).toBeGreaterThan(100)

    const dxfDownloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Save DXF' }).click()
    const dxfDownload = await dxfDownloadPromise
    const dxfPath = await dxfDownload.path()
    expect(dxfPath).not.toBeNull()
    const dxf = await fs.readFile(dxfPath!, 'utf8')
    expect(dxf.length).toBeGreaterThan(100)
    expect(dxf).toContain('BOUNDARY')
  })

  test('exports and reopens the deterministic AI benchmark geometry exactly', async ({
    page
  }, testInfo) => {
    const cleanPath = testInfo.outputPath('clean-benchmark.dxf')
    const savedPath = testInfo.outputPath('benchmark-saved.dxf')
    const reopenedPath = testInfo.outputPath('benchmark-reopened.dxf')
    await fs.writeFile(
      cleanPath,
      cleanBenchmarkDxf(await fs.readFile(FIXTURE, 'utf8')),
      'utf8'
    )
    await page.goto('/')
    await expect.poll(() => page.evaluate(() => Boolean(window.__cadTest))).toBe(true)
    await page.locator('input[accept=".dxf,.dwg"]').setInputFiles(cleanPath)
    await expect(page.getByRole('button', { name: 'Save DXF' })).toBeEnabled()
    await expect
      .poll(() => page.evaluate(() => window.__cadTest?.entities().length ?? -1))
      .toBe(0)

    const evidence = await page.evaluate(async () => {
      const call = async (name: Parameters<NonNullable<typeof window.__cadTest>['callTool']>[0], input: unknown) => {
        const result = await window.__cadTest!.callTool(name, input)
        if (result.error || !result.data) {
          throw new Error(`${name} failed: ${result.error ?? 'missing data'}`)
        }
        return result.data as Record<string, unknown>
      }
      await call('create_layer', {
        name: 'AI_BENCHMARK',
        colorCss: '#00a86b'
      })
      const rectangle = await call('draw_rectangle', {
        corner1: { x: 0, y: 0 },
        corner2: { x: 20, y: 10 },
        layer: 'AI_BENCHMARK'
      })
      const rectangleId = (rectangle.entityIds as string[])[0]
      const area = await call('calculate_area', { entityIds: [rectangleId] })
      await call('zoom_extents', {})
      const circle = await call('draw_circle', {
        center: { x: 30, y: 10 },
        radius: 5,
        layer: 'AI_BENCHMARK'
      })
      const circleId = (circle.entityIds as string[])[0]
      const dimension = await call('add_radius_dimension', {
        circleEntityId: circleId,
        layer: 'AI_BENCHMARK'
      })
      const text = await call('draw_text', {
        position: { x: 30, y: 17 },
        text: 'AI BENCHMARK',
        height: 1,
        layer: 'AI_BENCHMARK'
      })
      return {
        ids: [
          rectangleId,
          circleId,
          (dimension.entityIds as string[])[0],
          (text.entityIds as string[])[0]
        ],
        area: area.totalArea,
        areaUnits: area.units,
        radius: dimension.measurement
      }
    })
    expect(evidence.area).toBe(200)
    expect(evidence.areaUnits).toBe('Meters²')
    expect(evidence.radius).toBe(5)

    let download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Save DXF' }).click()
    await (await download).saveAs(savedPath)
    await page.locator('input[accept=".dxf,.dwg"]').setInputFiles(savedPath)
    await expect
      .poll(() => page.evaluate(() => window.__cadTest?.entities().length ?? 0))
      .toBe(4)
    download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Save DXF' }).click()
    await (await download).saveAs(reopenedPath)

    const saved = inspectDxf(await fs.readFile(savedPath, 'utf8'))
    const reopened = inspectDxf(await fs.readFile(reopenedPath, 'utf8'))
    expect(saved.acadVersion).toBe('AC1018')
    expect(saved.unitsCode).toBe(6)
    expect(saved.entities).toHaveLength(4)
    expect(saved.entities.every((entity) => entity.layer === 'AI_BENCHMARK')).toBe(true)
    expect(
      saved.entities.map((entity) => entity.handle).sort()
    ).toEqual([...evidence.ids].sort())
    expect(
      saved.layers.find((layer) => layer.name === 'AI_BENCHMARK')?.trueColor
    ).toBe(0x00a86b)
    expect(
      reopened.layers.find((layer) => layer.name === 'AI_BENCHMARK')?.trueColor
    ).toBe(0x00a86b)
    expect(geometryFingerprint(saved)).toBe(geometryFingerprint(reopened))
  })

  test('moves attached entities by +5 through chat and Ctrl+Z restores them', async ({
    page,
    request
  }) => {
    await loadFixture(page)
    await request.post(`${CONTROL_URL}/reset-stats`)
    const selectedIds = await page.evaluate(() => window.__cadTest?.selectByLayer('BUILDINGS') ?? [])
    expect(selectedIds).toHaveLength(2)

    const before = byId(
      await page.evaluate(() => window.__cadTest?.entities() ?? []),
      selectedIds
    )
    expect(before).toHaveLength(2)
    await expect(page.locator('.selection-chip')).toContainText('2 objects')

    const input = page.locator('.chat-textarea')
    await expect(input).toBeEnabled()
    await input.fill('Move these buildings five units to the right.')
    await page.getByRole('button', { name: 'Send' }).click()

    const tool = page.locator('.tool-chip').filter({ hasText: 'move_entities' })
    await expect(tool).toHaveClass(/ok/)
    for (const id of selectedIds) await expect(tool).toContainText(id)

    const after = byId(
      await page.evaluate(() => window.__cadTest?.entities() ?? []),
      selectedIds
    )
    after.forEach((entity, index) => {
      expect(entity.bbox?.minX).toBe((before[index].bbox?.minX ?? 0) + 5)
      expect(entity.bbox?.maxX).toBe((before[index].bbox?.maxX ?? 0) + 5)
      expect(entity.bbox?.minY).toBe(before[index].bbox?.minY)
      expect(entity.bbox?.maxY).toBe(before[index].bbox?.maxY)
    })
    await expect.poll(() => page.evaluate(() => window.__cadTest?.canUndo())).toBe(true)

    await page.locator('.canvas-host').click({ position: { x: 20, y: 20 } })
    await page.keyboard.press('Control+z')
    await expect
      .poll(async () =>
        byId(await page.evaluate(() => window.__cadTest?.entities() ?? []), selectedIds)
      )
      .toEqual(before)

    const stats = await (await request.get(`${CONTROL_URL}/stats`)).json()
    expect(stats).toMatchObject({ userMessageCount: 1, toolResultCount: 1 })
  })

  test('discovers provider-specific models and effort options with keyboard-safe layouts', async ({
    page
  }) => {
    await page.goto('/')
    const provider = page.getByLabel('AI provider', { exact: true })
    const model = page.getByLabel('AI model')
    const effort = page.getByLabel('Reasoning effort')

    await expect(provider).toBeEnabled()
    await expect(provider.locator('option')).toHaveText([
      'Claude Code',
      'OpenAI Codex'
    ])
    await expect(model.locator('option')).toHaveText(['Fake Claude'])
    await expect(effort.locator('option')).toHaveText([
      'Default',
      'Low',
      'High'
    ])

    await provider.focus()
    await expect(provider).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(provider).toHaveValue('openai-codex')
    await expect(page.locator('.next-provider')).toContainText(
      'Next prompt: OpenAI Codex'
    )
    await expect(model.locator('option')).toHaveText([
      'Fake Codex Balanced',
      'Fake Codex Fast'
    ])
    await expect(effort.locator('option')).toHaveText([
      'Default',
      'Low',
      'Medium'
    ])
    await model.selectOption('fake-codex-fast')
    await expect(effort.locator('option')).toHaveText(['Default', 'Low'])
    await expect(model).toHaveAttribute(
      'title',
      'Deterministic fast E2E model'
    )

    for (const width of [280, 420]) {
      await page.addStyleTag({
        content: `.side-dock { width: ${width}px !important; }`
      })
      await expect
        .poll(() =>
          page
            .locator('.ai-selector')
            .evaluate(
              (element) => element.scrollWidth <= element.clientWidth
            )
        )
        .toBe(true)
      const dockBox = await page.locator('.side-dock').boundingBox()
      expect(dockBox).not.toBeNull()
      for (const control of [provider, model, effort]) {
        const box = await control.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.x).toBeGreaterThanOrEqual(dockBox!.x)
        expect(box!.x + box!.width).toBeLessThanOrEqual(
          dockBox!.x + dockBox!.width
        )
      }
    }
  })

  test('locks configuration during a turn, labels responses, and starts a new conversation on switch', async ({
    page,
    request
  }) => {
    await loadFixture(page)
    await request.post(`${CONTROL_URL}/delay?ms=750`)
    const selectedIds = await page.evaluate(
      () => window.__cadTest?.selectByLayer('BUILDINGS') ?? []
    )
    expect(selectedIds).toHaveLength(2)

    const input = page.locator('.chat-textarea')
    await input.fill('Move these buildings five units to the right.')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.locator('.status-text')).toHaveText('Thinking...')
    await expect(
      page.getByLabel('AI provider', { exact: true })
    ).toBeDisabled()
    await expect(page.getByLabel('AI model')).toBeDisabled()
    await expect(page.getByLabel('Reasoning effort')).toBeDisabled()
    await expect(
      page.getByRole('button', { name: 'Refresh models and provider status' })
    ).toBeDisabled()

    await expect(page.locator('.status-text')).toHaveText('Idle')
    await expect(
      page.getByLabel('AI provider', { exact: true })
    ).toBeEnabled()
    const response = page.locator('.bubble.assistant').last()
    await expect(response.locator('.response-meta')).toContainText(
      'Claude Code'
    )
    await expect(response.locator('.response-meta')).toContainText(
      'fake-claude'
    )
    await expect(response.locator('.response-meta')).toContainText('Default')

    await page
      .getByLabel('AI provider', { exact: true })
      .selectOption('openai-codex')
    await expect(page.locator('.conversation-boundary')).toContainText(
      'New conversation'
    )
    await expect(page.locator('.conversation-boundary')).toContainText(
      'openai-codex / fake-codex-balanced / Default'
    )
    await expect(input).toBeEnabled()
  })

  test('shows actionable provider failure states without disabling CAD editing', async ({
    page,
    request
  }) => {
    await page.goto('/')
    await request.post(`${CONTROL_URL}/scenario?name=codex-missing`)
    await page
      .getByLabel('AI provider', { exact: true })
      .selectOption('openai-codex')
    await expect(page.locator('.readiness-badge')).toHaveText('missing')
    await expect(page.locator('.provider-message')).toContainText(
      'Install Codex CLI, run "codex login", then refresh.'
    )
    await expect(page.locator('.chat-textarea')).toBeDisabled()
    await expect(
      page.getByRole('button', { name: 'Open', exact: true })
    ).toBeEnabled()

    await request.post(`${CONTROL_URL}/scenario?name=ready`)
    await expect(page.locator('.readiness-badge')).toHaveText('ready')
    await expect(page.locator('.chat-textarea')).toBeEnabled()

    await request.post(`${CONTROL_URL}/scenario?name=both-unavailable`)
    await expect(page.locator('.readiness-badge')).toHaveText(
      'authentication-required'
    )
    await expect(page.locator('.provider-message')).toContainText(
      'Run "codex login", then refresh.'
    )
    await expect(page.locator('.chat-textarea')).toBeDisabled()
    await expect(
      page.getByRole('button', { name: 'Open', exact: true })
    ).toBeEnabled()
  })

  test('rejects a truncated DXF without changing the edited drawing', async ({ page }) => {
    const originalEntities = await loadFixture(page)
    const validDxf = await fs.readFile(FIXTURE, 'utf8')
    const selectedIds = await page.evaluate(
      () => window.__cadTest?.selectByLayer('BUILDINGS') ?? []
    )
    expect(selectedIds).toHaveLength(2)

    const moveResult = await page.evaluate((entityIds) => {
      return window.__cadTest?.callTool('move_entities', { entityIds, dx: 5, dy: 0 })
    }, selectedIds)
    expect(moveResult).toMatchObject({ data: { entityIds: selectedIds, dx: 5, dy: 0 } })

    const editedEntities = await page.evaluate(() => window.__cadTest?.entities() ?? [])
    const renderedIdsBefore = await page.evaluate(
      () => window.__cadTest?.renderedEntityIds() ?? []
    )
    expect(editedEntities).not.toEqual(originalEntities)
    expect(renderedIdsBefore).toHaveLength(editedEntities.length)
    await expect.poll(() => page.evaluate(() => window.__cadTest?.isDirty())).toBe(true)

    const stateBefore = await page.evaluate((dxf) => {
      const snapshot = JSON.stringify({
        fileName: 'sample-site.dxf',
        dxf,
        savedAt: 1_700_000_000_000
      })
      localStorage.setItem('envcad.autosaveSnapshot', snapshot)
      return {
        fileName: window.__cadTest?.fileName(),
        isDirty: window.__cadTest?.isDirty(),
        selection: window.__cadTest?.selection(),
        canUndo: window.__cadTest?.canUndo(),
        canRedo: window.__cadTest?.canRedo(),
        recentFiles: localStorage.getItem('envcad.recentFiles'),
        autosave: localStorage.getItem('envcad.autosaveSnapshot')
      }
    }, validDxf)
    expect(stateBefore).toMatchObject({
      fileName: 'sample-site.dxf',
      isDirty: true,
      selection: selectedIds,
      canUndo: true,
      canRedo: false
    })
    expect(JSON.parse(stateBefore.recentFiles ?? '[]')).toContain('sample-site.dxf')

    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    const opened = await page.evaluate(
      ({ name, text }) => window.__cadTest?.openTextFile(name, text),
      { name: 'truncated.dxf', text: TRUNCATED_DXF }
    )

    expect(opened).toBe(false)
    const toasts = page.locator('.toast[role="alert"]')
    await expect(toasts).toHaveCount(1)
    await expect(toasts).toContainText(
      "Couldn't open truncated.dxf. It may be corrupt or in an unsupported format."
    )
    await expect(toasts).not.toContainText(/Error:|at \w+|\.ts:\d+|\.js:\d+/)

    expect(await page.evaluate(() => window.__cadTest?.entities() ?? [])).toEqual(
      editedEntities
    )
    expect(await page.evaluate(() => window.__cadTest?.selection() ?? [])).toEqual(
      selectedIds
    )
    expect(
      await page.evaluate(() => window.__cadTest?.renderedEntityIds() ?? [])
    ).toEqual(renderedIdsBefore)
    expect(
      await page.evaluate(() => ({
        fileName: window.__cadTest?.fileName(),
        isDirty: window.__cadTest?.isDirty(),
        canUndo: window.__cadTest?.canUndo(),
        canRedo: window.__cadTest?.canRedo(),
        recentFiles: localStorage.getItem('envcad.recentFiles'),
        autosave: localStorage.getItem('envcad.autosaveSnapshot')
      }))
    ).toEqual({
      fileName: stateBefore.fileName,
      isDirty: stateBefore.isDirty,
      canUndo: stateBefore.canUndo,
      canRedo: stateBefore.canRedo,
      recentFiles: stateBefore.recentFiles,
      autosave: stateBefore.autosave
    })
    expect(pageErrors).toEqual([])

    await page.getByRole('button', { name: 'Undo' }).click()
    await expect
      .poll(() => page.evaluate(() => window.__cadTest?.entities() ?? []))
      .toEqual(originalEntities)
    await page.getByRole('button', { name: 'Redo' }).click()
    await expect
      .poll(() => page.evaluate(() => window.__cadTest?.entities() ?? []))
      .toEqual(editedEntities)
    await expect(page.locator('.canvas-host canvas:visible').first()).toBeVisible()

    // The current dirty drawing is intentionally autosaved during beforeunload.
    // Re-seed the original valid snapshot before the reloaded app mounts so
    // this tail verifies the restore path independently of DXF export fidelity.
    await page.addInitScript((autosave) => {
      localStorage.setItem('envcad.autosaveSnapshot', autosave)
    }, stateBefore.autosave!)
    await page.reload()
    await expect(page.locator('.restore-banner')).toContainText(
      'Restore unsaved drawing "sample-site.dxf"'
    )
    await page.getByRole('button', { name: 'Restore', exact: true }).click()
    await expect(page.locator('.restore-banner')).toBeHidden()
    await expect
      .poll(() => page.evaluate(() => window.__cadTest?.entities().length ?? 0))
      .toBe(originalEntities.length)
    await expect.poll(() => page.evaluate(() => window.__cadTest?.fileName())).toBe(
      'sample-site.dxf'
    )
    await expect.poll(() => page.evaluate(() => window.__cadTest?.isDirty())).toBe(true)
    expect(
      await page.evaluate(() => localStorage.getItem('envcad.autosaveSnapshot'))
    ).toBeNull()
  })

  test('shows offline disabled chat and reconnects when the fake sidecar starts', async ({
    page,
    request
  }) => {
    await request.post(`${CONTROL_URL}/stop`)
    try {
      await page.goto('/')
      await expect(page.locator('.offline-banner')).toBeVisible()
      await expect(page.locator('.chat-textarea')).toBeDisabled()

      await request.post(`${CONTROL_URL}/start`)
      await expect(page.locator('.offline-banner')).toBeHidden()
      await expect(page.locator('.chat-textarea')).toBeEnabled()
    } finally {
      await request.post(`${CONTROL_URL}/start`)
    }
  })
})
