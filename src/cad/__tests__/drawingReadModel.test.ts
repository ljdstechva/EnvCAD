import { describe, expect, it } from 'vitest'
import { DrawingReadModel } from '../read-model/DrawingReadModel'
import type { DrawingReadRecord } from '../read-model/DrawingReadRecord'

function record(index: number): DrawingReadRecord {
  const x = index % 1_000
  const y = Math.floor(index / 1_000)
  return {
    id: `entity-${index.toString().padStart(6, '0')}`,
    layer: `LAYER-${index % 100}`,
    type: index % 10 === 0 ? 'AcDbText' : 'AcDbLine',
    kind: index % 10 === 0 ? 'text' : 'line',
    ...(index % 10 === 0 ? { text: `Monitoring note ${index}` } : {}),
    bounds: { minX: x, minY: y, maxX: x + 0.5, maxY: y + 0.5 },
    visible: index % 7 !== 0,
    space: 'model',
    ...(index % 10 === 0 ? { annotationType: 'text' } : {})
  }
}

describe('DrawingReadModel', () => {
  it('maintains revision-stable entity, layer, type, text, spatial, visibility, space, and annotation indexes', () => {
    const model = new DrawingReadModel()
    model.replace('revision-1', Array.from({ length: 1_000 }, (_, i) => record(i)))

    expect(model.query({ entityIds: ['entity-000010'] })).toEqual([
      'entity-000010'
    ])
    expect(model.query({ layers: ['layer-3'] })).toHaveLength(10)
    expect(model.query({ types: ['AcDbText'] })).toHaveLength(100)
    expect(model.query({ textContains: 'note 20' })).toContain('entity-000020')
    expect(
      model.query({
        bounds: { minX: 9.9, minY: 0, maxX: 10.6, maxY: 0.6 }
      })
    ).toEqual(['entity-000010'])
    expect(model.query({ visible: false })).toHaveLength(143)
    expect(model.query({ space: 'paper' })).toEqual([])
    expect(model.query({ annotationTypes: ['text'] })).toHaveLength(100)
    expect(model.layerStats('layer-3')?.entityCount).toBe(10)
  })

  it('caches a stable result set for cursor pagination and invalidates atomically', () => {
    const model = new DrawingReadModel()
    model.replace('revision-1', Array.from({ length: 100 }, (_, i) => record(i)))
    const first = model.query({ layers: ['LAYER-2'] })
    const cached = model.query({ layers: ['LAYER-2'] })
    expect(cached).toBe(first)

    model.replace('revision-2', [record(102)])
    expect(model.revisionKey).toBe('revision-2')
    expect(model.query({ layers: ['LAYER-2'] })).toEqual(['entity-000102'])
    expect(model.get('entity-000002')).toBeUndefined()
  })

  it('keeps cached 100,000-entity drawing context below the 250 ms target', () => {
    const model = new DrawingReadModel()
    const fixture = Array.from({ length: 100_000 }, (_, i) => record(i))
    model.replace('release-baseline-100k', fixture)

    const query = {
      layers: ['LAYER-42'],
      visible: true,
      bounds: { minX: 0, minY: 0, maxX: 999, maxY: 100 }
    }
    const expected = model.query(query)
    const samples = Array.from({ length: 100 }, () => {
      const startedAt = performance.now()
      const cached = model.query(query)
      const elapsedMs = performance.now() - startedAt
      expect(cached).toBe(expected)
      return elapsedMs
    }).sort((left, right) => left - right)
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1]

    expect(expected.length).toBeGreaterThan(0)
    expect(p95).toBeLessThan(250)
  })
})
