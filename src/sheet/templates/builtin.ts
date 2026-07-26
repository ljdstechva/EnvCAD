import type { TitleBlockTemplate } from './types'

const TITLE_BLOCK_WIDTH_MM = 180
const TITLE_BLOCK_HEIGHT_MM = 40
const ROW_HEIGHT_MM = 20
const COL_WIDTH_MM = 45
const CELL_PADDING_MM = 3
const VALUE_HEIGHT_MM = 3.2

/** x-range of title block column `index`, counting from the right edge (index 0). */
function column(index: number): { min: number; max: number } {
  return { min: index * COL_WIDTH_MM, max: (index + 1) * COL_WIDTH_MM }
}

function cellAnchorX(colIndex: number): number {
  return column(colIndex).max - CELL_PADDING_MM
}

const sitePlanTemplate: TitleBlockTemplate = {
  id: 'builtin-site-plan',
  name: 'Site Plan — A3/A2/A1 landscape',
  description:
    'Full border with a bottom-right title block, north arrow, and scale bar.',
  supportedPapers: ['A3', 'A2', 'A1'],
  frame: [
    // Outer title block box.
    { x1: 0, y1: 0, x2: TITLE_BLOCK_WIDTH_MM, y2: 0 },
    { x1: TITLE_BLOCK_WIDTH_MM, y1: 0, x2: TITLE_BLOCK_WIDTH_MM, y2: TITLE_BLOCK_HEIGHT_MM },
    { x1: TITLE_BLOCK_WIDTH_MM, y1: TITLE_BLOCK_HEIGHT_MM, x2: 0, y2: TITLE_BLOCK_HEIGHT_MM },
    { x1: 0, y1: TITLE_BLOCK_HEIGHT_MM, x2: 0, y2: 0 },
    // Row divider.
    { x1: 0, y1: ROW_HEIGHT_MM, x2: TITLE_BLOCK_WIDTH_MM, y2: ROW_HEIGHT_MM },
    // Column dividers, bottom row.
    { x1: COL_WIDTH_MM, y1: 0, x2: COL_WIDTH_MM, y2: ROW_HEIGHT_MM },
    { x1: COL_WIDTH_MM * 2, y1: 0, x2: COL_WIDTH_MM * 2, y2: ROW_HEIGHT_MM },
    { x1: COL_WIDTH_MM * 3, y1: 0, x2: COL_WIDTH_MM * 3, y2: ROW_HEIGHT_MM },
    // Column dividers, top row.
    { x1: COL_WIDTH_MM, y1: ROW_HEIGHT_MM, x2: COL_WIDTH_MM, y2: TITLE_BLOCK_HEIGHT_MM },
    { x1: COL_WIDTH_MM * 2, y1: ROW_HEIGHT_MM, x2: COL_WIDTH_MM * 2, y2: TITLE_BLOCK_HEIGHT_MM },
    { x1: COL_WIDTH_MM * 3, y1: ROW_HEIGHT_MM, x2: COL_WIDTH_MM * 3, y2: TITLE_BLOCK_HEIGHT_MM }
  ],
  fields: [
    { key: 'PROJECT', label: 'PROJECT', xMm: cellAnchorX(3), yMm: 5, heightMm: VALUE_HEIGHT_MM, align: 'left', maxWidthMm: COL_WIDTH_MM - CELL_PADDING_MM * 2 },
    { key: 'DRAWING_TITLE', label: 'DRAWING TITLE', xMm: cellAnchorX(2), yMm: 5, heightMm: VALUE_HEIGHT_MM, align: 'left', maxWidthMm: COL_WIDTH_MM - CELL_PADDING_MM * 2 },
    { key: 'CLIENT', label: 'CLIENT', xMm: cellAnchorX(1), yMm: 5, heightMm: VALUE_HEIGHT_MM, align: 'left', maxWidthMm: COL_WIDTH_MM - CELL_PADDING_MM * 2 },
    { key: 'DATE', label: 'DATE', xMm: cellAnchorX(0), yMm: 5, heightMm: VALUE_HEIGHT_MM, align: 'left', maxWidthMm: COL_WIDTH_MM - CELL_PADDING_MM * 2 },
    { key: 'DRAWN_BY', label: 'DRAWN BY', xMm: cellAnchorX(3), yMm: ROW_HEIGHT_MM + 5, heightMm: VALUE_HEIGHT_MM, align: 'left', maxWidthMm: COL_WIDTH_MM - CELL_PADDING_MM * 2 },
    { key: 'CHECKED_BY', label: 'CHECKED BY', xMm: cellAnchorX(2), yMm: ROW_HEIGHT_MM + 5, heightMm: VALUE_HEIGHT_MM, align: 'left', maxWidthMm: COL_WIDTH_MM - CELL_PADDING_MM * 2 },
    { key: 'SCALE', label: 'SCALE', xMm: cellAnchorX(1), yMm: ROW_HEIGHT_MM + 5, heightMm: VALUE_HEIGHT_MM, align: 'left', maxWidthMm: COL_WIDTH_MM - CELL_PADDING_MM * 2 },
    { key: 'SHEET_NO', label: 'SHEET NO', xMm: cellAnchorX(0), yMm: ROW_HEIGHT_MM + 5, heightMm: VALUE_HEIGHT_MM, align: 'left', maxWidthMm: COL_WIDTH_MM - CELL_PADDING_MM * 2 }
  ],
  northArrow: { xMm: 15, yMm: 15, sizeMm: 18 },
  scaleBar: { xMm: 15, yMm: 15, widthMm: 60 }
}

