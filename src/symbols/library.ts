import {
  AcDbBlockTableRecord,
  AcDbCircle,
  AcDbLine,
  AcDbPolyline,
  AcDbSolid,
  AcDbText,
  AcGePoint2d,
  AcGePoint3d,
  type AcDbDatabase,
  type AcDbEntity
} from '@mlightcad/data-model'
import type { EntityGeometry, Point2D } from '../geo/geometry'

export const SYMBOL_NAMES = [
  'monitoring well',
  'storage tank',
  'generator',
  'drain arrow',
  'tree',
  'north arrow'
] as const

export type SymbolName = (typeof SYMBOL_NAMES)[number]

export const SYMBOL_BLOCK_PREFIX = 'ENVCAD_SYMBOL_'

function blockName(name: SymbolName): string {
  return `${SYMBOL_BLOCK_PREFIX}${name.toUpperCase().replaceAll(' ', '_')}`
}

function point3D(x: number, y: number): AcGePoint3d {
  return new AcGePoint3d(x, y, 0)
}

function line(x1: number, y1: number, x2: number, y2: number): AcDbLine {
  const entity = new AcDbLine(point3D(x1, y1), point3D(x2, y2))
  entity.layer = '0'
  return entity
}

function circle(x: number, y: number, radius: number): AcDbCircle {
  const entity = new AcDbCircle(point3D(x, y), radius)
  entity.layer = '0'
  return entity
}

function polyline(points: Point2D[], closed: boolean): AcDbPolyline {
  const entity = new AcDbPolyline()
  points.forEach((point, index) => entity.addVertexAt(index, new AcGePoint2d(point.x, point.y)))
  entity.closed = closed
  entity.layer = '0'
  return entity
}

function text(contents: string, x: number, y: number, height: number): AcDbText {
  const entity = new AcDbText()
  entity.position = point3D(x, y)
  entity.textString = contents
  entity.height = height
  entity.layer = '0'
  return entity
}

function triangle(a: Point2D, b: Point2D, c: Point2D): AcDbSolid {
  const entity = new AcDbSolid()
  entity.setPointAt(0, point3D(a.x, a.y))
  entity.setPointAt(1, point3D(b.x, b.y))
  entity.setPointAt(2, point3D(c.x, c.y))
  entity.setPointAt(3, point3D(c.x, c.y))
  entity.layer = '0'
  return entity
}

function monitoringWellEntities(label?: string): AcDbEntity[] {
  return [
    circle(0, 0, 1),
    line(-1.5, 0, 1.5, 0),
    line(0, -1.5, 0, 1.5),
    ...(label ? [text(label, 1.8, -0.4, 1)] : [])
  ]
}

function symbolEntities(name: SymbolName): AcDbEntity[] {
  switch (name) {
    case 'monitoring well':
      return monitoringWellEntities()
    case 'storage tank':
      return [circle(0, 0, 3), circle(0, 0, 2.4), line(-3, 0, 3, 0)]
    case 'generator':
      return [
        polyline(
          [
            { x: -3, y: -2 },
            { x: 3, y: -2 },
            { x: 3, y: 2 },
            { x: -3, y: 2 }
          ],
          true
        ),
        line(-2.2, -1.2, 2.2, 1.2),
        line(-2.2, 1.2, 2.2, -1.2)
      ]
    case 'drain arrow':
      return [
        line(-3, 0, 2, 0),
        triangle({ x: 3, y: 0 }, { x: 1.5, y: 0.8 }, { x: 1.5, y: -0.8 })
      ]
    case 'tree':
      return [circle(0, 0, 2.5), circle(-1, 0.8, 1.5), circle(1, 0.7, 1.4), circle(0, -1, 1.6)]
    case 'north arrow':
      return [
        line(0, -3, 0, 2.5),
        triangle({ x: 0, y: 4 }, { x: -1, y: 1.5 }, { x: 1, y: 1.5 }),
        line(-0.45, 4.4, -0.45, 5.9),
        line(-0.45, 5.9, 0.45, 4.4),
        line(0.45, 4.4, 0.45, 5.9)
      ]
  }
}

function appendEntities(block: AcDbBlockTableRecord, entities: AcDbEntity[]): void {
  for (const entity of entities) block.appendEntity(entity)
}

/** Ensures one reusable library block exists and returns its stable block name. */
export function ensureSymbolBlock(db: AcDbDatabase, name: SymbolName): {
  blockName: string
  created: boolean
} {
  const nameInTable = blockName(name)
  if (db.tables.blockTable.has(nameInTable)) return { blockName: nameInTable, created: false }

  const block = new AcDbBlockTableRecord()
  block.name = nameInTable
  block.origin = point3D(0, 0)
  appendEntities(block, symbolEntities(name))
  db.tables.blockTable.add(block)
  return { blockName: nameInTable, created: true }
}

