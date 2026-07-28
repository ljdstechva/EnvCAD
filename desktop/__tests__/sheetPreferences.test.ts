import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SheetPreferencesStore,
  parseSheetDefinition
} from '../sheetPreferences'
import type { SheetDefinition } from '../../src/sheet/types'

const directories: string[] = []
const A1_SHEET: SheetDefinition = {
  paper: 'A1',
  orientation: 'landscape',
  marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
  scaleDenominator: 200,
  drawingUnit: 'mm',
  viewportCenter: 'extents'
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'envcad-sheet-preferences-'))
  directories.push(directory)
  const filePath = path.join(directory, 'settings', 'sheet-preferences.json')
  const logger = { warn: vi.fn() }
  return {
    filePath,
    logger,
    store: new SheetPreferencesStore(filePath, logger)
  }
}

describe('desktop sheet preferences', () => {
  it('atomically persists independent normalized document settings', async () => {
    const { filePath, store } = await fixture()
    await expect(store.load('M-01.dxf')).resolves.toBeUndefined()
    await expect(store.save('M-01.dxf', A1_SHEET)).resolves.toEqual(A1_SHEET)
    await expect(store.load('m-01.DXF')).resolves.toEqual(A1_SHEET)
    await expect(store.load('other.dxf')).resolves.toBeUndefined()
    expect(
      (await readdir(path.dirname(filePath))).filter((name) =>
        name.endsWith('.tmp')
      )
    ).toEqual([])
  })

  it('recovers from corrupt storage without logging its contents', async () => {
    const { filePath, logger, store } = await fixture()
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, '{sensitive-corrupt-value')
    await expect(store.load('M-01.dxf')).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(
      'Sheet preferences were invalid and safe per-document defaults were restored.'
    )
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
      'sensitive-corrupt-value'
    )
  })

  it('rejects unknown fields, unsafe document names, and invalid geometry', () => {
    expect(() =>
      parseSheetDefinition({ ...A1_SHEET, unexpected: true })
    ).toThrow('unknown properties')
    expect(() =>
      parseSheetDefinition({
        ...A1_SHEET,
        viewportCenter: { x: Number.POSITIVE_INFINITY, y: 0 }
      })
    ).toThrow('viewport center')
  })
})
