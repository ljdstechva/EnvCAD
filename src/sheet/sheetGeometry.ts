import { PAPER_SIZES } from './types'
import type {
  Orientation,
  PaperSizeId,
  SheetDefinition,
  SheetMargins
} from './types'

export interface DrawingExtents {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface PageDimensions {
  widthMm: number
  heightMm: number
}

export interface PrintableArea {
  x: number
  y: number
  width: number
  height: number
}

export interface ModelViewport {
  left: number
  bottom: number
  right: number
  top: number
  width: number
  height: number
  centerX: number
  centerY: number
}

export interface SheetLayout {
  page: PageDimensions
  printableArea: PrintableArea
  mmPerUnit: number
  viewport: ModelViewport
  warnings: string[]
  databaseUnit: 'm' | 'mm' | 'unknown'
  unitMismatch: boolean
  conversionFactor?: number
  clipping: boolean
}

const FIT_EPSILON = 1e-9

export function getPaperDimensions(
  paper: PaperSizeId,
  orientation: Orientation
): PageDimensions {
  const portrait = PAPER_SIZES[paper]
  return orientation === 'portrait'
    ? { ...portrait }
    : { widthMm: portrait.heightMm, heightMm: portrait.widthMm }
}

export function mmPerDrawingUnit(
  drawingUnit: SheetDefinition['drawingUnit'],
  scaleDenominator: number
): number {
  assertPositiveFinite(scaleDenominator, 'scaleDenominator')
  const realMillimetersPerUnit = drawingUnit === 'm' ? 1000 : 1
  return realMillimetersPerUnit / scaleDenominator
}

export function getPrintableArea(
  page: PageDimensions,
  margins: SheetMargins
): PrintableArea {
  for (const [name, value] of Object.entries(margins)) {
    assertNonNegativeFinite(value, `marginsMm.${name}`)
  }

  const width = page.widthMm - margins.left - margins.right
  const height = page.heightMm - margins.top - margins.bottom
  if (width <= 0 || height <= 0) {
    throw new RangeError('Sheet margins must leave a positive printable area.')
  }

  return {
    x: margins.left,
    y: margins.top,
    width,
    height
  }
}

export function computeSheetLayout(
  sheet: SheetDefinition,
  drawingExtents?: DrawingExtents,
  databaseUnit: 'm' | 'mm' | 'unknown' = 'unknown'
): SheetLayout {
  const page = getPaperDimensions(sheet.paper, sheet.orientation)
  const printableArea = getPrintableArea(page, sheet.marginsMm)
  const mmPerUnit = mmPerDrawingUnit(
    sheet.drawingUnit,
    sheet.scaleDenominator
  )
  const extents = isValidDrawingExtents(drawingExtents)
    ? drawingExtents
    : undefined

  const warnings: string[] = []
  const unitMismatch =
    databaseUnit !== 'unknown' && databaseUnit !== sheet.drawingUnit
  const conversionFactor = unitMismatch
    ? databaseUnit === 'mm' && sheet.drawingUnit === 'm'
      ? 1000
      : 0.001
    : undefined
  if (unitMismatch) {
    warnings.push(
      `Database units are ${databaseUnit}; Sheet Preview is configured as ${
        sheet.drawingUnit
      }. The interpretation differs by a factor of ${formatNumber(
        conversionFactor!
      )}. Use Match database unit before previewing or exporting.`
    )
  } else if (databaseUnit === 'unknown') {
    warnings.push(
      'Database units are unknown; verify units before relying on sheet scale.'
    )
  }
  let centerX: number
  let centerY: number

  if (sheet.viewportCenter === 'extents') {
    if (extents) {
      centerX = (extents.minX + extents.maxX) / 2
      centerY = (extents.minY + extents.maxY) / 2
    } else {
      centerX = 0
      centerY = 0
      warnings.push(
        'Drawing extents are unavailable; the viewport is centered at the origin.'
      )
    }
  } else {
    assertFinite(sheet.viewportCenter.x, 'viewportCenter.x')
    assertFinite(sheet.viewportCenter.y, 'viewportCenter.y')
    centerX = sheet.viewportCenter.x
    centerY = sheet.viewportCenter.y
  }

  const width = printableArea.width / mmPerUnit
  const height = printableArea.height / mmPerUnit
  const viewport: ModelViewport = {
    left: centerX - width / 2,
    bottom: centerY - height / 2,
    right: centerX + width / 2,
    top: centerY + height / 2,
    width,
    height,
    centerX,
    centerY
  }

  const clipping = Boolean(extents && !containsExtents(viewport, extents))
  if (clipping) {
    warnings.push(
      `Drawing extents do not fit within the printable area at scale 1:${formatNumber(
        sheet.scaleDenominator
      )}; geometry outside the viewport will be clipped.`
    )
  }

  return {
    page,
    printableArea,
    mmPerUnit,
    viewport,
    warnings,
    databaseUnit,
    unitMismatch,
    conversionFactor,
    clipping
  }
}

export function isValidDrawingExtents(
  extents: DrawingExtents | undefined
): extents is DrawingExtents {
  return (
    !!extents &&
    Number.isFinite(extents.minX) &&
    Number.isFinite(extents.minY) &&
    Number.isFinite(extents.maxX) &&
    Number.isFinite(extents.maxY) &&
    extents.minX <= extents.maxX &&
    extents.minY <= extents.maxY
  )
}

function containsExtents(
  viewport: ModelViewport,
  extents: DrawingExtents
): boolean {
  return (
    extents.minX >= viewport.left - FIT_EPSILON &&
    extents.maxX <= viewport.right + FIT_EPSILON &&
    extents.minY >= viewport.bottom - FIT_EPSILON &&
    extents.maxY <= viewport.top + FIT_EPSILON
  )
}

function assertPositiveFinite(value: number, name: string): void {
  assertFinite(value, name)
  if (value <= 0) {
    throw new RangeError(`${name} must be greater than zero.`)
  }
}

function assertNonNegativeFinite(value: number, name: string): void {
  assertFinite(value, name)
  if (value < 0) {
    throw new RangeError(`${name} must not be negative.`)
  }
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be a finite number.`)
  }
}

function formatNumber(value: number): string {
  return Object.is(value, -0) ? '0' : String(value)
}
