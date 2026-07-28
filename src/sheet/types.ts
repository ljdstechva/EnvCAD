export type PaperSizeId =
  | 'A4'
  | 'A3'
  | 'A2'
  | 'A1'
  | 'A0'
  | 'LETTER'
  | 'ANSI_B'
  | 'ANSI_C'
  | 'ANSI_D'

/** Portrait dimensions in millimeters (width x height). */
export const PAPER_SIZES: Record<PaperSizeId, { widthMm: number; heightMm: number }> = {
  A4: { widthMm: 210, heightMm: 297 },
  A3: { widthMm: 297, heightMm: 420 },
  A2: { widthMm: 420, heightMm: 594 },
  A1: { widthMm: 594, heightMm: 841 },
  A0: { widthMm: 841, heightMm: 1189 },
  LETTER: { widthMm: 215.9, heightMm: 279.4 },
  ANSI_B: { widthMm: 279.4, heightMm: 431.8 },
  ANSI_C: { widthMm: 431.8, heightMm: 558.8 },
  ANSI_D: { widthMm: 558.8, heightMm: 863.6 }
}

export type Orientation = 'portrait' | 'landscape'

export interface SheetMargins {
  top: number
  right: number
  bottom: number
  left: number
}

export interface SheetDefinition {
  paper: PaperSizeId
  orientation: Orientation
  marginsMm: SheetMargins
  /** Denominator of the drawing scale, e.g. 200 means a scale of 1:200. */
  scaleDenominator: number
  drawingUnit: 'm' | 'mm'
  viewportCenter: { x: number; y: number } | 'extents'
  templateId?: string
  fields?: Record<string, string>
  /** Rotation of the north arrow in degrees, clockwise from up. */
  northRotationDeg?: number
}

export interface SheetRenderResult {
  svg: string
  warnings: string[]
  diagnostics: SheetRenderDiagnostics
}

export interface SheetRenderDiagnostics {
  entityCount: number
  visibleEntityCount: number
  drawableElementCount: number
  drawingExtents?: {
    minX: number
    minY: number
    maxX: number
    maxY: number
  }
  databaseUnit: 'm' | 'mm' | 'unknown'
  sheetDrawingUnit: 'm' | 'mm'
  unitMismatch: boolean
  conversionFactor?: number
  clipping: boolean
  trueWhiteEntityCount: number
}

export interface SheetRenderer {
  render(doc: unknown, sheet: SheetDefinition): Promise<SheetRenderResult>
}
