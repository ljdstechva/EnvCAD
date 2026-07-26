import { describe, expect, it } from 'vitest'
import {
  SYMBOL_NAMES,
  symbolClearanceGeometry,
  symbolNameFromBlock
} from './library'

describe('symbol library', () => {
  it('defines every requested symbol name', () => {
    expect(SYMBOL_NAMES).toEqual([
      'monitoring well',
      'storage tank',
      'generator',
      'drain arrow',
      'tree',
      'north arrow'
    ])
  })

  it('transforms the generator footprint by scale and rotation', () => {
    expect(symbolClearanceGeometry('generator', { x: 10, y: 20 }, 90, 2)).toEqual({
      kind: 'polyline',
      points: [
        { x: 14, y: 14 },
        { x: 14, y: 26 },
        { x: 6, y: 26 },
        { x: 6, y: 14 }
      ],
      closed: true
    })
  })

  it('covers every rendered monitoring-well primitive', () => {
    expect(symbolClearanceGeometry('monitoring well', { x: 10, y: 20 }, 90, 2)).toEqual({
      kind: 'composite',
      parts: [
        { kind: 'circle', center: { x: 10, y: 20 }, radius: 2 },
        {
          kind: 'segment',
          start: { x: 10, y: 17 },
          end: { x: 10, y: 23 }
        },
        {
          kind: 'segment',
          start: { x: 13, y: 20 },
          end: { x: 7, y: 20 }
        }
      ]
    })
  })

  it('retains the full tree, arrowhead, and vector-N predicate geometry', () => {
    const tree = symbolClearanceGeometry('tree', { x: 0, y: 0 }, 0, 1)
    expect(tree.kind).toBe('composite')
    if (tree.kind === 'composite') expect(tree.parts).toHaveLength(4)

    const drain = symbolClearanceGeometry('drain arrow', { x: 0, y: 0 }, 0, 1)
    expect(drain.kind).toBe('composite')
    if (drain.kind === 'composite') {
      expect(drain.parts[1]).toMatchObject({ kind: 'polyline', closed: true })
    }

    const north = symbolClearanceGeometry('north arrow', { x: 0, y: 0 }, 0, 1)
    expect(north.kind).toBe('composite')
    if (north.kind === 'composite') expect(north.parts).toHaveLength(5)
  })

  it('recognizes only EnvCAD library block names', () => {
    expect(symbolNameFromBlock('ENVCAD_SYMBOL_STORAGE_TANK')).toBe('storage tank')
    expect(symbolNameFromBlock('OTHER_BLOCK')).toBeNull()
  })
})
