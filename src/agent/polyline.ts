import type { AcDbPolyline } from '@mlightcad/data-model'
import type { Point2D, PolylineVertex } from './geometry'

/**
 * Reading vertex bulges out of an AcDbPolyline.
 *
 * @mlightcad/data-model exposes vertex *positions* publicly (getPoint3dAt)
 * but not the per-vertex bulge that turns a segment into a circular arc — the
 * only place that value lives is the private `_geo` (AcGePolyline2d) field.
 * Ignoring bulges silently under-reports lengths and areas for any polyline
 * with curved segments, which for an environmental drawing means a wrong
 * number reported as fact, so we do read `_geo` — but defensively:
 *
 *  - Positions ALWAYS come from the public getPoint3dAt API, never from
 *    `_geo`. A change to the internal representation can therefore never
 *    corrupt coordinates.
 *  - Bulges are only trusted when `_geo.vertices` is an array of the same
 *    length as numberOfVertices AND every entry's x/y matches the public
 *    vertex position. That proves the array we found still is the 1:1 vertex
 *    list we think it is.
 *  - Anything else — field missing, renamed, restructured, length mismatch,
 *    coordinates disagreeing, non-finite bulge — falls back to treating every
 *    segment as straight. The fallback is safe because a straight-vertex
 *    polyline is exactly what the public API describes: lengths become chord
 *    lengths and areas become the chord polygon, which is what a
 *    bulge-unaware CAD reader would report anyway.
 *
 * The @mlightcad/* dependency versions are pinned exactly in package.json so
 * an `npm update` cannot silently swap this representation out from under us.
 */

/** Positions match when they agree to well within any plausible drawing tolerance. */
const COORDINATE_TOLERANCE = 1e-9

interface InternalVertex {
  x?: unknown
  y?: unknown
  bulge?: unknown
}

interface InternalGeometry {
  vertices?: unknown
}

/** Vertex positions, read exclusively through the public polyline API. */
export function polylinePoints(polyline: AcDbPolyline): Point2D[] {
  const points: Point2D[] = []
  for (let index = 0; index < polyline.numberOfVertices; index++) {
    const point = polyline.getPoint3dAt(index)
    points.push({ x: point.x, y: point.y })
  }
  return points
}

/**
 * Per-vertex bulges from the internal geometry, or null when the internal
 * representation cannot be confirmed to line up with `points`.
 */
function readInternalBulges(polyline: AcDbPolyline, points: readonly Point2D[]): number[] | null {
  const geometry = (polyline as unknown as { _geo?: InternalGeometry })._geo
  const vertices = geometry?.vertices
  if (!Array.isArray(vertices) || vertices.length !== points.length) return null

  const bulges: number[] = []
  for (let index = 0; index < vertices.length; index++) {
    const vertex = vertices[index] as InternalVertex | null | undefined
    if (typeof vertex !== 'object' || vertex === null) return null
    if (typeof vertex.x !== 'number' || typeof vertex.y !== 'number') return null
    if (
      Math.abs(vertex.x - points[index].x) > COORDINATE_TOLERANCE ||
      Math.abs(vertex.y - points[index].y) > COORDINATE_TOLERANCE
    ) {
      return null
    }
    const bulge = vertex.bulge
    bulges.push(typeof bulge === 'number' && Number.isFinite(bulge) ? bulge : 0)
  }
  return bulges
}

/**
 * Polyline vertices with bulges attached where they can be trusted. Falls back
 * to straight (bulge-free) vertices whenever the internal representation is
 * unrecognisable — see the module comment.
 */
export function polylineVertices(polyline: AcDbPolyline): PolylineVertex[] {
  const points = polylinePoints(polyline)
  const bulges = readInternalBulges(polyline, points)
  if (!bulges) return points

  return points.map((point, index) =>
    bulges[index] === 0 ? point : { ...point, bulge: bulges[index] }
  )
}
