import { describe, expect, it } from 'vitest'
import {
  createVisualFixtureDxf,
  visualFixtureExpectation
} from '../scripts/visualFixtures'

describe('visual acceptance fixtures', () => {
  it('uses two distinct hidden marker arrangements', () => {
    const first = visualFixtureExpectation('a')
    const second = visualFixtureExpectation('b')
    expect(first.markers).toHaveLength(4)
    expect(second.markers).toHaveLength(4)
    expect(second.markers).not.toEqual(first.markers)
    expect(new Set(first.markers.map((marker) => marker.shape))).toEqual(
      new Set(['circle', 'square', 'triangle'])
    )
    expect(new Set(second.markers.map((marker) => marker.shape))).toEqual(
      new Set(['circle', 'square', 'triangle'])
    )
  })

  it.each(['a', 'b', 'blank', 'defect'] as const)(
    'creates a complete text-free %s DXF with opaque layers',
    (id) => {
      const dxf = createVisualFixtureDxf(id)
      expect(dxf).toContain('$INSUNITS\n70\n6')
      expect(dxf).toMatch(/\n2\n\*Model_Space\n/)
      expect(dxf).toMatch(/\n0\nEOF\n$/)
      expect(dxf).not.toMatch(
        /square|triangle|top-left|top-right|bottom-left|bottom-right|red|yellow|green|cyan|blue|magenta|visual|marker|fixture|acceptance/i
      )
      expect(dxf).not.toMatch(/\n0\n(?:TEXT|MTEXT)\n/)
      for (const layer of dxf.matchAll(/\n0\nLAYER[\s\S]*?\n2\n([^\n]+)/g)) {
        expect(layer[1]).toMatch(/^L\d+$/)
      }
    }
  )
})
