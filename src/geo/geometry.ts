export interface Point2D {
  x: number
  y: number
}

export interface PointGeometry {
  kind: 'point'
  point: Point2D
}

export interface SegmentGeometry {
  kind: 'segment'
  start: Point2D
  end: Point2D
}

export interface PolylineGeometry {
  kind: 'polyline'
  points: Point2D[]
  closed: boolean
}

export interface CircleGeometry {
  kind: 'circle'
  center: Point2D
  radius: number
}

export type PrimitiveGeometry =
  | PointGeometry
  | SegmentGeometry
  | PolylineGeometry
  | CircleGeometry

export interface CompositeGeometry {
  kind: 'composite'
  parts: PrimitiveGeometry[]
}

export type EntityGeometry = PrimitiveGeometry | CompositeGeometry

export type PointPolygonLocation = 'inside' | 'outside' | 'boundary'

export interface MinimumDistanceResult {
  distance: number
  pointOnA: Point2D
  pointOnB: Point2D
}

const EPSILON = 1e-9

function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

function samePoint(a: Point2D, b: Point2D): boolean {
  return distance(a, b) <= EPSILON
}

function subtract(a: Point2D, b: Point2D): Point2D {
  return { x: a.x - b.x, y: a.y - b.y }
}

function dot(a: Point2D, b: Point2D): number {
  return a.x * b.x + a.y * b.y
}

