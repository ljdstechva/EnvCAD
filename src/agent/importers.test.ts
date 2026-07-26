import { describe, expect, it } from 'vitest'
import { parseBoundaryCsv, parseSupportedGeoJson } from './importers'

describe('parseBoundaryCsv', () => {
  it('parses a header and five coordinate rows', () => {
    expect(parseBoundaryCsv('x,y\n0,0\n100,0\n100,60\n0,60\n0,0')).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 60 },
      { x: 0, y: 60 },
      { x: 0, y: 0 }
    ])
  })

  it('accepts quoted numeric fields without a header', () => {
    expect(parseBoundaryCsv('"0","0"\n"4","0"\n"0","3"')).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 0, y: 3 }
    ])
  })

  it('reports malformed rows precisely', () => {
    expect(() => parseBoundaryCsv('x,y\n0,0\n4\n0,3')).toThrow(
      'CSV row 3 must contain exactly two columns'
    )
  })
})

describe('parseSupportedGeoJson', () => {
  it('extracts Point, LineString, and every Polygon ring', () => {
    const parsed = parseSupportedGeoJson(
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [2, 3] } },
          {
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: [[0, 0], [5, 5]] }
          },
          {
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'Polygon',
              coordinates: [
                [[0, 0], [10, 0], [10, 10], [0, 0]],
                [[2, 2], [3, 2], [3, 3], [2, 2]]
              ]
            }
          }
        ]
      })
    )

    expect(parsed.map((geometry) => geometry.kind)).toEqual([
      'point',
      'polyline',
      'polyline',
      'polyline'
    ])
    expect(parsed[1]).toMatchObject({ closed: false, featureIndex: 1 })
    expect(parsed[2]).toMatchObject({ closed: true, featureIndex: 2, ringIndex: 0 })
  })

  it('rejects unsupported geometry types instead of silently skipping them', () => {
    expect(() =>
      parseSupportedGeoJson(
        JSON.stringify({ type: 'MultiPoint', coordinates: [[0, 0], [1, 1]] })
      )
    ).toThrow('unsupported geometry type: MultiPoint')
  })
})
