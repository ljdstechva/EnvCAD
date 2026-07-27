import { describe, expect, it } from 'vitest'
import { parseDxfLayerTrueColors } from './dxfLayerColors'

describe('parseDxfLayerTrueColors', () => {
  it('reads true colours only from LAYER records', () => {
    const source = [
      '0', 'SECTION', '2', 'TABLES',
      '0', 'LAYER', '2', 'AI_BENCHMARK', '62', '256', '420', '43115',
      '0', 'LAYER', '2', 'INDEXED_ONLY', '62', '3',
      '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'TEXT', '2', 'NOT_A_LAYER', '420', '16711680',
      '0', 'ENDSEC', '0', 'EOF', ''
    ].join('\r\n')

    expect([...parseDxfLayerTrueColors(source)]).toEqual([
      ['AI_BENCHMARK', 0x00a86b]
    ])
  })

  it('ignores malformed and out-of-range true colours', () => {
    const source = [
      '0', 'LAYER', '2', 'NEGATIVE', '420', '-1',
      '0', 'LAYER', '2', 'TOO_LARGE', '420', '16777216',
      '0', 'LAYER', '2', 'NOT_INTEGER', '420', '12.5',
      '0', 'EOF', ''
    ].join('\n')

    expect(parseDxfLayerTrueColors(source).size).toBe(0)
  })
})