function cross(a: Point2D, b: Point2D): number {
  return a.x * b.y - a.y * b.x
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function pointAt(start: Point2D, end: Point2D, parameter: number): Point2D {
  return {
    x: start.x + (end.x - start.x) * parameter,
    y: start.y + (end.y - start.y) * parameter
  }
}

function normalizedPolygon(points: readonly Point2D[]): Point2D[] {
  if (points.length > 1 && samePoint(points[0], points[points.length - 1])) {
    return points.slice(0, -1)
  }
  return [...points]
}

/** Classifies a point against a straight-edged polygon, including its boundary. */
export function pointInPolygon(
  point: Point2D,
  polygon: readonly Point2D[]
): PointPolygonLocation {
  const vertices = normalizedPolygon(polygon)
  if (vertices.length < 3) throw new Error('A polygon must contain at least three vertices')

  let inside = false
  for (let index = 0; index < vertices.length; index++) {
    const start = vertices[index]
    const end = vertices[(index + 1) % vertices.length]
    if (pointToSegment(point, start, end).distance <= EPSILON) return 'boundary'

    const crossesRay =
      (start.y > point.y) !== (end.y > point.y) &&
      point.x < ((end.x - start.x) * (point.y - start.y)) / (end.y - start.y) + start.x
    if (crossesRay) inside = !inside
  }
  return inside ? 'inside' : 'outside'
}

function polygonEdges(points: readonly Point2D[]): SegmentGeometry[] {
  const vertices = normalizedPolygon(points)
  return vertices.map((start, index) => ({
    kind: 'segment',
    start,
    end: vertices[(index + 1) % vertices.length]
  }))
}

function segmentIntersection(
  aStart: Point2D,
  aEnd: Point2D,
  bStart: Point2D,
  bEnd: Point2D
): Point2D | null {
  const r = subtract(aEnd, aStart)
  const s = subtract(bEnd, bStart)
  const rCrossS = cross(r, s)
  const bMinusA = subtract(bStart, aStart)

  if (Math.abs(rCrossS) <= EPSILON) {
    if (Math.abs(cross(bMinusA, r)) > EPSILON) return null
    for (const candidate of [aStart, aEnd, bStart, bEnd]) {
      if (
        pointToSegment(candidate, aStart, aEnd).distance <= EPSILON &&
        pointToSegment(candidate, bStart, bEnd).distance <= EPSILON
      ) {
        return { ...candidate }
      }
    }
    return null
  }

  const t = cross(bMinusA, s) / rCrossS
  const u = cross(bMinusA, r) / rCrossS
  if (t < -EPSILON || t > 1 + EPSILON || u < -EPSILON || u > 1 + EPSILON) {
    return null
  }
  return pointAt(aStart, aEnd, clamp01(t))
}

/** True when two straight-edged polygon regions share at least one point. */
export function polygonsOverlap(
  polygonA: readonly Point2D[],
  polygonB: readonly Point2D[]
): boolean {
  const a = normalizedPolygon(polygonA)
  const b = normalizedPolygon(polygonB)
  if (a.length < 3 || b.length < 3) {
    throw new Error('Each polygon must contain at least three vertices')
  }

  for (const edgeA of polygonEdges(a)) {
    for (const edgeB of polygonEdges(b)) {
      if (segmentIntersection(edgeA.start, edgeA.end, edgeB.start, edgeB.end)) return true
    }
  }
  return pointInPolygon(a[0], b) !== 'outside' || pointInPolygon(b[0], a) !== 'outside'
}

function pointToSegment(
  point: Point2D,
  start: Point2D,
  end: Point2D
): MinimumDistanceResult {
  const vector = subtract(end, start)
  const lengthSquared = dot(vector, vector)
  const parameter =
    lengthSquared <= EPSILON ? 0 : clamp01(dot(subtract(point, start), vector) / lengthSquared)
  const closest = pointAt(start, end, parameter)
  return { distance: distance(point, closest), pointOnA: { ...point }, pointOnB: closest }
}

function segmentToSegment(
  aStart: Point2D,
  aEnd: Point2D,
  bStart: Point2D,
  bEnd: Point2D
): MinimumDistanceResult {
  const intersection = segmentIntersection(aStart, aEnd, bStart, bEnd)
  if (intersection) {
    return { distance: 0, pointOnA: intersection, pointOnB: { ...intersection } }
  }

  const candidates = [
    pointToSegment(aStart, bStart, bEnd),
    pointToSegment(aEnd, bStart, bEnd),
    reverseResult(pointToSegment(bStart, aStart, aEnd)),
    reverseResult(pointToSegment(bEnd, aStart, aEnd))
  ]
  return candidates.reduce((best, candidate) =>
    candidate.distance < best.distance ? candidate : best
  )
}

function polylineSegments(polyline: PolylineGeometry): SegmentGeometry[] {
  const segments: SegmentGeometry[] = []
  for (let index = 1; index < polyline.points.length; index++) {
    segments.push({
      kind: 'segment',
      start: polyline.points[index - 1],
      end: polyline.points[index]
    })
  }
  if (
    polyline.closed &&
    polyline.points.length > 2 &&
    !samePoint(polyline.points[0], polyline.points[polyline.points.length - 1])
  ) {
    segments.push({
      kind: 'segment',
      start: polyline.points[polyline.points.length - 1],
      end: polyline.points[0]
    })
  }
  return segments
}

function pointToPolyline(point: Point2D, polyline: PolylineGeometry): MinimumDistanceResult {
  if (polyline.points.length === 0) throw new Error('A polyline must contain at least one point')
  if (
    polyline.closed &&
    polyline.points.length >= 3 &&
    pointInPolygon(point, polyline.points) !== 'outside'
  ) {
    return { distance: 0, pointOnA: { ...point }, pointOnB: { ...point } }
  }

  const segments = polylineSegments(polyline)
  if (segments.length === 0) {
    return {
      distance: distance(point, polyline.points[0]),
      pointOnA: { ...point },
      pointOnB: { ...polyline.points[0] }
    }
  }
  return segments
    .map((segment) => pointToSegment(point, segment.start, segment.end))
    .reduce((best, candidate) => (candidate.distance < best.distance ? candidate : best))
}

function pointToCircle(point: Point2D, circle: CircleGeometry): MinimumDistanceResult {
  const centerDistance = distance(point, circle.center)
  if (centerDistance <= circle.radius + EPSILON) {
    return { distance: 0, pointOnA: { ...point }, pointOnB: { ...point } }
  }
  const ratio = circle.radius / centerDistance
  const circlePoint = {
    x: circle.center.x + (point.x - circle.center.x) * ratio,
    y: circle.center.y + (point.y - circle.center.y) * ratio
  }
  return {
    distance: Math.max(0, centerDistance - circle.radius),
    pointOnA: { ...point },
    pointOnB: circlePoint
  }
}

function segmentToCircle(segment: SegmentGeometry, circle: CircleGeometry): MinimumDistanceResult {
  const centerToSegment = pointToSegment(circle.center, segment.start, segment.end)
  const segmentPoint = centerToSegment.pointOnB
  if (centerToSegment.distance <= circle.radius + EPSILON) {
    return { distance: 0, pointOnA: segmentPoint, pointOnB: { ...segmentPoint } }
  }
  return pointToCircle(segmentPoint, circle)
}

function circleToCircle(a: CircleGeometry, b: CircleGeometry): MinimumDistanceResult {
  const centerDistance = distance(a.center, b.center)
  if (centerDistance <= a.radius + b.radius + EPSILON) {
    if (centerDistance <= EPSILON) {
      return { distance: 0, pointOnA: { ...a.center }, pointOnB: { ...a.center } }
    }
    const parameter = Math.min(1, a.radius / centerDistance)
    const shared = pointAt(a.center, b.center, parameter)
    return { distance: 0, pointOnA: shared, pointOnB: { ...shared } }
  }
  const direction = {
    x: (b.center.x - a.center.x) / centerDistance,
    y: (b.center.y - a.center.y) / centerDistance
  }
  return {
    distance: centerDistance - a.radius - b.radius,
    pointOnA: {
      x: a.center.x + direction.x * a.radius,
      y: a.center.y + direction.y * a.radius
    },
    pointOnB: {
      x: b.center.x - direction.x * b.radius,
      y: b.center.y - direction.y * b.radius
    }
  }
}

function polylineToPolyline(
  a: PolylineGeometry,
  b: PolylineGeometry
): MinimumDistanceResult {
  if (a.points.length === 0 || b.points.length === 0) {
    throw new Error('A polyline must contain at least one point')
  }
  if (a.closed && b.closed && polygonsOverlap(a.points, b.points)) {
    const point =
      a.points.find((candidate) => pointInPolygon(candidate, b.points) !== 'outside') ??
      b.points.find((candidate) => pointInPolygon(candidate, a.points) !== 'outside') ??
      a.points[0]
    return { distance: 0, pointOnA: { ...point }, pointOnB: { ...point } }
  }

  if (a.closed) {
    const contained = b.points.find(
      (candidate) => pointInPolygon(candidate, a.points) !== 'outside'
    )
    if (contained) return { distance: 0, pointOnA: { ...contained }, pointOnB: { ...contained } }
  }
  if (b.closed) {
    const contained = a.points.find(
      (candidate) => pointInPolygon(candidate, b.points) !== 'outside'
    )
    if (contained) return { distance: 0, pointOnA: { ...contained }, pointOnB: { ...contained } }
  }

  const segmentsA = polylineSegments(a)
  const segmentsB = polylineSegments(b)
  if (segmentsA.length === 0) return pointToPolyline(a.points[0], b)
  if (segmentsB.length === 0) return reverseResult(pointToPolyline(b.points[0], a))

  const candidates: MinimumDistanceResult[] = []
  for (const segmentA of segmentsA) {
    for (const segmentB of segmentsB) {
      candidates.push(
        segmentToSegment(segmentA.start, segmentA.end, segmentB.start, segmentB.end)
      )
    }
  }
  return candidates.reduce((best, candidate) =>
    candidate.distance < best.distance ? candidate : best
  )
}

function polylineToCircle(
  polyline: PolylineGeometry,
  circle: CircleGeometry
): MinimumDistanceResult {
  if (polyline.points.length === 0) throw new Error('A polyline must contain at least one point')
  if (
    (polyline.closed && pointInPolygon(circle.center, polyline.points) !== 'outside') ||
    polyline.points.some((point) => distance(point, circle.center) <= circle.radius + EPSILON)
  ) {
    const shared =
      polyline.points.find((point) => distance(point, circle.center) <= circle.radius + EPSILON) ??
      circle.center
    return { distance: 0, pointOnA: { ...shared }, pointOnB: { ...shared } }
  }

  const segments = polylineSegments(polyline)
  if (segments.length === 0) return pointToCircle(polyline.points[0], circle)
  return segments
    .map((segment) => segmentToCircle(segment, circle))
    .reduce((best, candidate) => (candidate.distance < best.distance ? candidate : best))
}

function reverseResult(result: MinimumDistanceResult): MinimumDistanceResult {
  return {
    distance: result.distance,
    pointOnA: result.pointOnB,
    pointOnB: result.pointOnA
  }
}

/**
 * Computes the exact minimum distance and closest points for point, segment,
 * straight polyline/polygon, and circular-disk pairs.
 */
export function minimumDistance(
  geometryA: EntityGeometry,
  geometryB: EntityGeometry
): MinimumDistanceResult {
  if (geometryA.kind === 'composite') {
    if (geometryA.parts.length === 0) throw new Error('A composite must contain at least one part')
    return geometryA.parts
      .map((part) => minimumDistance(part, geometryB))
      .reduce((best, candidate) => (candidate.distance < best.distance ? candidate : best))
  }
  if (geometryB.kind === 'composite') {
    if (geometryB.parts.length === 0) throw new Error('A composite must contain at least one part')
    return geometryB.parts
      .map((part) => minimumDistance(geometryA, part))
      .reduce((best, candidate) => (candidate.distance < best.distance ? candidate : best))
  }
  if (geometryA.kind === 'point') {
    if (geometryB.kind === 'point') {
      return {
        distance: distance(geometryA.point, geometryB.point),
        pointOnA: { ...geometryA.point },
        pointOnB: { ...geometryB.point }
      }
    }
    if (geometryB.kind === 'segment') {
      return pointToSegment(geometryA.point, geometryB.start, geometryB.end)
    }
    if (geometryB.kind === 'polyline') return pointToPolyline(geometryA.point, geometryB)
    return pointToCircle(geometryA.point, geometryB)
  }
  if (geometryA.kind === 'segment') {
    if (geometryB.kind === 'point') {
      return reverseResult(pointToSegment(geometryB.point, geometryA.start, geometryA.end))
    }
    if (geometryB.kind === 'segment') {
      return segmentToSegment(
        geometryA.start,
        geometryA.end,
        geometryB.start,
        geometryB.end
      )
    }
    if (geometryB.kind === 'polyline') {
      return polylineToPolyline(
        { kind: 'polyline', points: [geometryA.start, geometryA.end], closed: false },
        geometryB
      )
    }
    return segmentToCircle(geometryA, geometryB)
  }
  if (geometryA.kind === 'polyline') {
    if (geometryB.kind === 'point') return reverseResult(pointToPolyline(geometryB.point, geometryA))
    if (geometryB.kind === 'segment') {
      return polylineToPolyline(geometryA, {
        kind: 'polyline',
        points: [geometryB.start, geometryB.end],
        closed: false
      })
    }
    if (geometryB.kind === 'polyline') return polylineToPolyline(geometryA, geometryB)
    return polylineToCircle(geometryA, geometryB)
  }
  if (geometryB.kind === 'point') return reverseResult(pointToCircle(geometryB.point, geometryA))
  if (geometryB.kind === 'segment') return reverseResult(segmentToCircle(geometryB, geometryA))
  if (geometryB.kind === 'polyline') return reverseResult(polylineToCircle(geometryB, geometryA))
  return circleToCircle(geometryA, geometryB)
}

/** True when the represented regions share at least one point. */
export function entityGeometriesOverlap(
  geometryA: EntityGeometry,
  geometryB: EntityGeometry
): boolean {
  return minimumDistance(geometryA, geometryB).distance <= EPSILON
}
