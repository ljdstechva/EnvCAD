import type { Point2D } from './geometry'

export interface ParsedGeoJsonPoint {
  kind: 'point'
  point: Point2D
  featureIndex: number
}

export interface ParsedGeoJsonPolyline {
  kind: 'polyline'
  points: Point2D[]
  closed: boolean
  featureIndex: number
  ringIndex?: number
}

export type ParsedGeoJsonGeometry = ParsedGeoJsonPoint | ParsedGeoJsonPolyline

function csvCells(line: string): string[] {
  const cells: string[] = []
  let value = ''
  let quoted = false
  for (let index = 0; index < line.length; index++) {
    const character = line[index]
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (character === ',' && !quoted) {
      cells.push(value.trim())
      value = ''
    } else {
      value += character
    }
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field')
  cells.push(value.trim())
  return cells
}

function csvCoordinate(value: string, row: number, axis: 'x' | 'y'): number {
  const coordinate = Number(value)
  if (!Number.isFinite(coordinate)) {
    throw new Error(`CSV row ${row} has an invalid ${axis} coordinate: ${value}`)
  }
  return coordinate
}

/** Parses x,y rows with an optional x,y header and ignores blank lines. */
export function parseBoundaryCsv(csvText: string): Point2D[] {
  const lines = csvText
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) throw new Error('CSV contains no coordinate rows')

  const rows = lines.map(csvCells)
  const header =
    rows[0].length >= 2 &&
    rows[0][0].trim().toLowerCase() === 'x' &&
    rows[0][1].trim().toLowerCase() === 'y'
  const dataRows = header ? rows.slice(1) : rows
  if (dataRows.length < 3) throw new Error('CSV boundary must contain at least three points')

  return dataRows.map((row, index) => {
    const displayRow = index + (header ? 2 : 1)
    if (row.length !== 2) {
      throw new Error(`CSV row ${displayRow} must contain exactly two columns: x,y`)
    }
    return {
      x: csvCoordinate(row[0], displayRow, 'x'),
      y: csvCoordinate(row[1], displayRow, 'y')
    }
  })
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function coordinatePair(value: unknown, field: string): Point2D {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    typeof value[0] !== 'number' ||
    !Number.isFinite(value[0]) ||
    typeof value[1] !== 'number' ||
    !Number.isFinite(value[1])
  ) {
    throw new Error(`${field} must be a finite [x, y] coordinate`)
  }
  return { x: value[0], y: value[1] }
}

function coordinateLine(value: unknown, field: string, minimum: number): Point2D[] {
  if (!Array.isArray(value) || value.length < minimum) {
    throw new Error(`${field} must contain at least ${minimum} coordinates`)
  }
  return value.map((coordinate, index) => coordinatePair(coordinate, `${field}[${index}]`))
}

function parseGeometry(
  value: unknown,
  featureIndex: number
): ParsedGeoJsonGeometry[] {
  const geometry = record(value, `feature ${featureIndex + 1} geometry`)
  if (geometry.type === 'Point') {
    return [
      {
        kind: 'point',
        point: coordinatePair(
          geometry.coordinates,
          `feature ${featureIndex + 1} Point coordinates`
        ),
        featureIndex
      }
    ]
  }
  if (geometry.type === 'LineString') {
    return [
      {
        kind: 'polyline',
        points: coordinateLine(
          geometry.coordinates,
          `feature ${featureIndex + 1} LineString coordinates`,
          2
        ),
        closed: false,
        featureIndex
      }
    ]
  }
  if (geometry.type === 'Polygon') {
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) {
      throw new Error(`feature ${featureIndex + 1} Polygon must contain at least one ring`)
    }
    return geometry.coordinates.map((ring, ringIndex) => ({
      kind: 'polyline',
      points: coordinateLine(
        ring,
        `feature ${featureIndex + 1} Polygon ring ${ringIndex + 1}`,
        4
      ),
      closed: true,
      featureIndex,
      ringIndex
    }))
  }
  throw new Error(
    `feature ${featureIndex + 1} has unsupported geometry type: ${String(geometry.type)}`
  )
}

/** Parses GeoJSON Point, LineString, and Polygon geometries without changing coordinates. */
export function parseSupportedGeoJson(geojsonText: string): ParsedGeoJsonGeometry[] {
  let decoded: unknown
  try {
    decoded = JSON.parse(geojsonText)
  } catch (error) {
    throw new Error(
      `GeoJSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  const root = record(decoded, 'GeoJSON')
  if (root.type === 'FeatureCollection') {
    if (!Array.isArray(root.features)) throw new Error('GeoJSON features must be an array')
    return root.features.flatMap((feature, featureIndex) => {
      const featureRecord = record(feature, `feature ${featureIndex + 1}`)
      if (featureRecord.type !== 'Feature') {
        throw new Error(`feature ${featureIndex + 1} must have type "Feature"`)
      }
      if (featureRecord.geometry === null) {
        throw new Error(`feature ${featureIndex + 1} has null geometry`)
      }
      return parseGeometry(featureRecord.geometry, featureIndex)
    })
  }
  if (root.type === 'Feature') {
    if (root.geometry === null) throw new Error('feature 1 has null geometry')
    return parseGeometry(root.geometry, 0)
  }
  return parseGeometry(root, 0)
}
