import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AcDbDatabase,
  AcDbPolyline,
  AcGePoint2d
} from '@mlightcad/data-model'
import { executeCadTool, setCadToolTestDatabase } from './handlers'
import type { ToolResult } from './protocol'

function data(result: ToolResult): Record<string, unknown> {
  expect(result.error).toBeUndefined()
  expect(result.data).toBeDefined()
  return result.data as Record<string, unknown>
}

describe('CAD executor integration against an in-memory database', () => {
  let database: AcDbDatabase

  beforeEach(() => {
    database = new AcDbDatabase()
    setCadToolTestDatabase(database)
  })

  afterEach(() => {
    setCadToolTestDatabase(undefined)
  })

  it('imports a boundary with exact geometry and one undo record', async () => {
    const imported = data(
      await executeCadTool('import_boundary_from_csv', {
        csvText: 'x,y\n0,0\n20,0\n20,10\n0,10\n0,0'
      })
    )

    expect(imported).toMatchObject({
      vertexCount: 4,
      area: 200,
      perimeter: 60,
      layer: 'BOUNDARY'
    })
    expect(database.tables.blockTable.getEntityById(imported.entityId as string)).toBeDefined()
    expect(database.transactionManager.canUndo()).toBe(true)

    database.transactionManager.undo()
    expect(database.tables.blockTable.getEntityById(imported.entityId as string)).toBeUndefined()
    expect(database.transactionManager.canUndo()).toBe(false)
  })

  it('classifies imported point geometry as inside, outside, and intersecting', async () => {
    const boundary = data(
      await executeCadTool('import_boundary_from_csv', {
        csvText: '0,0\n20,0\n20,10\n0,10'
      })
    )
    const points = data(
      await executeCadTool('import_boundary_from_geojson', {
        geojsonText: JSON.stringify({
          type: 'FeatureCollection',
          features: [
            { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [5, 5] } },
            { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [25, 5] } },
            { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [20, 5] } }
          ]
        })
      })
    )
    const result = data(
      await executeCadTool('check_inside_boundary', {
        boundaryEntityId: boundary.entityId,
        entityIds: points.entityIds
      })
    )

    expect(result.results).toEqual(
      (points.entityIds as string[]).map((entityId, index) => ({
        entityId,
        status: ['inside', 'outside', 'intersecting'][index]
      }))
    )
    expect(points.crsNote).toContain('NOT performed')
  })

  it('uses rendered symbol footprints for overlap and exact clearance', async () => {
    const boundary = data(
      await executeCadTool('import_boundary_from_csv', {
        csvText: '0,0\n20,0\n20,10\n0,10'
      })
    )
    const insideGenerator = data(
      await executeCadTool('insert_symbol', {
        name: 'generator',
        position: { x: 10, y: 5 }
      })
    )
    const outsideGenerator = data(
      await executeCadTool('insert_symbol', {
        name: 'generator',
        position: { x: 30, y: 5 }
      })
    )

    const overlap = data(
      await executeCadTool('check_entity_overlap', {
        entityIds: [boundary.entityId, insideGenerator.entityId, outsideGenerator.entityId]
      })
    )
    expect(overlap.overlapCount).toBe(1)
    expect(overlap.overlappingPairs).toEqual([
      { entityIdA: boundary.entityId, entityIdB: insideGenerator.entityId }
    ])

    const clearance = data(
      await executeCadTool('measure_clearance', {
        fromEntityId: outsideGenerator.entityId,
        toEntityId: boundary.entityId,
        draw: true
      })
    )
    expect(clearance.distance).toBe(7)
    expect(clearance.fromClosestPoint).toEqual({ x: 27, y: 3 })
    expect(clearance.toClosestPoint).toEqual({ x: 20, y: 3 })
    expect(clearance.degradationNotes).toEqual([])
    expect(clearance.annotationEntityIds).toHaveLength(2)
    for (const id of clearance.annotationEntityIds as string[]) {
      expect(database.tables.blockTable.getEntityById(id)).toBeDefined()
    }

    database.transactionManager.undo()
    for (const id of clearance.annotationEntityIds as string[]) {
      expect(database.tables.blockTable.getEntityById(id)).toBeUndefined()
    }
    expect(
      database.tables.blockTable.getEntityById(outsideGenerator.entityId as string)
    ).toBeDefined()
  })

  it('places labelled monitoring points as one undoable operation', async () => {
    const placed = data(
      await executeCadTool('place_monitoring_points', {
        points: [{ x: 2, y: 3 }, { x: 8, y: 3 }]
      })
    )
    expect(placed.entityIds).toHaveLength(2)
    expect(placed.points).toEqual([
      expect.objectContaining({ label: 'MW-1', position: { x: 2, y: 3 } }),
      expect.objectContaining({ label: 'MW-2', position: { x: 8, y: 3 } })
    ])

    database.transactionManager.undo()
    for (const id of placed.entityIds as string[]) {
      expect(database.tables.blockTable.getEntityById(id)).toBeUndefined()
    }
    expect(database.transactionManager.canUndo()).toBe(false)
  })

  it('extracts line, polyline, circle, and symbol geometry for containment', async () => {
    const boundary = data(
      await executeCadTool('import_boundary_from_csv', {
        csvText: '0,0\n20,0\n20,10\n0,10'
      })
    )
    const insideLine = data(
      await executeCadTool('draw_line', {
        start: { x: 2, y: 2 },
        end: { x: 8, y: 2 }
      })
    )
    const crossingPolyline = data(
      await executeCadTool('draw_polyline', {
        points: [{ x: 10, y: 5 }, { x: 25, y: 5 }]
      })
    )
    const insideCircle = data(
      await executeCadTool('draw_circle', {
        center: { x: 5, y: 5 },
        radius: 1
      })
    )
    const crossingCircle = data(
      await executeCadTool('draw_circle', {
        center: { x: 20, y: 5 },
        radius: 2
      })
    )
    const insideTree = data(
      await executeCadTool('insert_symbol', {
        name: 'tree',
        position: { x: 10, y: 5 },
        scale: 0.5
      })
    )
    const entityIds = [
      insideLine.entityIds,
      crossingPolyline.entityIds,
      insideCircle.entityIds,
      crossingCircle.entityIds,
      insideTree.entityIds
    ].flat() as string[]

    const checked = data(
      await executeCadTool('check_inside_boundary', {
        boundaryEntityId: boundary.entityId,
        entityIds
      })
    )
    expect(checked.results).toEqual(
      entityIds.map((entityId, index) => ({
        entityId,
        status: ['inside', 'intersecting', 'inside', 'intersecting', 'inside'][index]
      }))
    )
  })

  it('measures every area and length executor entity branch', async () => {
    const bulged = new AcDbPolyline()
    bulged.addVertexAt(0, new AcGePoint2d(0, 0), 1)
    bulged.addVertexAt(1, new AcGePoint2d(2, 0), 1)
    bulged.closed = true
    database.tables.blockTable.modelSpace.appendEntity(bulged)

    const circle = data(
      await executeCadTool('draw_circle', {
        center: { x: 10, y: 10 },
        radius: 2
      })
    )
    const hatch = data(
      await executeCadTool('draw_hatch', {
        boundary: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 3 }]
      })
    )
    const areas = data(
      await executeCadTool('calculate_area', {
        entityIds: [
          bulged.objectId,
          ...(circle.entityIds as string[]),
          ...(hatch.entityIds as string[])
        ]
      })
    )
    expect(areas.measurements).toHaveLength(3)
    expect(areas.totalArea).toBeCloseTo(5 * Math.PI + 6)

    const line = data(
      await executeCadTool('draw_line', {
        start: { x: 0, y: 0 },
        end: { x: 3, y: 4 }
      })
    )
    const arc = data(
      await executeCadTool('draw_arc', {
        center: { x: 0, y: 0 },
        radius: 2,
        startAngleDeg: 0,
        endAngleDeg: 90
      })
    )
    const lengths = data(
      await executeCadTool('calculate_length', {
        entityIds: [
          ...(line.entityIds as string[]),
          bulged.objectId,
          ...(circle.entityIds as string[]),
          ...(arc.entityIds as string[])
        ]
      })
    )
    expect(lengths.measurements).toHaveLength(4)
    expect(lengths.totalLength).toBeCloseTo(5 + 7 * Math.PI)
  })

  it('places a radius dimension on the requested layer using the actual circle', async () => {
    data(
      await executeCadTool('create_layer', {
        name: 'AI_BENCHMARK',
        colorCss: '#00a86b'
      })
    )
    const circle = data(
      await executeCadTool('draw_circle', {
        center: { x: 30, y: 10 },
        radius: 5,
        layer: 'AI_BENCHMARK'
      })
    )
    const circleId = (circle.entityIds as string[])[0]
    const dimension = data(
      await executeCadTool('add_radius_dimension', {
        circleEntityId: circleId,
        angleDeg: 45,
        layer: 'AI_BENCHMARK'
      })
    )

    expect(dimension).toMatchObject({
      circleEntityId: circleId,
      center: { x: 30, y: 10 },
      radius: 5,
      measurement: 5,
      displayText: 'R 5.00',
      layer: 'AI_BENCHMARK'
    })
    const dimensionId = (dimension.entityIds as string[])[0]
    expect(
      database.tables.blockTable.getEntityById(dimensionId)?.layer
    ).toBe('AI_BENCHMARK')
  })
})
