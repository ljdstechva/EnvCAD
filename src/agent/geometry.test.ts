import { describe, expect, it } from 'vitest'
import {
  arrowheadGeometry,
  boundingBox,
  boundingBoxCenter,
  boundingBoxDistance,
  distance,
  hasBulgeArcs,
  linearDimensionGeometry,
  polylineArea,
  polylineLength,
  rotatePoint,
  shoelaceArea,
  unionBoundingBoxes,
  withoutDuplicateClosingVertex
} from './geometry'

describe('agent geometry helpers', () => {
  it('rotates counter-clockwise around an arbitrary center', () => {
    const rotated = rotatePoint({ x: 12, y: 5 }, { x: 10, y: 5 }, Math.PI / 2)
    expect(rotated.x).toBeCloseTo(10)
    expect(rotated.y).toBeCloseTo(7)
  })

  it('calculates shoelace area in either winding order', () => {
    const clockwise = [
      { x: 0, y: 0 },
      { x: 0, y: 3 },
      { x: 4, y: 3 },
      { x: 4, y: 0 }
    ]
    expect(shoelaceArea(clockwise)).toBe(12)
    expect(shoelaceArea([...clockwise].reverse())).toBe(12)
  })

  it('does not double-count a duplicated closing vertex', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 2 },
      { x: 0, y: 2 },
      { x: 0, y: 0 }
    ]
    expect(withoutDuplicateClosingVertex(points)).toHaveLength(4)
    expect(shoelaceArea(points)).toBe(10)
    expect(polylineLength(points, true)).toBe(14)
  })

  it('uses bulge values for circular arc segment length', () => {
    expect(
      polylineLength(
        [
          { x: 0, y: 0, bulge: 1 },
          { x: 2, y: 0 }
        ],
        false
      )
    ).toBeCloseTo(Math.PI)
  })

  it('rotates about a bounding-box center without moving that center', () => {
    const box = boundingBox([
      { x: 10, y: 4 },
      { x: 30, y: 24 }
    ])
    const center = boundingBoxCenter(box!)
    expect(center).toEqual({ x: 20, y: 14 })

    const corners = [
      { x: 10, y: 4 },
      { x: 30, y: 4 },
      { x: 30, y: 24 },
      { x: 10, y: 24 }
    ]
    const rotated = corners.map((corner) => rotatePoint(corner, center, Math.PI / 2))
    const rotatedCenter = boundingBoxCenter(boundingBox(rotated)!)
    expect(rotatedCenter.x).toBeCloseTo(center.x)
    expect(rotatedCenter.y).toBeCloseTo(center.y)
    // A square is area-preserving under rotation about any point.
    expect(shoelaceArea(rotated)).toBeCloseTo(400)
    // 90° counter-clockwise sends the bottom-right corner to the top-right.
    expect(rotated[1].x).toBeCloseTo(30)
    expect(rotated[1].y).toBeCloseTo(24)
  })

  it('adds bulge arc areas with the sign of the bulge', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 }
    ]
    const semicircle = (Math.PI * 25) / 2

    expect(polylineArea(square, true)).toBe(100)
    expect(polylineArea([{ ...square[0], bulge: 1 }, ...square.slice(1)], true)).toBeCloseTo(
      100 + semicircle
    )
    expect(polylineArea([{ ...square[0], bulge: -1 }, ...square.slice(1)], true)).toBeCloseTo(
      100 - semicircle
    )
    // Clockwise winding gives the same unsigned area, bulges included.
    const clockwise = [...square].reverse()
    expect(
      polylineArea([{ ...clockwise[0], bulge: -1 }, ...clockwise.slice(1)], true)
    ).toBeCloseTo(100 + (Math.PI * 25) / 2)
  })

  it('treats two vertices with bulges as a full circle', () => {
    const circle = [
      { x: 0, y: 0, bulge: 1 },
      { x: 2, y: 0, bulge: 1 }
    ]
    expect(polylineArea(circle, true)).toBeCloseTo(Math.PI)
    expect(polylineLength(circle, true)).toBeCloseTo(2 * Math.PI)
    expect(hasBulgeArcs(circle)).toBe(true)
    expect(hasBulgeArcs([{ x: 0, y: 0 }, { x: 1, y: 0, bulge: 0 }])).toBe(false)
  })

  it('ignores a duplicated closing vertex and open polylines when measuring area', () => {
    const duplicated = [
      { x: 0, y: 0, bulge: 1 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 0, y: 0 }
    ]
    expect(polylineArea(duplicated, true)).toBeCloseTo(100 + (Math.PI * 25) / 2)
    expect(polylineArea(duplicated, false)).toBe(0)
  })

  it('calculates and combines bounding boxes and their common center', () => {
    const first = boundingBox([
      { x: 10, y: 10 },
      { x: 30, y: 25 }
    ])
    const second = boundingBox([
      { x: 45, y: 10 },
      { x: 70, y: 22 }
    ])
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()

    const combined = unionBoundingBoxes([first!, second!])
    expect(combined).toEqual({ min: { x: 10, y: 10 }, max: { x: 70, y: 25 } })
    expect(boundingBoxCenter(combined!)).toEqual({ x: 40, y: 17.5 })
  })

  it('measures axis-aligned and diagonal bounding-box clearance', () => {
    const first = { min: { x: 0, y: 0 }, max: { x: 1, y: 1 } }
    expect(
      boundingBoxDistance(first, {
        min: { x: 0.5, y: 0.5 },
        max: { x: 2, y: 2 }
      })
    ).toBe(0)
    expect(
      boundingBoxDistance(first, {
        min: { x: 2, y: 0 },
        max: { x: 3, y: 1 }
      })
    ).toBe(1)
    expect(
      boundingBoxDistance(first, {
        min: { x: 1.8, y: 1.8 },
        max: { x: 2.8, y: 2.8 }
      })
    ).toBeCloseTo(Math.hypot(0.8, 0.8))
  })

  it('offsets horizontal and vertical dimension extension lines exactly', () => {
    const horizontal = linearDimensionGeometry(
      { x: 10, y: 20 },
      { x: 40, y: 20 },
      -6,
      'horizontal'
    )
    expect(horizontal.extensionLine1).toEqual({
      start: { x: 10, y: 20 },
      end: { x: 10, y: 14 }
    })
    expect(horizontal.extensionLine2).toEqual({
      start: { x: 40, y: 20 },
      end: { x: 40, y: 14 }
    })
    expect(horizontal.dimensionLine).toEqual({
      start: { x: 10, y: 14 },
      end: { x: 40, y: 14 }
    })
    expect(horizontal.measurement).toBe(30)

    const vertical = linearDimensionGeometry(
      { x: 10, y: 20 },
      { x: 10, y: 45 },
      8,
      'vertical'
    )
    expect(vertical.dimensionLine).toEqual({
      start: { x: 18, y: 20 },
      end: { x: 18, y: 45 }
    })
    expect(vertical.extensionLine2.end).toEqual({ x: 18, y: 45 })
    expect(vertical.measurement).toBe(25)
  })

  it('computes aligned angle, offset, and true measurement without display rounding', () => {
    const aligned = linearDimensionGeometry(
      { x: 2, y: 3 },
      { x: 5, y: 7 },
      2,
      'aligned'
    )
    expect(aligned.measurement).toBe(5)
    expect(aligned.angleRad).toBeCloseTo(Math.atan2(4, 3))
    expect(aligned.dimensionLine.start.x).toBeCloseTo(0.4)
    expect(aligned.dimensionLine.start.y).toBeCloseTo(4.2)
    expect(aligned.dimensionLine.end.x).toBeCloseTo(3.4)
    expect(aligned.dimensionLine.end.y).toBeCloseTo(8.2)
    expect(aligned.textPosition.x).toBeCloseTo(1.9)
    expect(aligned.textPosition.y).toBeCloseTo(6.2)
  })

  it('builds symmetric filled arrowhead triangles in any direction', () => {
    const arrow = arrowheadGeometry({ x: 10, y: 4 }, { x: 1, y: 0 }, 2, 1)
    expect(arrow).toEqual({
      tip: { x: 10, y: 4 },
      baseLeft: { x: 12, y: 4.5 },
      baseRight: { x: 12, y: 3.5 }
    })

    const diagonal = arrowheadGeometry({ x: 0, y: 0 }, { x: 3, y: 4 }, 5, 2)
    expect(distance(diagonal.tip, {
      x: (diagonal.baseLeft.x + diagonal.baseRight.x) / 2,
      y: (diagonal.baseLeft.y + diagonal.baseRight.y) / 2
    })).toBeCloseTo(5)
    expect(distance(diagonal.baseLeft, diagonal.baseRight)).toBeCloseTo(2)
  })
})
