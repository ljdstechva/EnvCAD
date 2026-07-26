import { expect, test, type Page } from '@playwright/test'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { inflateSync } from 'node:zlib'

const FIXTURE = path.join(process.cwd(), 'test', 'fixtures', 'sample-site.dxf')
const CONTROL_URL = 'http://127.0.0.1:8788'

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
  return page.evaluate(() => window.__cadTest?.entities() ?? [])
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
