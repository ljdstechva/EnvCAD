import { describe, expect, it } from 'vitest'
import { AcDbPolyline, AcGePoint2d } from '@mlightcad/data-model'
import { polylineArea, polylineLength } from '../geometry'
import { polylinePoints, polylineVertices } from '../polyline'

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

/**
 * A polyline whose public vertex API still works but whose private geometry
 * has been replaced — i.e. exactly what a @mlightcad/data-model upgrade that
 * reshapes the internal representation would look like to our bulge reader.
 */
function withInternalGeometry(source: AcDbPolyline, geometry: unknown): AcDbPolyline {
  const points = polylinePoints(source)
  return {
    numberOfVertices: points.length,
    getPoint3dAt: (index: number) => ({ x: points[index].x, y: points[index].y, z: 0 }),
    _geo: geometry
  } as unknown as AcDbPolyline
}

const SEMICIRCLE_AREA = (Math.PI * 5 * 5) / 2
const SEMICIRCLE_LENGTH = Math.PI * 5

describe('polylineVertices bulge extraction', () => {
  it('reads bulges from the data-model geometry when it lines up with the public vertices', () => {
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

  it('takes vertex positions from the public API, never from the internal geometry', () => {
    const source = bulgedSquare(1)
    const publicPoints = polylinePoints(source)
    const polyline = withInternalGeometry(source, {
      // Same length and shape, but coordinates that disagree with getPoint3dAt.
      vertices: publicPoints.map((point) => ({ x: point.x + 1000, y: point.y, bulge: 0.5 }))
    })

    const vertices = polylineVertices(polyline)
    expect(vertices.map((vertex) => ({ x: vertex.x, y: vertex.y }))).toEqual(publicPoints)
    // The array did not describe these vertices, so none of its bulges are trusted.
    expect(vertices.every((vertex) => vertex.bulge === undefined)).toBe(true)
  })

  describe('straight-vertex fallback', () => {
    const brokenGeometries: Array<[string, unknown]> = [
      ['the internal field is missing entirely', undefined],
      ['the internal field is not an object', 42],
      ['the vertex array is missing', {}],
      ['the vertex array is not an array', { vertices: { 0: { x: 0, y: 0, bulge: 1 } } }],
      ['the vertex count does not match', { vertices: [{ x: 0, y: 0, bulge: 1 }] }],
      [
        'a vertex entry is not an object',
        { vertices: [null, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] }
      ],
      [
        'a vertex entry has no numeric coordinates',
        {
          vertices: [
            { x: '0', y: '0', bulge: 1 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
            { x: 0, y: 10 }
          ]
        }
      ]
    ]

    it.each(brokenGeometries)('falls back to straight vertices when %s', (_label, geometry) => {
      const source = bulgedSquare(1)
      const polyline = withInternalGeometry(source, geometry)

      const vertices = polylineVertices(polyline)
      expect(vertices).toEqual(polylinePoints(source))
      expect(vertices.every((vertex) => vertex.bulge === undefined)).toBe(true)
    })

    it('treats a non-finite bulge as a straight segment', () => {
      const source = bulgedSquare(1)
      const points = polylinePoints(source)
      const polyline = withInternalGeometry(source, {
        vertices: points.map((point, index) => ({
          ...point,
          bulge: index === 0 ? Number.NaN : 0
        }))
      })

      expect(polylineVertices(polyline)).toEqual(points)
    })

    it('degrades measurements to the chord polygon rather than producing wrong ones', () => {
      const fallback = polylineVertices(withInternalGeometry(bulgedSquare(1), undefined))

      // Exactly the straight 10x10 square a bulge-unaware CAD reader would see.
      expect(polylineArea(fallback, true)).toBeCloseTo(100)
      expect(polylineLength(fallback, true)).toBeCloseTo(40)
      expect(fallback).toEqual(polylineVertices(straightSquare()))
    })
  })
})
