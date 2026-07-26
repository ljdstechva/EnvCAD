import { mmPerDrawingUnit } from '../sheetGeometry'
import type { SheetDefinition } from '../types'

export interface ScaleBarLayout {
  /** Real-world distance represented by each segment, in drawingUnit. */
  segmentValue: number
  /** Number of equal segments in the bar. */
  segmentCount: number
  /** Paper-mm width of a single segment. */
  segmentWidthMm: number
  /** Total paper-mm width of the whole bar. */
  totalWidthMm: number
  /** Cumulative label at each tick, e.g. [0, 5, 10, 15, 20]. */
  labels: number[]
  unit: SheetDefinition['drawingUnit']
}

/**
 * Rounds down to the nearest "nice" cartographic number: a mantissa of
 * 1, 2, or 5 times a power of ten. The result is always <= value, so a bar
 * built from it never exceeds the width it was asked to fit within.
 */
export function niceRoundNumber(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  const exponent = Math.floor(Math.log10(value))
  const fraction = value / 10 ** exponent
  let niceFraction: number
  if (fraction < 2) niceFraction = 1
  else if (fraction < 5) niceFraction = 2
  else niceFraction = 5
  return niceFraction * 10 ** exponent
}

/**
 * Computes a scale bar's segment distances and paper widths so its printed
 * labels are mathematically correct at the drawing's scale.
 */
export function computeScaleBarLayout(
  targetWidthMm: number,
  scaleDenominator: number,
  drawingUnit: SheetDefinition['drawingUnit'],
  segmentCount = 4
): ScaleBarLayout {
  const mmPerUnit = mmPerDrawingUnit(drawingUnit, scaleDenominator)
  const maxRealDistance = targetWidthMm / mmPerUnit
  const roughSegment = maxRealDistance / segmentCount
  const segmentValue = niceRoundNumber(roughSegment)
  const segmentWidthMm = segmentValue * mmPerUnit
  const totalWidthMm = segmentWidthMm * segmentCount
  const labels = Array.from(
    { length: segmentCount + 1 },
    (_, index) => index * segmentValue
  )

  return {
    segmentValue,
    segmentCount,
    segmentWidthMm,
    totalWidthMm,
    labels,
    unit: drawingUnit
  }
}
