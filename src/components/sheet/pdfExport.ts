import { jsPDF } from 'jspdf'
import 'svg2pdf.js'
import { PAPER_SIZES, type SheetDefinition } from '../../sheet/types'

/**
 * Renders the exact same SVG string shown in the live preview to a vector PDF,
 * so the exported file always matches what the user saw on screen.
 */
export async function exportSheetToPdf(svg: string, sheet: SheetDefinition, fileName: string) {
  const base = PAPER_SIZES[sheet.paper]
  const widthMm = sheet.orientation === 'landscape' ? base.heightMm : base.widthMm
  const heightMm = sheet.orientation === 'landscape' ? base.widthMm : base.heightMm

  const parser = new DOMParser()
  const parsed = parser.parseFromString(svg, 'image/svg+xml')
  if (parsed.querySelector('parsererror')) {
    throw new Error('Failed to parse sheet SVG for PDF export')
  }
  const svgEl = parsed.documentElement as unknown as SVGSVGElement

  const pdf = new jsPDF({
    orientation: sheet.orientation === 'landscape' ? 'l' : 'p',
    unit: 'mm',
    format: [widthMm, heightMm]
  })

  await pdf.svg(svgEl, { x: 0, y: 0, width: widthMm, height: heightMm })
  pdf.save(fileName)
}
