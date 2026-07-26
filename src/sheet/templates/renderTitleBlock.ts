import type { PrintableArea } from '../sheetGeometry'
import type { SheetDefinition } from '../types'
import { computeScaleBarLayout } from './scaleBar'
import type {
  FieldAlign,
  TitleBlockField,
  TitleBlockNorthArrow,
  TitleBlockScaleBar,
  TitleBlockTemplate
} from './types'

const LABEL_HEIGHT_RATIO = 0.55
const LABEL_GAP_RATIO = 1.6
const CHAR_WIDTH_RATIO = 0.6

/** Renders a template's frame, fields, north arrow, and scale bar as an SVG group. */
export function renderTitleBlockOverlay(
  sheet: SheetDefinition,
  template: TitleBlockTemplate,
  printableArea: PrintableArea
): string {
  const parts: string[] = []

  if (template.frame.length > 0) {
    parts.push(renderFrame(template, printableArea))
  }
  if (template.fields.length > 0) {
    parts.push(renderFields(sheet, template, printableArea))
  }
  if (template.northArrow) {
    parts.push(renderNorthArrow(sheet, template.northArrow, printableArea))
  }
  if (template.scaleBar) {
    parts.push(renderScaleBar(sheet, template.scaleBar, printableArea))
  }

  return `<g class="envcad-title-block">\n${parts.filter(Boolean).join('\n')}\n</g>`
}

/** xMm/yMm anchored to the printable area's bottom-right corner. */
function fromBottomRight(
  printableArea: PrintableArea,
  xMm: number,
  yMm: number
): { x: number; y: number } {
  return {
    x: printableArea.x + printableArea.width - xMm,
    y: printableArea.y + printableArea.height - yMm
  }
}

/** xMm/yMm anchored to the printable area's top-right corner. */
function fromTopRight(
  printableArea: PrintableArea,
  xMm: number,
  yMm: number
): { x: number; y: number } {
  return {
    x: printableArea.x + printableArea.width - xMm,
    y: printableArea.y + yMm
  }
}

/** xMm/yMm anchored to the printable area's bottom-left corner. */
function fromBottomLeft(
  printableArea: PrintableArea,
  xMm: number,
  yMm: number
): { x: number; y: number } {
  return {
    x: printableArea.x + xMm,
    y: printableArea.y + printableArea.height - yMm
  }
}

function renderFrame(template: TitleBlockTemplate, printableArea: PrintableArea): string {
  const lines = template.frame.map(segment => {
    const p1 = fromBottomRight(printableArea, segment.x1, segment.y1)
    const p2 = fromBottomRight(printableArea, segment.x2, segment.y2)
    return `<line x1="${fmt(p1.x)}" y1="${fmt(p1.y)}" x2="${fmt(p2.x)}" y2="${fmt(p2.y)}" stroke="#000000" stroke-width="0.25"/>`
  })
  return `<g class="envcad-title-block-frame">\n${lines.join('\n')}\n</g>`
}

function renderFields(
  sheet: SheetDefinition,
  template: TitleBlockTemplate,
  printableArea: PrintableArea
): string {
  const texts = template.fields.map(field => renderField(sheet, field, printableArea))
  return `<g class="envcad-title-block-fields">\n${texts.join('\n')}\n</g>`
}

function resolveFieldValue(sheet: SheetDefinition, field: TitleBlockField): string {
  if (field.key === 'SCALE') {
    return `1:${sheet.scaleDenominator}`
  }
  return sheet.fields?.[field.key] ?? ''
}

function renderField(
  sheet: SheetDefinition,
  field: TitleBlockField,
  printableArea: PrintableArea
): string {
  const anchor = fromBottomRight(printableArea, field.xMm, field.yMm)
  const textAnchor = textAnchorFor(field.align)
  const labelFontSize = field.heightMm * LABEL_HEIGHT_RATIO
  const labelY = anchor.y - field.heightMm * LABEL_GAP_RATIO

  const label = `<text x="${fmt(anchor.x)}" y="${fmt(labelY)}" font-size="${fmt(labelFontSize)}" text-anchor="${textAnchor}" font-family="sans-serif" fill="#666666">${escapeXml(field.label)}</text>`

  const value = resolveFieldValue(sheet, field)
  if (!value) return label

  const lengthAttrs = fitTextAttrs(value, field)
  const valueText = `<text x="${fmt(anchor.x)}" y="${fmt(anchor.y)}" font-size="${fmt(field.heightMm)}" text-anchor="${textAnchor}" font-family="sans-serif" fill="#000000"${lengthAttrs}>${escapeXml(value)}</text>`

  return `${label}\n${valueText}`
}

