import { describe, expect, it } from 'vitest'
import {
  boundingBox,
  boundingBoxCenter,
  hasBulgeArcs,
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
})
