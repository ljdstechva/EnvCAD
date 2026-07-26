import { AcSvgRenderer } from '@mlightcad/cad-svg-plugin'
import { AcApSettingManager } from '@mlightcad/cad-simple-viewer'

import {
  computeSheetLayout,
  isValidDrawingExtents
} from './sheetGeometry'
import type {
  DrawingExtents,
  SheetLayout
} from './sheetGeometry'
import { getTemplateById } from './templates/registry'
import { renderTitleBlockOverlay } from './templates/renderTitleBlock'
import type {
  SheetDefinition,
  SheetRenderer,
  SheetRenderResult
} from './types'

interface PointLike {
  x: number
  y: number
}

interface BoxLike {
  min?: PointLike
  max?: PointLike
  minPoint?: PointLike
  maxPoint?: PointLike
}

interface CadEntityLike {
  geometricExtents?: BoxLike
  worldDraw(renderer: AcSvgRenderer): unknown
}

interface CadDatabaseLike {
  tables: {
    blockTable: {
      modelSpace: {
        newIterator(): Iterable<CadEntityLike>
      }
    }
  }
  extents?: BoxLike
  extmin?: PointLike
  extmax?: PointLike
  ltscale?: number
  celtscale?: number
  lwdisplay?: boolean
}

interface CadDocumentLike {
  database: CadDatabaseLike
}

const CLIP_PATH_ID = 'envcad-sheet-printable-clip'

export class CadSheetRenderer implements SheetRenderer {
  async render(
    doc: unknown,
    sheet: SheetDefinition
  ): Promise<SheetRenderResult> {
    const cadDoc = asCadDocument(doc)
    const entities = Array.from(
      cadDoc.database.tables.blockTable.modelSpace.newIterator()
    )
    const extents = resolveDrawingExtents(cadDoc.database, entities)
    const layout = computeSheetLayout(sheet, extents)
    const drawingSvg = await renderModelSpace(cadDoc.database, entities)

    return {
      svg: composePageSvg(drawingSvg, layout, sheet),
      warnings: layout.warnings
    }
  }
}

export const sheetRenderer: SheetRenderer = new CadSheetRenderer()

export function renderSheet(
  doc: unknown,
  sheet: SheetDefinition
): Promise<SheetRenderResult> {
  return sheetRenderer.render(doc, sheet)
}

export default sheetRenderer

async function renderModelSpace(
  database: CadDatabaseLike,
  entities: CadEntityLike[]
): Promise<string> {
  AcSvgRenderer.prepareExport()
  const renderer = new AcSvgRenderer()

  renderer.ltscale = finiteOrDefault(database.ltscale, 1)
  renderer.celtscale = finiteOrDefault(database.celtscale, 1)
  renderer.showLineWeight = !!database.lwdisplay
  renderer.setFontMapping(AcApSettingManager.instance.fontMapping)
  renderer.currentBackgroundColor = 0xffffff
  renderer.changeForeground(0x000000)

  return renderEntitiesInDeterministicOrder(renderer, entities)
}

async function renderEntitiesInDeterministicOrder(
  renderer: AcSvgRenderer,
  entities: CadEntityLike[]
): Promise<string> {
  const originalImage = renderer.image.bind(renderer)
  const imagePlaceholder = renderer.group([])
  const queuedImages: Array<Parameters<AcSvgRenderer['image']>> = []

  // AcSvgRenderer normally appends raster images when each asynchronous decode
  // finishes, which can vary their order. Capture calls during synchronous
  // worldDraw traversal, then resolve them serially in that same stable order.
  renderer.image = (...args) => {
    queuedImages.push(args)
    return imagePlaceholder
  }

  try {
    for (const entity of entities) {
      entity.worldDraw(renderer)
    }

    for (const imageArgs of queuedImages) {
      originalImage(...imageArgs)
      await renderer.exportAsync()
    }

    return renderer.exportAsync()
  } finally {
    renderer.image = originalImage
  }
}