function fitTextAttrs(value: string, field: TitleBlockField): string {
  if (!field.maxWidthMm) return ''
  const estimatedWidth = value.length * field.heightMm * CHAR_WIDTH_RATIO
  if (estimatedWidth <= field.maxWidthMm) return ''
  return ` textLength="${fmt(field.maxWidthMm)}" lengthAdjust="spacingAndGlyphs"`
}

function textAnchorFor(align: FieldAlign): 'start' | 'middle' | 'end' {
  if (align === 'right') return 'end'
  if (align === 'center') return 'middle'
  return 'start'
}

function renderNorthArrow(
  sheet: SheetDefinition,
  northArrow: TitleBlockNorthArrow,
  printableArea: PrintableArea
): string {
  const origin = fromTopRight(printableArea, northArrow.xMm, northArrow.yMm)
  const size = northArrow.sizeMm
  const rotation = sheet.northRotationDeg ?? 0
  const half = size / 2
  const tailHalf = size * 0.28

  return `<g class="envcad-title-block-north" transform="translate(${fmt(origin.x)} ${fmt(origin.y)}) rotate(${fmt(rotation)})">
  <polygon points="0,${fmt(-half)} ${fmt(tailHalf)},${fmt(half)} 0,${fmt(tailHalf)} ${fmt(-tailHalf)},${fmt(half)}" fill="#000000" stroke="#000000" stroke-width="0.15"/>
  <text x="0" y="${fmt(-half - 1.5)}" font-size="${fmt(size * 0.22)}" text-anchor="middle" font-family="sans-serif" fill="#000000">N</text>
</g>`
}

function renderScaleBar(
  sheet: SheetDefinition,
  scaleBar: TitleBlockScaleBar,
  printableArea: PrintableArea
): string {
  const layout = computeScaleBarLayout(
    scaleBar.widthMm,
    sheet.scaleDenominator,
    sheet.drawingUnit
  )
  const origin = fromBottomLeft(printableArea, scaleBar.xMm, scaleBar.yMm)
  const barHeightMm = 3
  const unitLabel = sheet.drawingUnit === 'm' ? 'm' : 'mm'

  const segments: string[] = []
  for (let i = 0; i < layout.segmentCount; i += 1) {
    const x = origin.x + i * layout.segmentWidthMm
    const fill = i % 2 === 0 ? '#000000' : '#ffffff'
    segments.push(
      `<rect x="${fmt(x)}" y="${fmt(origin.y - barHeightMm)}" width="${fmt(layout.segmentWidthMm)}" height="${fmt(barHeightMm)}" fill="${fill}" stroke="#000000" stroke-width="0.2"/>`
    )
  }

  const labels: string[] = []
  for (let i = 0; i <= layout.segmentCount; i += 1) {
    const x = origin.x + i * layout.segmentWidthMm
    const isLast = i === layout.segmentCount
    const text = `${formatLabel(layout.labels[i])}${isLast ? ` ${unitLabel}` : ''}`
    labels.push(
      `<text x="${fmt(x)}" y="${fmt(origin.y + 4)}" font-size="2.6" text-anchor="middle" font-family="sans-serif" fill="#000000">${escapeXml(text)}</text>`
    )
  }

  return `<g class="envcad-title-block-scale-bar">\n${segments.join('\n')}\n${labels.join('\n')}\n</g>`
}

function formatLabel(value: number): string {
  return fmt(Math.round(value * 1000) / 1000)
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function fmt(value: number): string {
  return Object.is(value, -0) ? '0' : String(value)
}
