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

export type LinearDimensionOrientation = 'horizontal' | 'vertical' | 'aligned'

export interface LinearDimensionGeometry {
  extensionLine1: { start: Point2D; end: Point2D }
  extensionLine2: { start: Point2D; end: Point2D }
  dimensionLine: { start: Point2D; end: Point2D }
  textPosition: Point2D
  angleRad: number
  measurement: number
}

export interface ArrowheadGeometry {
  tip: Point2D
  baseLeft: Point2D
  baseRight: Point2D
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

/**
 * Twice the signed polygon area (shoelace). Positive for counter-clockwise
 * winding, negative for clockwise. Any duplicated closing vertex is dropped
 * first so it does not contribute a zero-length edge.
 */
function twiceSignedPolygonArea(points: readonly Point2D[]): number {
  const vertices = withoutDuplicateClosingVertex(points)
  if (vertices.length < 3) return 0

  let total = 0
  for (let index = 0; index < vertices.length; index++) {
    const current = vertices[index]
    const next = vertices[(index + 1) % vertices.length]
    total += current.x * next.y - next.x * current.y
  }
  return total
}

/**
 * Calculates unsigned polygon area using the shoelace formula. Straight edges
 * only — use {@link polylineArea} for vertices that may carry bulges.
 */
export function shoelaceArea(points: readonly Point2D[]): number {
  return Math.abs(twiceSignedPolygonArea(points)) / 2
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

/** Euclidean clearance between two axis-aligned boxes; zero means touch/overlap. */
export function boundingBoxDistance(
  left: BoundingBox2D,
  right: BoundingBox2D
): number {
  const dx = Math.max(
    left.min.x - right.max.x,
    right.min.x - left.max.x,
    0
  )
  const dy = Math.max(
    left.min.y - right.max.y,
    right.min.y - left.max.y,
    0
  )
  return Math.hypot(dx, dy)
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

function addScaled(point: Point2D, vector: Point2D, scale: number): Point2D {
  return { x: point.x + vector.x * scale, y: point.y + vector.y * scale }
}

/**
 * Computes the exact construction geometry for a linear dimension.
 *
 * Horizontal and vertical dimensions measure the corresponding projected
 * coordinate difference. Aligned dimensions measure the Euclidean distance
 * between the supplied definition points.
 */
export function linearDimensionGeometry(
  p1: Point2D,
  p2: Point2D,
  offset: number,
  orientation: LinearDimensionOrientation
): LinearDimensionGeometry {
  let direction: Point2D
  let normal: Point2D
  let measurement: number
  let dimensionStart: Point2D
  let dimensionEnd: Point2D

  if (orientation === 'horizontal') {
    measurement = Math.abs(p2.x - p1.x)
    if (measurement <= POINT_EPSILON) {
      throw new Error('Horizontal dimension points must have different X coordinates')
    }
    const sign = Math.sign(p2.x - p1.x)
    direction = { x: sign, y: 0 }
    normal = { x: 0, y: 1 }
    dimensionStart = { x: p1.x, y: p1.y + offset }
    dimensionEnd = { x: p2.x, y: p1.y + offset }
  } else if (orientation === 'vertical') {
    measurement = Math.abs(p2.y - p1.y)
    if (measurement <= POINT_EPSILON) {
      throw new Error('Vertical dimension points must have different Y coordinates')
    }
    const sign = Math.sign(p2.y - p1.y)
    direction = { x: 0, y: sign }
    normal = { x: 1, y: 0 }
    dimensionStart = { x: p1.x + offset, y: p1.y }
    dimensionEnd = { x: p1.x + offset, y: p2.y }
  } else {
    measurement = distance(p1, p2)
    if (measurement <= POINT_EPSILON) {
      throw new Error('Aligned dimension points must be distinct')
    }
    direction = { x: (p2.x - p1.x) / measurement, y: (p2.y - p1.y) / measurement }
    normal = { x: -direction.y, y: direction.x }
    dimensionStart = addScaled(p1, normal, offset)
    dimensionEnd = addScaled(p2, normal, offset)
  }

  return {
    extensionLine1: { start: { ...p1 }, end: { ...dimensionStart } },
    extensionLine2: { start: { ...p2 }, end: { ...dimensionEnd } },
    dimensionLine: { start: dimensionStart, end: dimensionEnd },
    textPosition: {
      x: (dimensionStart.x + dimensionEnd.x) / 2,
      y: (dimensionStart.y + dimensionEnd.y) / 2
    },
    angleRad: Math.atan2(direction.y, direction.x),
    measurement
  }
}

/**
 * Returns a filled triangular arrowhead whose tip is at `tip` and whose body
 * extends in `inwardDirection`. The direction need not already be normalized.
 */
export function arrowheadGeometry(
  tip: Point2D,
  inwardDirection: Point2D,
  length: number,
  width: number
): ArrowheadGeometry {
  const magnitude = Math.hypot(inwardDirection.x, inwardDirection.y)
  if (magnitude <= POINT_EPSILON) throw new Error('Arrow direction must be non-zero')
  if (!(length > 0) || !(width > 0)) throw new Error('Arrow length and width must be positive')

  const direction = {
    x: inwardDirection.x / magnitude,
    y: inwardDirection.y / magnitude
  }
  const perpendicular = { x: -direction.y, y: direction.x }
  const baseCenter = addScaled(tip, direction, length)
  return {
    tip: { ...tip },
    baseLeft: addScaled(baseCenter, perpendicular, width / 2),
    baseRight: addScaled(baseCenter, perpendicular, -width / 2)
  }
}

/**
 * Usable bulge at a vertex: `tan(θ/4)` of the following segment's included
 * angle. Missing, non-finite, or negligible values mean "straight segment".
 */
function effectiveBulge(vertex: PolylineVertex): number {
  const bulge = vertex.bulge
  if (typeof bulge !== 'number' || !Number.isFinite(bulge)) return 0
  return Math.abs(bulge) <= POINT_EPSILON ? 0 : bulge
}

function polylineSegmentLength(start: PolylineVertex, end: PolylineVertex): number {
  const chordLength = distance(start, end)
  const bulge = Math.abs(effectiveBulge(start))
  if (chordLength === 0 || bulge === 0) return chordLength

  const includedAngle = 4 * Math.atan(bulge)
  const radius = (chordLength * (1 + bulge * bulge)) / (4 * bulge)
  return radius * includedAngle
}

/**
 * Signed area between a bulge segment's arc and its chord, carrying the sign
 * of the bulge: a positive bulge is a counter-clockwise arc and contributes
 * positively, matching the sign convention of a counter-clockwise shoelace
 * area, so the two can simply be added. (A positive bulge therefore *adds*
 * area to a counter-clockwise loop and removes it from a clockwise one.)
 */
function bulgeSegmentSignedArea(start: PolylineVertex, end: PolylineVertex): number {
  const bulge = effectiveBulge(start)
  const chordLength = distance(start, end)
  if (bulge === 0 || chordLength === 0) return 0

  const includedAngle = 4 * Math.atan(bulge)
  const radius = (chordLength * (1 + bulge * bulge)) / (4 * bulge)
  return (radius * radius * (includedAngle - Math.sin(includedAngle))) / 2
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

/**
 * Exact enclosed area of a closed polyline: the shoelace area of the chord
 * polygon plus the signed circular-segment area of every bulge arc. Straight
 * polylines reduce to {@link shoelaceArea}, and the result is unsigned so the
 * winding order does not matter. Open polylines enclose nothing and return 0.
 */
export function polylineArea(vertices: readonly PolylineVertex[], closed: boolean): number {
  if (!closed) return 0
  const loop = withoutDuplicateClosingVertex(vertices)
  if (loop.length < 2) return 0

  let arcArea = 0
  for (let index = 0; index < loop.length; index++) {
    arcArea += bulgeSegmentSignedArea(loop[index], loop[(index + 1) % loop.length])
  }
  return Math.abs(twiceSignedPolygonArea(loop) / 2 + arcArea)
}

/** True when any segment of the vertex list is a bulge-defined arc. */
export function hasBulgeArcs(vertices: readonly PolylineVertex[]): boolean {
  return vertices.some((vertex) => effectiveBulge(vertex) !== 0)
}
