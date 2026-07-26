import { describe, expect, it } from 'vitest'
import { AcDbPolyline, AcGePoint2d } from '@mlightcad/data-model'
import { polylineArea, polylineLength } from '../geometry'
import { extractPolylineVertices, polylinePoints, polylineVertices } from '../polyline'

/**
 * A 10x10 square whose bottom edge is a semicircular arc of radius 5. A
 * positive bulge on a counter-clockwise loop swings the arc outward, so the
 * enclosed area grows by half a circle; a negative bulge swings it inward.
 */
function bulgedSquare(bulge: number): AcDbPolyline {
  const polyline = new AcDbPolyline()
  polyline.addVertexAt(0, new AcGePoint2d(0, 0), bulge)
  polyline.addVertexAt(1, new AcGePoint2d(10, 0))
  polyline.addVertexAt(2, new AcGePoint2d(10, 10))
  polyline.addVertexAt(3, new AcGePoint2d(0, 10))
  polyline.closed = true
  return polyline
}

function straightSquare(): AcDbPolyline {
  return bulgedSquare(0)
}

/** A polyline whose two public vertex APIs return controlled data. */
function withPropertyVertices(source: AcDbPolyline, vertices: unknown): AcDbPolyline {
  const points = polylinePoints(source)
  return {
    numberOfVertices: points.length,
    getPoint3dAt: (index: number) => ({ x: points[index].x, y: points[index].y, z: 0 }),
    properties: {
      type: 'AcDbPolyline',
      groups: [
        {
          groupName: 'geometry',
          properties: [
            {
              name: 'vertices',
              type: 'array',
              accessor: { get: () => vertices }
            }
          ]
        }
      ]
    }
  } as unknown as AcDbPolyline
}

const SEMICIRCLE_AREA = (Math.PI * 5 * 5) / 2
const SEMICIRCLE_LENGTH = Math.PI * 5

describe('polylineVertices bulge extraction', () => {
  it('reads bulges from the public property accessor when it lines up with public points', () => {
    const vertices = polylineVertices(bulgedSquare(1))
    expect(vertices).toHaveLength(4)
    expect(vertices[0]).toEqual({ x: 0, y: 0, bulge: 1 })
    // Straight vertices carry no bulge key at all.
    expect(vertices[1]).toEqual({ x: 10, y: 0 })
    expect(vertices[3]).toEqual({ x: 0, y: 10 })
  })

  it('measures a real bulged polyline exactly, in both bulge directions', () => {
    const outward = polylineVertices(bulgedSquare(1))
    expect(polylineArea(outward, true)).toBeCloseTo(100 + SEMICIRCLE_AREA)
    expect(polylineLength(outward, true)).toBeCloseTo(30 + SEMICIRCLE_LENGTH)

    const inward = polylineVertices(bulgedSquare(-1))
    expect(polylineArea(inward, true)).toBeCloseTo(100 - SEMICIRCLE_AREA)
    // Arc length is unaffected by which side the arc bulges to.
    expect(polylineLength(inward, true)).toBeCloseTo(30 + SEMICIRCLE_LENGTH)
  })

  it('agrees with the data-model package\'s own tessellated area', () => {
    for (const bulge of [1, -1, 0.4, -0.25, 0]) {
      const polyline = bulgedSquare(bulge)
      // AcDbPolyline.area samples each arc into 128 segments; our closed-form
      // circular-segment result should land within that sampling error.
      expect(polylineArea(polylineVertices(polyline), true)).toBeCloseTo(polyline.area, 2)
    }
  })

  it('takes vertex positions from getPoint3dAt, never from property records', () => {
    const source = bulgedSquare(1)
    const publicPoints = polylinePoints(source)
    const polyline = withPropertyVertices(
      source,
      publicPoints.map((point) => ({ x: point.x + 1000, y: point.y, bulge: 0.5 }))
    )

    const vertices = polylineVertices(polyline)
    expect(vertices.map((vertex) => ({ x: vertex.x, y: vertex.y }))).toEqual(publicPoints)
    // The array did not describe these vertices, so none of its bulges are trusted.
    expect(vertices.every((vertex) => vertex.bulge === undefined)).toBe(true)
  })

  describe('straight-vertex fallback', () => {
    const brokenVertexValues: Array<[string, unknown]> = [
      ['the accessor returns undefined', undefined],
      ['the accessor value is not an array', 42],
      ['the vertex count does not match', [{ x: 0, y: 0, bulge: 1 }]],
      [
        'a vertex entry is not an object',
        [null, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
      ],
      [
        'a vertex entry has no numeric coordinates',
        [
          { x: '0', y: '0', bulge: 1 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 }
        ]
      ]
    ]

    it.each(brokenVertexValues)('falls back to straight vertices when %s', (_label, value) => {
      const source = bulgedSquare(1)
      const polyline = withPropertyVertices(source, value)

      const vertices = polylineVertices(polyline)
      expect(vertices).toEqual(polylinePoints(source))
      expect(vertices.every((vertex) => vertex.bulge === undefined)).toBe(true)
    })

    it('treats a non-finite bulge as a straight segment', () => {
      const source = bulgedSquare(1)
      const points = polylinePoints(source)
      const polyline = withPropertyVertices(
        source,
        points.map((point, index) => ({
          ...point,
          bulge: index === 0 ? Number.NaN : 0
        }))
      )

      expect(polylineVertices(polyline)).toEqual(points)
    })

    it('degrades measurements to the chord polygon rather than producing wrong ones', () => {
      const extraction = extractPolylineVertices(
        withPropertyVertices(bulgedSquare(1), undefined)
      )
      const fallback = extraction.vertices

      // Exactly the straight 10x10 square a bulge-unaware CAD reader would see.
      expect(extraction.bulgesVerified).toBe(false)
      expect(polylineArea(fallback, true)).toBeCloseTo(100)
      expect(polylineLength(fallback, true)).toBeCloseTo(40)
      expect(fallback).toEqual(polylineVertices(straightSquare()))
    })
  })
})
