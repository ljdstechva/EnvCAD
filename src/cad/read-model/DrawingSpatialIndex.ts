import type {
  DrawingBounds,
  DrawingReadRecord
} from './DrawingReadRecord'

const DEFAULT_CELL_SIZE = 100
const MAX_ENTITY_CELLS = 256
const MAX_QUERY_CELLS = 10_000

export class DrawingSpatialIndex {
  private readonly cells = new Map<string, Set<string>>()
  private readonly global = new Set<string>()

  constructor(private readonly cellSize = DEFAULT_CELL_SIZE) {}

  add(record: DrawingReadRecord): void {
    if (!record.bounds) return
    const cells = this.cellsFor(record.bounds, MAX_ENTITY_CELLS)
    if (!cells) {
      this.global.add(record.id)
      return
    }
    for (const key of cells) {
      const members = this.cells.get(key) ?? new Set<string>()
      members.add(record.id)
      this.cells.set(key, members)
    }
  }

  candidates(bounds: DrawingBounds): ReadonlySet<string> | undefined {
    const keys = this.cellsFor(bounds, MAX_QUERY_CELLS)
    if (!keys) return undefined
    const result = new Set(this.global)
    for (const key of keys) {
      for (const id of this.cells.get(key) ?? []) result.add(id)
    }
    return result
  }

  private cellsFor(
    bounds: DrawingBounds,
    maximum: number
  ): string[] | undefined {
    const minX = Math.floor(bounds.minX / this.cellSize)
    const maxX = Math.floor(bounds.maxX / this.cellSize)
    const minY = Math.floor(bounds.minY / this.cellSize)
    const maxY = Math.floor(bounds.maxY / this.cellSize)
    const count = (maxX - minX + 1) * (maxY - minY + 1)
    if (!Number.isSafeInteger(count) || count > maximum) return undefined
    const result: string[] = []
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) result.push(`${x}:${y}`)
    }
    return result
  }
}
