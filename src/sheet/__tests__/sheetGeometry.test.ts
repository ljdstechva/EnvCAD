import { describe, expect, it } from 'vitest'

import {
  computeSheetLayout,
  getPaperDimensions,
  mmPerDrawingUnit
} from '../sheetGeometry'
import { PAPER_SIZES } from '../types'
import type { SheetDefinition } from '../types'

const BASE_SHEET: SheetDefinition = {
  paper: 'A4',
  orientation: 'portrait',
  marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
  scaleDenominator: 100,
  drawingUnit: 'm',
  viewportCenter: 'extents'
}

const MATRIX_SCALES = [50, 100, 200, 500, 1000] as const
const SHEET_MATRIX = Object.entries(PAPER_SIZES).flatMap(([paper, portrait]) =>
  (['portrait', 'landscape'] as const).flatMap((orientation) =>
    (['m', 'mm'] as const).flatMap((drawingUnit) =>
      MATRIX_SCALES.map((scaleDenominator) => ({
        paper: paper as SheetDefinition['paper'],
        portrait,
        orientation,
        drawingUnit,
        scaleDenominator
      }))
    )
  )
)

describe('paper sizes', () => {
  it('contains the required portrait dimensions in millimeters', () => {
    expect(PAPER_SIZES).toEqual({
      A4: { widthMm: 210, heightMm: 297 },
      A3: { widthMm: 297, heightMm: 420 },
      A2: { widthMm: 420, heightMm: 594 },
      A1: { widthMm: 594, heightMm: 841 },
      A0: { widthMm: 841, heightMm: 1189 },
      LETTER: { widthMm: 215.9, heightMm: 279.4 },
      ANSI_B: { widthMm: 279.4, heightMm: 431.8 },
      ANSI_C: { widthMm: 431.8, heightMm: 558.8 },
      ANSI_D: { widthMm: 558.8, heightMm: 863.6 }
    })
  })

  it('swaps width and height for landscape orientation', () => {
    expect(getPaperDimensions('A3', 'portrait')).toEqual({
      widthMm: 297,
      heightMm: 420
    })
    expect(getPaperDimensions('A3', 'landscape')).toEqual({
      widthMm: 420,
      heightMm: 297
    })
  })

  it.each(SHEET_MATRIX)(
    'computes $paper $orientation in $drawingUnit at 1:$scaleDenominator',
    ({ paper, portrait, orientation, drawingUnit, scaleDenominator }) => {
      const sheet: SheetDefinition = {
        ...BASE_SHEET,
        paper,
        orientation,
        drawingUnit,
        scaleDenominator,
        viewportCenter: { x: 25, y: -10 }
      }
      const layout = computeSheetLayout(sheet, undefined, drawingUnit)
      const expectedPage =
        orientation === 'portrait'
          ? portrait
          : { widthMm: portrait.heightMm, heightMm: portrait.widthMm }
      const expectedMmPerUnit = (drawingUnit === 'm' ? 1000 : 1) / scaleDenominator

      expect(layout.page).toEqual(expectedPage)
      expect(layout.mmPerUnit).toBeCloseTo(expectedMmPerUnit, 12)
      expect(layout.printableArea.width).toBeCloseTo(expectedPage.widthMm - 20)
      expect(layout.printableArea.height).toBeCloseTo(expectedPage.heightMm - 20)
      expect(layout.viewport.width).toBeCloseTo(
        layout.printableArea.width / expectedMmPerUnit,
        10
      )
      expect(layout.viewport.height).toBeCloseTo(
        layout.printableArea.height / expectedMmPerUnit,
        10
      )
      expect(layout.viewport.centerX).toBe(25)
      expect(layout.viewport.centerY).toBe(-10)
      expect(layout.warnings).toEqual([])
    }
  )
})

describe('scale conversion', () => {
  it.each([
    ['m', 100, 10],
    ['m', 200, 5],
    ['m', 500, 2],
    ['mm', 100, 0.01],
    ['mm', 200, 0.005],
    ['mm', 500, 0.002]
  ] as const)(
    'converts %s drawing units at 1:%i to %f paper mm per unit',
    (unit, denominator, expected) => {
      expect(mmPerDrawingUnit(unit, denominator)).toBe(expected)
    }
  )
})

describe('viewport layout', () => {
  it('centers the viewport on the drawing extents', () => {
    const layout = computeSheetLayout(
      BASE_SHEET,
      {
        minX: 100,
        minY: 200,
        maxX: 110,
        maxY: 230
      },
      'm'
    )

    expect(layout.viewport.centerX).toBe(105)
    expect(layout.viewport.centerY).toBe(215)
    expect(
      (layout.viewport.left + layout.viewport.right) / 2
    ).toBe(105)
    expect(
      (layout.viewport.bottom + layout.viewport.top) / 2
    ).toBe(215)
  })

  it('warns instead of rescaling when the drawing does not fit', () => {
    const layout = computeSheetLayout(
      BASE_SHEET,
      {
        minX: 0,
        minY: 0,
        maxX: 100,
        maxY: 100
      },
      'm'
    )

    expect(layout.mmPerUnit).toBe(10)
    expect(layout.viewport.width).toBe(19)
    expect(layout.viewport.height).toBe(27.7)
    expect(layout.warnings).toEqual([
      'Drawing extents do not fit within the printable area at scale 1:100; geometry outside the viewport will be clipped.'
    ])
  })

  it.each([
    {
      unit: 'm' as const,
      extents: { minX: 2, minY: 2, maxX: 166.2, maxY: 116.8 }
    },
    {
      unit: 'mm' as const,
      extents: {
        minX: 2000,
        minY: 2000,
        maxX: 166200,
        maxY: 116800
      }
    }
  ])(
    'fits the exact A1 landscape 10 mm border in $unit at 1:200',
    ({ unit, extents }) => {
      const layout = computeSheetLayout(
        {
          ...BASE_SHEET,
          paper: 'A1',
          orientation: 'landscape',
          marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
          scaleDenominator: 200,
          drawingUnit: unit
        },
        extents,
        unit
      )

      expect(layout.viewport).toMatchObject({
        left: extents.minX,
        bottom: extents.minY,
        right: extents.maxX,
        top: extents.maxY
      })
      expect(layout.unitMismatch).toBe(false)
      expect(layout.clipping).toBe(false)
      expect(layout.warnings).toEqual([])
    }
  )

  it('blocks a millimetre database interpreted as metres with the exact factor', () => {
    const layout = computeSheetLayout(
      {
        ...BASE_SHEET,
        paper: 'A1',
        orientation: 'landscape',
        scaleDenominator: 200,
        drawingUnit: 'm'
      },
      { minX: 2, minY: 2, maxX: 166.2, maxY: 116.8 },
      'mm'
    )

    expect(layout.unitMismatch).toBe(true)
    expect(layout.conversionFactor).toBe(1000)
    expect(layout.warnings[0]).toContain('factor of 1000')
    expect(layout.warnings[0]).toContain('Match database unit')
  })
})