const CAPTION_HEIGHT_MM = 15
const CAPTION_WIDTH_MM = 190
const CAPTION_COL_1_MM = 40
const CAPTION_COL_2_MM = 110

const reportFigureTemplate: TitleBlockTemplate = {
  id: 'builtin-report-figure',
  name: 'Report Figure — A4 portrait',
  description: 'Simple frame with a caption strip: figure number, title, and source.',
  supportedPapers: ['A4'],
  frame: [
    { x1: 0, y1: 0, x2: CAPTION_WIDTH_MM, y2: 0 },
    { x1: CAPTION_WIDTH_MM, y1: 0, x2: CAPTION_WIDTH_MM, y2: CAPTION_HEIGHT_MM },
    { x1: CAPTION_WIDTH_MM, y1: CAPTION_HEIGHT_MM, x2: 0, y2: CAPTION_HEIGHT_MM },
    { x1: 0, y1: CAPTION_HEIGHT_MM, x2: 0, y2: 0 },
    { x1: CAPTION_WIDTH_MM - CAPTION_COL_1_MM, y1: 0, x2: CAPTION_WIDTH_MM - CAPTION_COL_1_MM, y2: CAPTION_HEIGHT_MM },
    { x1: CAPTION_WIDTH_MM - CAPTION_COL_2_MM, y1: 0, x2: CAPTION_WIDTH_MM - CAPTION_COL_2_MM, y2: CAPTION_HEIGHT_MM }
  ],
  fields: [
    { key: 'FIGURE_NO', label: 'FIGURE NO', xMm: CAPTION_WIDTH_MM - CELL_PADDING_MM, yMm: 5, heightMm: VALUE_HEIGHT_MM, align: 'left', maxWidthMm: CAPTION_COL_1_MM - CELL_PADDING_MM * 2 },
    { key: 'TITLE', label: 'TITLE', xMm: CAPTION_WIDTH_MM - CAPTION_COL_1_MM - CELL_PADDING_MM, yMm: 5, heightMm: VALUE_HEIGHT_MM, align: 'left', maxWidthMm: CAPTION_COL_2_MM - CAPTION_COL_1_MM - CELL_PADDING_MM * 2 },
    { key: 'SOURCE', label: 'SOURCE', xMm: CAPTION_WIDTH_MM - CAPTION_COL_2_MM - CELL_PADDING_MM, yMm: 5, heightMm: VALUE_HEIGHT_MM, align: 'left', maxWidthMm: CAPTION_WIDTH_MM - CAPTION_COL_2_MM - CELL_PADDING_MM * 2 }
  ]
}

const blankTemplate: TitleBlockTemplate = {
  id: 'builtin-blank',
  name: 'Blank with border',
  description: 'Only the printable-area border, no title block.',
  supportedPapers: ['A4', 'A3', 'A2', 'A1', 'A0', 'LETTER', 'ANSI_B', 'ANSI_C', 'ANSI_D'],
  frame: [],
  fields: []
}

export const BUILTIN_TEMPLATES: TitleBlockTemplate[] = [
  sitePlanTemplate,
  reportFigureTemplate,
  blankTemplate
]
