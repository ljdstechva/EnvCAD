export interface Point2D {
  x: number
  y: number
}

export interface PolylineVertex extends Point2D {
  /** AutoCAD bulge at this vertex: tan(one quarter of the following segment's included angle). */
  bulge?: number
}

export interface BoundingBox2D {
  min: Point2D
  max: Point2D
}

const POINT_EPSILON = 1e-12

function samePoint(a: Point2D, b: Point2D): boolean {
  return Math.abs(a.x - b.x) <= POINT_EPSILON && Math.abs(a.y - b.y) <= POINT_EPSILON
}

/** Removes a duplicated closing vertex while preserving the original array. */
export function withoutDuplicateClosingVertex<T extends Point2D>(points: readonly T[]): T[] {
  if (points.length > 1 && samePoint(points[0], points[points.length - 1])) {
    return points.slice(0, -1)
  }
  return [...points]
}

/** Rotates a point counter-clockwise around a center. */
export function rotatePoint(point: Point2D, center: Point2D, angleRad: number): Point2D {
  const cos = Math.cos(angleRad)
  const sin = Math.sin(angleRad)
  const dx = point.x - center.x
  const dy = point.y - center.y
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos
  }
}

/** Calculates unsigned polygon area using the shoelace formula. */
export function shoelaceArea(points: readonly Point2D[]): number {
  const vertices = withoutDuplicateClosingVertex(points)
  if (vertices.length < 3) return 0

  let twiceSignedArea = 0
  for (let index = 0; index < vertices.length; index++) {
    const current = vertices[index]
    const next = vertices[(index + 1) % vertices.length]
    twiceSignedArea += current.x * next.y - next.x * current.y
  }
  return Math.abs(twiceSignedArea) / 2
}

/** Returns the axis-aligned bounding box of a non-empty point set. */
export function boundingBox(points: readonly Point2D[]): BoundingBox2D | null {
  if (points.length === 0) return null

  let minX = points[0].x
  let minY = points[0].y
  let maxX = points[0].x
  let maxY = points[0].y
  for (let index = 1; index < points.length; index++) {
    const point = points[index]
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } }
}

/** Returns the union of all supplied bounding boxes. */
export function unionBoundingBoxes(boxes: readonly BoundingBox2D[]): BoundingBox2D | null {
  if (boxes.length === 0) return null
  return {
    min: {
      x: Math.min(...boxes.map((box) => box.min.x)),
      y: Math.min(...boxes.map((box) => box.min.y))
    },
    max: {
      x: Math.max(...boxes.map((box) => box.max.x)),
      y: Math.max(...boxes.map((box) => box.max.y))
    }
  }
}

export function boundingBoxCenter(box: BoundingBox2D): Point2D {
  return {
    x: (box.min.x + box.max.x) / 2,
    y: (box.min.y + box.max.y) / 2
  }
}

export function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

function polylineSegmentLength(start: PolylineVertex, end: PolylineVertex): number {
  const chordLength = distance(start, end)
  const bulge = Math.abs(start.bulge ?? 0)
  if (chordLength === 0 || bulge <= POINT_EPSILON) return chordLength

  const includedAngle = 4 * Math.atan(bulge)
  const radius = (chordLength * (1 + bulge * bulge)) / (4 * bulge)
  return radius * includedAngle
}

/** Calculates polyline length, including exact bulge-defined circular arc segments. */
export function polylineLength(points: readonly PolylineVertex[], closed: boolean): number {
  if (points.length < 2) return 0
  let total = 0
  for (let index = 1; index < points.length; index++) {
    total += polylineSegmentLength(points[index - 1], points[index])
  }
  if (closed && !samePoint(points[points.length - 1], points[0])) {
    total += polylineSegmentLength(points[points.length - 1], points[0])
  }
  return total
}
