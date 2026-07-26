import type { PaperSizeId } from '../types'

export type FieldAlign = 'left' | 'center' | 'right'

/**
 * A single labeled value drawn in the title block.
 *
 * xMm/yMm are the anchor point in the same bottom-right-anchored coordinate
 * system as the template's `frame` (see TitleBlockTemplate). heightMm is the
 * value text's font size in mm; the field label is drawn smaller, just above
 * the value. maxWidthMm, if set, clips the rendered text to that width.
 */
export interface TitleBlockField {
  key: string
  label: string
  xMm: number
  yMm: number
  heightMm: number
  align: FieldAlign
  maxWidthMm?: number
}

export interface TitleBlockLineSegment {
  x1: number
  y1: number
  x2: number
  y2: number
}

/**
 * Position relative to the printable area's top-right corner: xMm is the
 * distance left from the right edge, yMm is the distance down from the top
 * edge. Anchoring to this corner keeps the arrow's placement independent of
 * paper size.
 */
export interface TitleBlockNorthArrow {
  xMm: number
  yMm: number
  sizeMm: number
}

/**
 * Position relative to the printable area's bottom-left corner: xMm is the
 * distance right from the left edge, yMm is the distance up from the bottom
 * edge. widthMm is a target width; the rendered bar uses the nearest "nice"
 * round distance that fits within it at the sheet's scale.
 */
export interface TitleBlockScaleBar {
  xMm: number
  yMm: number
  widthMm: number
}

/**
 * A reusable title-block layout.
 *
 * `frame` and `fields` are positioned in a coordinate system anchored to the
 * printable area's bottom-right corner: xMm is the distance left from the
 * right edge, yMm is the distance up from the bottom edge. Anchoring here
 * (rather than to absolute page coordinates) lets the same title-block size
 * apply unchanged across every paper size the template supports.
 */
export interface TitleBlockTemplate {
  id: string
  name: string
  description: string
  supportedPapers: PaperSizeId[]
  frame: TitleBlockLineSegment[]
  fields: TitleBlockField[]
  northArrow?: TitleBlockNorthArrow
  scaleBar?: TitleBlockScaleBar
}
