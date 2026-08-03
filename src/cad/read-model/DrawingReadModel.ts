import { DrawingSpatialIndex } from './DrawingSpatialIndex'
import {
  drawingBoundsIntersect,
  unionDrawingBounds
} from './DrawingBounds'
import type {
  DrawingBounds,
  DrawingLayerStatistics,
  DrawingReadQuery,
  DrawingReadRecord
} from './DrawingReadRecord'

export class DrawingReadModel {
  private revision = ''
  private records = new Map<string, DrawingReadRecord>()
  private orderedIds: string[] = []
  private readonly indexes = new Map<string, Map<string, Set<string>>>()
  private readonly queryCache = new Map<string, readonly string[]>()
  private readonly layerStatistics = new Map<string, DrawingLayerStatistics>()
  private spatial = new DrawingSpatialIndex()
  private drawingExtents: DrawingBounds | undefined

  get revisionKey(): string {
    return this.revision
  }

  replace(revisionKey: string, records: Iterable<DrawingReadRecord>): void {
    const next = [...records]
    const byId = new Map<string, DrawingReadRecord>()
    for (const record of next) {
      if (byId.has(record.id)) {
        throw new Error(`Duplicate drawing entity id "${record.id}".`)
      }
      byId.set(record.id, { ...record })
    }
    this.revision = revisionKey
    this.records = byId
    this.orderedIds = next.map(({ id }) => id)
    this.indexes.clear()
    this.queryCache.clear()
    this.layerStatistics.clear()
    this.spatial = new DrawingSpatialIndex()
    this.drawingExtents = undefined
    for (const record of next) this.index(record)
  }

  invalidate(): void {
    this.revision = ''
    this.records.clear()
    this.orderedIds = []
    this.indexes.clear()
    this.queryCache.clear()
    this.layerStatistics.clear()
    this.spatial = new DrawingSpatialIndex()
    this.drawingExtents = undefined
  }

  query(query: DrawingReadQuery): readonly string[] {
    const key = JSON.stringify(normalizedQuery(query))
    const cached = this.queryCache.get(key)
    if (cached) return cached
    const candidateIds = this.candidates(query)
    const result = this.orderedIds.filter((id) => {
      if (!candidateIds.has(id)) return false
      const record = this.records.get(id)!
      return matches(record, query)
    })
    this.queryCache.set(key, result)
    return result
  }

  get(id: string): DrawingReadRecord | undefined {
    const record = this.records.get(id)
    return record ? { ...record } : undefined
  }

  get size(): number {
    return this.records.size
  }

  get visibleCount(): number {
    return this.index('visible').get(key('true'))?.size ?? 0
  }

  layerStats(layer: string): DrawingLayerStatistics | undefined {
    return this.layerStatistics.get(key(layer))
  }

  extents(): DrawingBounds | undefined {
    return this.drawingExtents ? { ...this.drawingExtents } : undefined
  }

  private candidates(query: DrawingReadQuery): Set<string> {
    const sets: ReadonlySet<string>[] = []
    this.addIndexedCandidates(sets, 'id', query.entityIds)
    this.addIndexedCandidates(sets, 'layer', query.layers)
    this.addIndexedCandidates(sets, 'type', query.types)
    this.addIndexedCandidates(sets, 'kind', query.kinds)
    this.addIndexedCandidates(sets, 'annotation', query.annotationTypes)
    if (query.visible !== undefined) {
      sets.push(
        this.index('visible').get(key(String(query.visible))) ?? new Set()
      )
    }
    if (query.space) {
      sets.push(this.index('space').get(key(query.space)) ?? new Set())
    }
    const spatial = query.bounds
      ? this.spatial.candidates(query.bounds)
      : undefined
    if (spatial) sets.push(spatial)
    if (sets.length === 0) return new Set(this.orderedIds)
    const [smallest, ...rest] = [...sets].sort((a, b) => a.size - b.size)
    return new Set([...smallest].filter((id) => rest.every((set) => set.has(id))))
  }

  private addIndexedCandidates(
    target: ReadonlySet<string>[],
    name: string,
    values: readonly string[] | undefined
  ): void {
    if (!values) return
    const union = new Set<string>()
    for (const value of values) {
      for (const id of this.index(name).get(key(value)) ?? []) union.add(id)
    }
    target.push(union)
  }

  private index(recordOrName: DrawingReadRecord | string): Map<string, Set<string>> {
    if (typeof recordOrName === 'string') {
      return this.indexes.get(recordOrName) ?? new Map()
    }
    const record = recordOrName
    this.addIndex('id', record.id, record.id)
    this.addIndex('layer', record.layer, record.id)
    this.addIndex('type', record.type, record.id)
    this.addIndex('kind', record.kind, record.id)
    this.addIndex('visible', String(record.visible), record.id)
    this.addIndex('space', record.space, record.id)
    if (record.annotationType) {
      this.addIndex('annotation', record.annotationType, record.id)
    }
    this.addLayerStatistic(record)
    this.spatial.add(record)
    if (record.bounds) {
      this.drawingExtents = this.drawingExtents
        ? unionDrawingBounds(this.drawingExtents, record.bounds)
        : { ...record.bounds }
    }
    return new Map()
  }

  private addIndex(name: string, value: string, id: string): void {
    const index = this.indexes.get(name) ?? new Map<string, Set<string>>()
    const members = index.get(key(value)) ?? new Set<string>()
    members.add(id)
    index.set(key(value), members)
    this.indexes.set(name, index)
  }

  private addLayerStatistic(record: DrawingReadRecord): void {
    const layer = key(record.layer)
    const current = this.layerStatistics.get(layer)
    const kinds = new Map(current?.entityKinds ?? [])
    kinds.set(record.kind, (kinds.get(record.kind) ?? 0) + 1)
    this.layerStatistics.set(layer, {
      entityCount: (current?.entityCount ?? 0) + 1,
      entityKinds: kinds
    })
  }
}

function normalizedQuery(query: DrawingReadQuery): DrawingReadQuery {
  const sorted = (values?: readonly string[]) =>
    values ? [...new Set(values.map(key))].sort() : undefined
  return {
    ...query,
    entityIds: sorted(query.entityIds),
    layers: sorted(query.layers),
    types: sorted(query.types),
    kinds: sorted(query.kinds),
    annotationTypes: sorted(query.annotationTypes),
    textContains: query.textContains?.toLocaleLowerCase()
  }
}

function matches(record: DrawingReadRecord, query: DrawingReadQuery): boolean {
  if (
    query.textContains &&
    !record.text?.toLocaleLowerCase().includes(query.textContains.toLocaleLowerCase())
  ) {
    return false
  }
  return (
    !query.bounds ||
    (record.bounds ? drawingBoundsIntersect(record.bounds, query.bounds) : false)
  )
}

const key = (value: string) => value.toLocaleUpperCase()
