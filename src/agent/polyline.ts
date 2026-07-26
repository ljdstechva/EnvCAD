import type { AcDbPolyline } from '@mlightcad/data-model'
import type { Point2D, PolylineVertex } from './geometry'

/**
 * Reads positions and verified per-vertex bulges using public AcDbPolyline APIs.
 *
 * Positions always come from getPoint3dAt. Bulges come from the public
 * `properties` accessor used by the property palette and are trusted only
 * when that vertex array has the same length and every x/y agrees with the
 * point API. Missing or malformed property data degrades safely to straight
 * chord vertices.
 */

const COORDINATE_TOLERANCE = 1e-9

interface PropertyVertex {
  x?: unknown
  y?: unknown
  bulge?: unknown
}

export interface PolylineVertexExtraction {
  vertices: PolylineVertex[]
  bulgesVerified: boolean
}

/** Vertex positions, read exclusively through the public point API. */
export function polylinePoints(polyline: AcDbPolyline): Point2D[] {
  const points: Point2D[] = []
  for (let index = 0; index < polyline.numberOfVertices; index++) {
    const point = polyline.getPoint3dAt(index)
    points.push({ x: point.x, y: point.y })
  }
  return points
}

function readPropertyBulges(polyline: AcDbPolyline, points: readonly Point2D[]): number[] | null {
  const vertexProperty = polyline.properties.groups
    .flatMap((group) => group.properties)
    .find((property) => property.name === 'vertices')
  const vertices = vertexProperty?.accessor.get()
  if (!Array.isArray(vertices) || vertices.length !== points.length) return null

  const bulges: number[] = []
  for (let index = 0; index < vertices.length; index++) {
    const vertex = vertices[index] as PropertyVertex | null | undefined
    if (typeof vertex !== 'object' || vertex === null) return null
    if (typeof vertex.x !== 'number' || typeof vertex.y !== 'number') return null
    if (
      Math.abs(vertex.x - points[index].x) > COORDINATE_TOLERANCE ||
      Math.abs(vertex.y - points[index].y) > COORDINATE_TOLERANCE
    ) {
      return null
    }
    if (
      vertex.bulge !== undefined &&
      (typeof vertex.bulge !== 'number' || !Number.isFinite(vertex.bulge))
    ) {
      return null
    }
    bulges.push(vertex.bulge ?? 0)
  }
  return bulges
}

/** Verified public vertices plus whether the bulge records could be trusted. */
export function extractPolylineVertices(polyline: AcDbPolyline): PolylineVertexExtraction {
  const points = polylinePoints(polyline)
  const bulges = readPropertyBulges(polyline, points)
  if (!bulges) return { vertices: points, bulgesVerified: false }

  return {
    vertices: points.map((point, index) =>
      bulges[index] === 0 ? point : { ...point, bulge: bulges[index] }
    ),
    bulgesVerified: true
  }
}

/** Convenience accessor for callers that need only the verified/fallback vertices. */
export function polylineVertices(polyline: AcDbPolyline): PolylineVertex[] {
  return extractPolylineVertices(polyline).vertices
}