function composePageSvg(
  drawingSvg: string,
  layout: SheetLayout,
  sheet: SheetDefinition
): string {
  const { page, printableArea, viewport } = layout
  const drawingBody = extractSvgBody(drawingSvg)
  const pageWidth = formatNumber(page.widthMm)
  const pageHeight = formatNumber(page.heightMm)
  const printableX = formatNumber(printableArea.x)
  const printableY = formatNumber(printableArea.y)
  const printableWidth = formatNumber(printableArea.width)
  const printableHeight = formatNumber(printableArea.height)
  const viewBoxX = formatNumber(viewport.left)
  const viewBoxY = formatNumber(-viewport.top)
  const viewBoxWidth = formatNumber(viewport.width)
  const viewBoxHeight = formatNumber(viewport.height)
  const template = getTemplateById(sheet.templateId)
  const titleBlockSvg = template
    ? renderTitleBlockOverlay(sheet, template, printableArea)
    : ''

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1"
  width="${pageWidth}mm" height="${pageHeight}mm" viewBox="0 0 ${pageWidth} ${pageHeight}">
  <defs>
    <clipPath id="${CLIP_PATH_ID}">
      <rect x="${printableX}" y="${printableY}" width="${printableWidth}" height="${printableHeight}"/>
    </clipPath>
  </defs>
  <rect x="0" y="0" width="${pageWidth}" height="${pageHeight}" fill="#ffffff"/>
  <g clip-path="url(#${CLIP_PATH_ID})">
    <svg x="${printableX}" y="${printableY}" width="${printableWidth}" height="${printableHeight}"
      viewBox="${viewBoxX} ${viewBoxY} ${viewBoxWidth} ${viewBoxHeight}"
      preserveAspectRatio="none" overflow="hidden">
${indent(drawingBody, 6)}
    </svg>
  </g>
  <rect x="${printableX}" y="${printableY}" width="${printableWidth}" height="${printableHeight}"
    fill="none" stroke="#000000" stroke-width="0.2"/>
${indent(titleBlockSvg, 2)}
</svg>`
}

function extractSvgBody(svg: string): string {
  const rootStart = svg.search(/<svg(?:\s|>)/i)
  if (rootStart < 0) {
    throw new Error('AcSvgRenderer returned markup without an SVG root element.')
  }

  const openingEnd = findOpeningTagEnd(svg, rootStart)
  const closingStart = svg.toLowerCase().lastIndexOf('</svg>')
  if (openingEnd < 0 || closingStart < openingEnd) {
    throw new Error('AcSvgRenderer returned malformed SVG markup.')
  }

  return svg.slice(openingEnd + 1, closingStart).trim()
}

function findOpeningTagEnd(svg: string, start: number): number {
  let quote: '"' | "'" | undefined
  for (let index = start; index < svg.length; index += 1) {
    const char = svg[index]
    if (quote) {
      if (char === quote) quote = undefined
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '>') {
      return index
    }
  }
  return -1
}

function resolveDrawingExtents(
  database: CadDatabaseLike,
  entities: CadEntityLike[]
): DrawingExtents | undefined {
  const databaseExtents =
    boxToDrawingExtents(database.extents) ??
    pointsToDrawingExtents(database.extmin, database.extmax)
  if (databaseExtents) return databaseExtents

  let combined: DrawingExtents | undefined
  for (const entity of entities) {
    const entityExtents = boxToDrawingExtents(entity.geometricExtents)
    if (!entityExtents) continue
    combined = combined
      ? {
          minX: Math.min(combined.minX, entityExtents.minX),
          minY: Math.min(combined.minY, entityExtents.minY),
          maxX: Math.max(combined.maxX, entityExtents.maxX),
          maxY: Math.max(combined.maxY, entityExtents.maxY)
        }
      : entityExtents
  }
  return combined
}

function boxToDrawingExtents(
  box: BoxLike | undefined
): DrawingExtents | undefined {
  if (!box) return undefined
  return pointsToDrawingExtents(
    box.min ?? box.minPoint,
    box.max ?? box.maxPoint
  )
}

function pointsToDrawingExtents(
  min: PointLike | undefined,
  max: PointLike | undefined
): DrawingExtents | undefined {
  if (!min || !max) return undefined
  const extents: DrawingExtents = {
    minX: min.x,
    minY: min.y,
    maxX: max.x,
    maxY: max.y
  }
  return isValidDrawingExtents(extents) ? extents : undefined
}

function asCadDocument(doc: unknown): CadDocumentLike {
  if (!doc || typeof doc !== 'object' || !('database' in doc)) {
    throw new TypeError('SheetRenderer requires a CAD document with a database.')
  }

  const candidate = doc as Partial<CadDocumentLike>
  const iterator =
    candidate.database?.tables?.blockTable?.modelSpace?.newIterator
  if (typeof iterator !== 'function') {
    throw new TypeError(
      'SheetRenderer requires database.tables.blockTable.modelSpace.'
    )
  }
  return candidate as CadDocumentLike
}

function finiteOrDefault(
  value: number | undefined,
  defaultValue: number
): number {
  return Number.isFinite(value) ? (value as number) : defaultValue
}

function indent(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces)
  return value
    .split('\n')
    .map(line => `${prefix}${line}`)
    .join('\n')
}

function formatNumber(value: number): string {
  return Object.is(value, -0) ? '0' : String(value)
}
