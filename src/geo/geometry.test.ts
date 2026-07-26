import { describe, expect, it } from 'vitest'
import {
  entityGeometriesOverlap,
  minimumDistance,
  pointInPolygon,
  polygonsOverlap,
  type EntityGeometry
} from './geometry'

const square = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 }
]

describe('pointInPolygon', () => {
  it('distinguishes inside, outside, edge, and vertex points', () => {
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe('inside')
    expect(pointInPolygon({ x: 15, y: 5 }, square)).toBe('outside')
    expect(pointInPolygon({ x: 10, y: 5 }, square)).toBe('boundary')
    expect(pointInPolygon({ x: 0, y: 0 }, square)).toBe('boundary')
  })

  it('accepts a duplicated closing vertex', () => {
    expect(pointInPolygon({ x: 5, y: 5 }, [...square, square[0]])).toBe('inside')
  })
})

describe('polygonsOverlap', () => {
  it('detects crossing, touching, and containment', () => {
    expect(
      polygonsOverlap(square, [
        { x: 8, y: 8 },
        { x: 12, y: 8 },
        { x: 12, y: 12 },
        { x: 8, y: 12 }
      ])
    ).toBe(true)
    expect(
      polygonsOverlap(square, [
        { x: 10, y: 2 },
        { x: 12, y: 2 },
        { x: 12, y: 4 },
        { x: 10, y: 4 }
      ])
    ).toBe(true)
    expect(
      polygonsOverlap(square, [
        { x: 2, y: 2 },
        { x: 3, y: 2 },
        { x: 3, y: 3 },
        { x: 2, y: 3 }
      ])
    ).toBe(true)
  })

  it('rejects separated polygons', () => {
    expect(
      polygonsOverlap(square, [
        { x: 11, y: 11 },
        { x: 12, y: 11 },
        { x: 12, y: 12 },
        { x: 11, y: 12 }
      ])
    ).toBe(false)
  })
})

describe('minimumDistance', () => {
  const point = (x: number, y: number): EntityGeometry => ({
    kind: 'point',
    point: { x, y }
  })
  const segment = (x1: number, y1: number, x2: number, y2: number): EntityGeometry => ({
    kind: 'segment',
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 }
  })
  const polyline = (
    points: Array<{ x: number; y: number }>,
    closed = false
  ): EntityGeometry => ({ kind: 'polyline', points, closed })
  const circle = (x: number, y: number, radius: number): EntityGeometry => ({
    kind: 'circle',
    center: { x, y },
    radius
  })

  it('covers point-point, point-segment, and crossing segment pairs', () => {
    expect(minimumDistance(point(0, 0), point(3, 4)).distance).toBe(5)
    const projected = minimumDistance(point(2, 3), segment(0, 0, 4, 0))
    expect(projected).toEqual({
      distance: 3,
      pointOnA: { x: 2, y: 3 },
      pointOnB: { x: 2, y: 0 }
    })
    expect(minimumDistance(segment(0, 0, 4, 4), segment(0, 4, 4, 0)).distance).toBe(0)
  })

  it('covers separated polyline pairs with exact closest points', () => {
    const result = minimumDistance(
      polyline([
        { x: 0, y: 0 },
        { x: 0, y: 5 }
      ]),
      polyline([
        { x: 4, y: 2 },
        { x: 6, y: 2 }
      ])
    )
    expect(result.distance).toBe(4)
    expect(result.pointOnA).toEqual({ x: 0, y: 2 })
    expect(result.pointOnB).toEqual({ x: 4, y: 2 })
  })

  it('treats closed polylines and circles as regions', () => {
    const polygon = polyline(square, true)
    expect(minimumDistance(point(5, 5), polygon).distance).toBe(0)
    expect(minimumDistance(circle(5, 5, 2), polygon).distance).toBe(0)
    expect(entityGeometriesOverlap(circle(12, 5, 2), polygon)).toBe(true)
  })

  it('covers exact circle clearances and reverses closest points correctly', () => {
    const circles = minimumDistance(circle(0, 0, 2), circle(10, 0, 3))
    expect(circles.distance).toBe(5)
    expect(circles.pointOnA).toEqual({ x: 2, y: 0 })
    expect(circles.pointOnB).toEqual({ x: 7, y: 0 })

    const pointCircle = minimumDistance(circle(0, 0, 2), point(5, 0))
    expect(pointCircle.distance).toBe(3)
    expect(pointCircle.pointOnA).toEqual({ x: 2, y: 0 })
    expect(pointCircle.pointOnB).toEqual({ x: 5, y: 0 })
  })

  it('keeps closest points aligned with segment-circle argument order', () => {
    const segmentCircle = minimumDistance(segment(0, 0, 4, 0), circle(10, 0, 2))
    expect(segmentCircle).toEqual({
      distance: 4,
      pointOnA: { x: 4, y: 0 },
      pointOnB: { x: 8, y: 0 }
    })

    const circleSegment = minimumDistance(circle(10, 0, 2), segment(0, 0, 4, 0))
    expect(circleSegment).toEqual({
      distance: 4,
      pointOnA: { x: 8, y: 0 },
      pointOnB: { x: 4, y: 0 }
    })
  })

  it('uses every primitive in a composite and preserves closest-point order', () => {
    const composite = {
      kind: 'composite' as const,
      parts: [
        { kind: 'circle' as const, center: { x: 0, y: 0 }, radius: 1 },
        {
          kind: 'segment' as const,
          start: { x: 5, y: -1 },
          end: { x: 5, y: 1 }
        }
      ]
    }
    const target = point(7, 0)

    expect(minimumDistance(composite, target)).toEqual({
      distance: 2,
      pointOnA: { x: 5, y: 0 },
      pointOnB: { x: 7, y: 0 }
    })
    expect(minimumDistance(target, composite)).toEqual({
      distance: 2,
      pointOnA: { x: 7, y: 0 },
      pointOnB: { x: 5, y: 0 }
    })
  })
})
