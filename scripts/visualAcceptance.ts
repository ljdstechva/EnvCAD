import type {
  VisualFixtureExpectation,
  VisualMarkerColor,
  VisualMarkerQuadrant,
  VisualMarkerShape
} from './visualFixtures'

export interface VisualModelAnswer {
  blank: boolean
  orientation: 'portrait' | 'landscape'
  markers: Array<{
    color: VisualMarkerColor
    shape: VisualMarkerShape
    quadrant: VisualMarkerQuadrant
  }>
  borderVisible: boolean
  titleBlockVisible: boolean
  clipping: boolean
  overlap: boolean
}

export const HIDDEN_MARKER_PROMPT = [
  'Call inspect_sheet_preview exactly once with view "full".',
  'Use only inspect_sheet_preview. Do not call drawing-context, entity, geometry, selection, page-setup, edit, fit, or any other CAD tool.',
  'Judge the image itself, not counts, diagnostics, hashes, or other metadata.',
  'Return only one valid JSON object with exactly these fields:',
  '{"blank":boolean,"orientation":"portrait|landscape","markers":[{"color":"lowercase common color","shape":"circle|square|triangle","quadrant":"top-left|top-right|bottom-left|bottom-right"}],"borderVisible":boolean,"titleBlockVisible":boolean,"clipping":boolean,"overlap":boolean}',
  'List every large colored marker visible on the page. Do not include explanations or Markdown.'
].join('\n')

export const STRUCTURE_ONLY_PROMPT = [
  'Call inspect_sheet_preview exactly once with view "full".',
  'Use only inspect_sheet_preview and judge the image itself.',
  'Return only one valid JSON object with exactly these fields:',
  '{"blank":boolean,"orientation":"portrait|landscape","markers":[{"color":"lowercase common color","shape":"circle|square|triangle","quadrant":"top-left|top-right|bottom-left|bottom-right"}],"borderVisible":boolean,"titleBlockVisible":boolean,"clipping":boolean,"overlap":boolean}',
  'Do not include explanations or Markdown.'
].join('\n')

const COLORS = new Set<VisualMarkerColor>([
  'red',
  'yellow',
  'green',
  'cyan',
  'blue',
  'magenta'
])
const SHAPES = new Set<VisualMarkerShape>([
  'circle',
  'square',
  'triangle'
])
const QUADRANTS = new Set<VisualMarkerQuadrant>([
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right'
])

export function parseVisualModelAnswer(text: string): VisualModelAnswer {
  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    throw new Error('The model response did not contain a JSON object.')
  }
  let value: unknown
  try {
    value = JSON.parse(text.slice(firstBrace, lastBrace + 1))
  } catch (error) {
    throw new Error(
      `The model response JSON was invalid: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The model response JSON must be an object.')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const expectedKeys = [
    'blank',
    'borderVisible',
    'clipping',
    'markers',
    'orientation',
    'overlap',
    'titleBlockVisible'
  ]
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error('The model response JSON had missing or unsupported fields.')
  }
  if (
    typeof record.blank !== 'boolean' ||
    typeof record.borderVisible !== 'boolean' ||
    typeof record.titleBlockVisible !== 'boolean' ||
    typeof record.clipping !== 'boolean' ||
    typeof record.overlap !== 'boolean' ||
    (record.orientation !== 'portrait' &&
      record.orientation !== 'landscape') ||
    !Array.isArray(record.markers)
  ) {
    throw new Error('The model response JSON contained invalid field types.')
  }
  const markers = record.markers.map((marker, index) => {
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
      throw new Error(`Marker ${index + 1} was not an object.`)
    }
    const item = marker as Record<string, unknown>
    if (
      JSON.stringify(Object.keys(item).sort()) !==
        JSON.stringify(['color', 'quadrant', 'shape']) ||
      typeof item.color !== 'string' ||
      !COLORS.has(item.color as VisualMarkerColor) ||
      typeof item.shape !== 'string' ||
      !SHAPES.has(item.shape as VisualMarkerShape) ||
      typeof item.quadrant !== 'string' ||
      !QUADRANTS.has(item.quadrant as VisualMarkerQuadrant)
    ) {
      throw new Error(`Marker ${index + 1} had invalid fields or values.`)
    }
    return {
      color: item.color as VisualMarkerColor,
      shape: item.shape as VisualMarkerShape,
      quadrant: item.quadrant as VisualMarkerQuadrant
    }
  })
  return {
    blank: record.blank,
    orientation: record.orientation,
    markers,
    borderVisible: record.borderVisible,
    titleBlockVisible: record.titleBlockVisible,
    clipping: record.clipping,
    overlap: record.overlap
  }
}

export function compareVisualAnswer(
  answer: VisualModelAnswer,
  expected: VisualFixtureExpectation,
  options: { requireMarkers?: boolean } = {}
): string[] {
  const issues: string[] = []
  if (answer.blank !== expected.blank) {
    issues.push(`blank=${answer.blank}, expected ${expected.blank}`)
  }
  if (answer.orientation !== expected.orientation) {
    issues.push(
      `orientation=${answer.orientation}, expected ${expected.orientation}`
    )
  }
  if (answer.borderVisible !== expected.borderVisible) {
    issues.push(
      `borderVisible=${answer.borderVisible}, expected ${expected.borderVisible}`
    )
  }
  if (answer.titleBlockVisible !== expected.titleBlockVisible) {
    issues.push(
      `titleBlockVisible=${answer.titleBlockVisible}, expected ${expected.titleBlockVisible}`
    )
  }
  if (answer.clipping !== expected.clipping) {
    issues.push(`clipping=${answer.clipping}, expected ${expected.clipping}`)
  }
  if (answer.overlap !== expected.overlap) {
    issues.push(`overlap=${answer.overlap}, expected ${expected.overlap}`)
  }
  if (options.requireMarkers !== false) {
    const actualMarkers = answer.markers.map(markerKey).sort()
    const expectedMarkers = expected.markers.map(markerKey).sort()
    if (JSON.stringify(actualMarkers) !== JSON.stringify(expectedMarkers)) {
      issues.push(
        `markers=${JSON.stringify(actualMarkers)}, expected ${JSON.stringify(
          expectedMarkers
        )}`
      )
    }
  }
  return issues
}

function markerKey(marker: {
  color: string
  shape: string
  quadrant: string
}): string {
  return `${marker.quadrant}:${marker.color}:${marker.shape}`
}