/** Creates a uniquely labelled monitoring-well block inside the caller's undo transaction. */
export function createMonitoringPointBlock(
  db: AcDbDatabase,
  nameInTable: string,
  label: string
): void {
  if (db.tables.blockTable.has(nameInTable)) {
    throw new Error(`Monitoring block already exists: ${nameInTable}`)
  }
  const block = new AcDbBlockTableRecord()
  block.name = nameInTable
  block.origin = point3D(0, 0)
  appendEntities(block, monitoringWellEntities(label))
  db.tables.blockTable.add(block)
}

function rotateAndScale(
  point: Point2D,
  position: Point2D,
  rotationDeg: number,
  scale: number
): Point2D {
  const radians = (rotationDeg * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return {
    x: position.x + scale * (point.x * cos - point.y * sin),
    y: position.y + scale * (point.x * sin + point.y * cos)
  }
}

/** Exact 2D footprint used by predicates for EnvCAD's own symbol inserts. */
export function symbolClearanceGeometry(
  name: SymbolName,
  position: Point2D,
  rotationDeg: number,
  scale: number
): EntityGeometry {
  const transform = (point: Point2D) => rotateAndScale(point, position, rotationDeg, scale)
  switch (name) {
    case 'monitoring well':
      return {
        kind: 'composite',
        parts: [
          { kind: 'circle', center: { ...position }, radius: Math.abs(scale) },
          {
            kind: 'segment',
            start: transform({ x: -1.5, y: 0 }),
            end: transform({ x: 1.5, y: 0 })
          },
          {
            kind: 'segment',
            start: transform({ x: 0, y: -1.5 }),
            end: transform({ x: 0, y: 1.5 })
          }
        ]
      }
    case 'storage tank':
      return { kind: 'circle', center: { ...position }, radius: 3 * scale }
    case 'generator':
      return {
        kind: 'polyline',
        points: [
          transform({ x: -3, y: -2 }),
          transform({ x: 3, y: -2 }),
          transform({ x: 3, y: 2 }),
          transform({ x: -3, y: 2 })
        ],
        closed: true
      }
    case 'drain arrow':
      return {
        kind: 'composite',
        parts: [
          {
            kind: 'segment',
            start: transform({ x: -3, y: 0 }),
            end: transform({ x: 2, y: 0 })
          },
          {
            kind: 'polyline',
            points: [
              transform({ x: 3, y: 0 }),
              transform({ x: 1.5, y: 0.8 }),
              transform({ x: 1.5, y: -0.8 })
            ],
            closed: true
          }
        ]
      }
    case 'tree':
      return {
        kind: 'composite',
        parts: [
          { kind: 'circle', center: { ...position }, radius: 2.5 * Math.abs(scale) },
          {
            kind: 'circle',
            center: transform({ x: -1, y: 0.8 }),
            radius: 1.5 * Math.abs(scale)
          },
          {
            kind: 'circle',
            center: transform({ x: 1, y: 0.7 }),
            radius: 1.4 * Math.abs(scale)
          },
          {
            kind: 'circle',
            center: transform({ x: 0, y: -1 }),
            radius: 1.6 * Math.abs(scale)
          }
        ]
      }
    case 'north arrow':
      return {
        kind: 'composite',
        parts: [
          {
            kind: 'segment',
            start: transform({ x: 0, y: -3 }),
            end: transform({ x: 0, y: 2.5 })
          },
          {
            kind: 'polyline',
            points: [
              transform({ x: 0, y: 4 }),
              transform({ x: -1, y: 1.5 }),
              transform({ x: 1, y: 1.5 })
            ],
            closed: true
          },
          {
            kind: 'segment',
            start: transform({ x: -0.45, y: 4.4 }),
            end: transform({ x: -0.45, y: 5.9 })
          },
          {
            kind: 'segment',
            start: transform({ x: -0.45, y: 5.9 }),
            end: transform({ x: 0.45, y: 4.4 })
          },
          {
            kind: 'segment',
            start: transform({ x: 0.45, y: 4.4 }),
            end: transform({ x: 0.45, y: 5.9 })
          }
        ]
      }
  }
}

export function symbolNameFromBlock(block: string): SymbolName | null {
  return (
    SYMBOL_NAMES.find((name) => blockName(name) === block) ??
    null
  )
}
