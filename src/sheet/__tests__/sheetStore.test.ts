import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnvCadDesktopApi } from '../../../desktop/runtimeProtocol'
import type { SheetDefinition } from '../types'
import {
  activateSheetDocument,
  deactivateSheetDocument,
  matchSheetToDatabaseUnit,
  sheetStore,
  sheetUnitMismatch
} from '../sheetStore'

describe('per-document sheet state', () => {
  beforeEach(() => {
    window.localStorage.clear()
    delete window.envcadDesktop
    deactivateSheetDocument()
  })

  afterEach(() => {
    delete window.envcadDesktop
  })

  it('defaults the sheet unit from the active database unit', async () => {
    await activateSheetDocument('meters.dxf', 'm')
    expect(sheetStore.current.drawingUnit).toBe('m')

    await activateSheetDocument('millimeters.dxf', 'mm')
    expect(sheetStore.current.drawingUnit).toBe('mm')
  })

  it('restores independent sheet settings when switching documents', async () => {
    await activateSheetDocument('first.dxf', 'm')
    sheetStore.current.paper = 'A1'
    sheetStore.current.scaleDenominator = 200
    sheetStore.current.drawingUnit = 'm'

    await activateSheetDocument('second.dxf', 'mm')
    expect(sheetStore.current.paper).toBe('A3')
    expect(sheetStore.current.drawingUnit).toBe('mm')
    sheetStore.current.paper = 'A4'
    sheetStore.current.scaleDenominator = 50

    await activateSheetDocument('FIRST.DXF', 'm')
    expect(sheetStore.current).toMatchObject({
      paper: 'A1',
      scaleDenominator: 200,
      drawingUnit: 'm'
    })

    await activateSheetDocument('second.dxf', 'mm')
    expect(sheetStore.current).toMatchObject({
      paper: 'A4',
      scaleDenominator: 50,
      drawingUnit: 'mm'
    })
  })

  it('reports the exact mismatch factor and only changes sheet interpretation', async () => {
    await activateSheetDocument('millimeters.dxf', 'mm')
    sheetStore.current.drawingUnit = 'm'

    expect(sheetUnitMismatch('mm')).toEqual({
      mismatch: true,
      factor: 1000,
      message:
        'Database units are mm; Sheet Preview is configured as m. ' +
        'The interpretation differs by a factor of 1,000. ' +
        'Use Match database unit before previewing or exporting.'
    })

    expect(matchSheetToDatabaseUnit('mm')).toBe(true)
    expect(sheetStore.current.drawingUnit).toBe('mm')
    expect(sheetUnitMismatch('mm')).toEqual({ mismatch: false })
  })

  it('uses the desktop profile across renderer-origin changes', async () => {
    const persisted = new Map<string, SheetDefinition>()
    const getSheetPreference = vi.fn(async (documentName: string) =>
      persisted.get(documentName)
    )
    const saveSheetPreference = vi.fn(
      async (documentName: string, sheet: SheetDefinition) => {
        persisted.set(documentName, JSON.parse(JSON.stringify(sheet)))
        return sheet
      }
    )
    window.envcadDesktop = {
      getSheetPreference,
      saveSheetPreference
    } as unknown as EnvCadDesktopApi

    await activateSheetDocument('M-01.dxf', 'mm')
    sheetStore.current.paper = 'A1'
    sheetStore.current.scaleDenominator = 200
    await vi.waitFor(() =>
      expect(persisted.get('m-01.dxf')).toMatchObject({
        paper: 'A1',
        drawingUnit: 'mm',
        scaleDenominator: 200
      })
    )

    deactivateSheetDocument()
    await activateSheetDocument('M-01.dxf', 'mm')
    expect(sheetStore.current.paper).toBe('A1')
    expect(getSheetPreference).toHaveBeenCalledWith('m-01.dxf')
  })
})
