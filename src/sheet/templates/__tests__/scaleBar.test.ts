import { describe, expect, it } from 'vitest'

import { computeScaleBarLayout, niceRoundNumber } from '../scaleBar'

describe('niceRoundNumber', () => {
  it.each([
    [0.5, 0.5],
    [1, 1],
    [1.9, 1],
    [2, 2],
    [4.9, 2],
    [5, 5],
    [7.5, 5],
    [9.9, 5],
    [10, 10],
    [23, 20],
    [75, 50]
  ])('rounds %f down to the nearest nice number %f', (input, expected) => {
    expect(niceRoundNumber(input)).toBeCloseTo(expected)
  })

  it('returns 0 for non-positive input', () => {
    expect(niceRoundNumber(0)).toBe(0)
    expect(niceRoundNumber(-5)).toBe(0)
  })
})

describe('computeScaleBarLayout', () => {
  it('computes mathematically correct segments at 1:500 in meters', () => {
    // 1mm on paper = 500mm real world = 0.5m; a 60mm target bar therefore
    // spans at most 30m, split into 4 segments of ~7.5m each, rounded down
    // to a nice 5m per segment (10mm of paper per segment).
    const layout = computeScaleBarLayout(60, 500, 'm')

    expect(layout.segmentValue).toBe(5)
    expect(layout.segmentCount).toBe(4)
    expect(layout.segmentWidthMm).toBeCloseTo(10)
    expect(layout.totalWidthMm).toBeCloseTo(40)
    expect(layout.labels).toEqual([0, 5, 10, 15, 20])
  })

  it('computes correct segments at 1:200 in meters', () => {
    // 1mm on paper = 200mm real = 0.2m; 60mm target -> 12m max, /4 = 3m
    // rough segments, rounded down to a nice 2m (10mm of paper per segment).
    const layout = computeScaleBarLayout(60, 200, 'm')

    expect(layout.segmentValue).toBe(2)
    expect(layout.segmentWidthMm).toBeCloseTo(10)
    expect(layout.totalWidthMm).toBeCloseTo(40)
    expect(layout.labels).toEqual([0, 2, 4, 6, 8])
  })

  it('computes correct segments in millimeters', () => {
    // 1:100 in mm: 1mm paper = 100mm real. 40mm target -> 4000mm max, /4 =
    // 1000mm rough per segment, already a nice round number.
    const layout = computeScaleBarLayout(40, 100, 'mm')

    expect(layout.segmentValue).toBe(1000)
    expect(layout.segmentWidthMm).toBeCloseTo(10)
    expect(layout.totalWidthMm).toBeCloseTo(40)
    expect(layout.labels).toEqual([0, 1000, 2000, 3000, 4000])
  })

  it('never exceeds the requested target width', () => {
    for (const denominator of [50, 100, 200, 250, 500, 1000]) {
      const layout = computeScaleBarLayout(60, denominator, 'm')
      expect(layout.totalWidthMm).toBeLessThanOrEqual(60 + 1e-9)
    }
  })

  it('supports a custom segment count', () => {
    const layout = computeScaleBarLayout(60, 500, 'm', 5)
    expect(layout.segmentCount).toBe(5)
    expect(layout.labels).toHaveLength(6)
  })
})
