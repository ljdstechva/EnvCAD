import { describe, expect, it } from 'vitest'
import {
  boundingBox,
  boundingBoxCenter,
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
