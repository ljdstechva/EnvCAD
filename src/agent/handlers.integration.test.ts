import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('rejects an oversized GeoJSON entity batch before creating anything', async () => {
    const result = await executeCadTool('import_boundary_from_geojson', {
      geojsonText: JSON.stringify({
        type: 'FeatureCollection',
        features: Array.from({ length: 101 }, (_, index) => ({
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: [index, index] }
        }))
      })
    })

    expect(result.error).toContain('continue automatically in batches of 100')
    expect(result.error).toContain('No CAD change was made')
    expect(
      Array.from(database.tables.blockTable.modelSpace.newIterator())
    ).toHaveLength(0)
    expect(database.transactionManager.canUndo()).toBe(false)
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
    expect(placed.placedCount).toBe(2)
    expect(placed.labels).toEqual(['MW-1', 'MW-2'])

    database.transactionManager.undo()
    for (const id of placed.entityIds as string[]) {
      expect(database.tables.blockTable.getEntityById(id)).toBeUndefined()
    }
    expect(database.transactionManager.canUndo()).toBe(false)
  })

  it('rolls back every partial copy when an in-transaction postcondition fails', async () => {
    const first = data(
      await executeCadTool('draw_line', {
        start: { x: 0, y: 0 },
        end: { x: 5, y: 0 }
      })
    )
    const second = data(
      await executeCadTool('draw_line', {
        start: { x: 0, y: 2 },
        end: { x: 5, y: 2 }
      })
    )
    const sourceIds = [
      ...(first.entityIds as string[]),
      ...(second.entityIds as string[])
    ]
    const beforeIds = Array.from(
      database.tables.blockTable.modelSpace.newIterator()
    ).map((entity) => entity.objectId)
    const blockTable = database.tables.blockTable
    const originalLookup = blockTable.getEntityById.bind(blockTable)
    let faultInjected = false
    vi.spyOn(blockTable, 'getEntityById').mockImplementation((id) => {
      const entity = originalLookup(id)
      if (!faultInjected && entity && !sourceIds.includes(id)) {
        faultInjected = true
        return undefined
      }
      return entity
    })

    const result = await executeCadTool('copy_entities', {
      entityIds: sourceIds,
      dx: 10,
      dy: 0
    })
    const afterIds = Array.from(
      database.tables.blockTable.modelSpace.newIterator()
    ).map((entity) => entity.objectId)

    expect(faultInjected).toBe(true)
    expect(result.error).toContain(
      'A copied entity was not present before transaction commit'
    )
    expect(afterIds).toEqual(beforeIds)
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

  it('reads a 209-entity selection through bounded continuation pages', async () => {
    const ids: string[] = []
    for (let index = 0; index < 209; index += 1) {
      const drawn = data(
        await executeCadTool('draw_text', {
          position: { x: index % 20, y: Math.floor(index / 20) },
          text: `LABEL-${index.toString().padStart(3, '0')}-${'x'.repeat(120)}`,
          height: 1
        })
      )
      ids.push((drawn.entityIds as string[])[0])
    }

    const returnedIds: string[] = []
    let cursor = 0
    let pages = 0
    do {
      const page = data(
        await executeCadTool('get_selected_entities', {
          ids,
          cursor,
          pageSize: 500,
          detail: 'geometry'
        })
      )
      expect(page.selectedCount).toBe(209)
      expect(page.matchedCount).toBe(209)
      expect(JSON.stringify(page).length).toBeLessThan(32_000)
      returnedIds.push(
        ...(page.entities as Array<{ id: string }>).map((entity) => entity.id)
      )
      pages += 1
      if (!page.hasMore) break
      cursor = page.nextCursor as number
    } while (true)

    expect(pages).toBeGreaterThan(1)
    expect(returnedIds).toEqual(ids)
    expect(new Set(returnedIds).size).toBe(209)
  })

  it('discovers and edits drawing entities without any selection', async () => {
    data(
      await executeCadTool('create_layer', {
        name: 'ANNOTATION',
        colorCss: '#00a86b'
      })
    )
    const drawn = data(
      await executeCadTool('draw_text', {
        position: { x: 10, y: 20 },
        text: 'ST-01 SEPTIC TANK',
        height: 2.5,
        layer: 'ANNOTATION'
      })
    )
    const entityId = (drawn.entityIds as string[])[0]
    const discovered = data(
      await executeCadTool('list_entities', {
        layers: ['ANNOTATION'],
        kinds: ['text'],
        textContains: 'septic',
        cursor: 0,
        pageSize: 100,
        detail: 'geometry'
      })
    )

    expect(discovered.matchedCount).toBe(1)
    expect(discovered.entities).toEqual([
      expect.objectContaining({
        id: entityId,
        layer: 'ANNOTATION',
        kind: 'text'
      })
    ])

    data(
      await executeCadTool('change_text', {
        entityId,
        newText: 'ST-01 SEPTIC TANK — FORMATTED'
      })
    )
    const edited = data(
      await executeCadTool('list_entities', {
        entityIds: [entityId],
        detail: 'geometry'
      })
    )
    expect(
      (edited.entities as Array<{ geometry: { content: string } }>)[0].geometry
        .content
    ).toBe('ST-01 SEPTIC TANK — FORMATTED')

    const context = data(await executeCadTool('get_drawing_context', {}))
    const annotationLayer = (
      context.layers as Array<{
        name: string
        entityCount: number
        entityKinds: Record<string, number>
      }>
    ).find((layer) => layer.name === 'ANNOTATION')
    expect(annotationLayer).toMatchObject({
      entityCount: 1,
      entityKinds: { text: 1 }
    })
    expect(context.entityDiscovery).toEqual({
      tool: 'list_entities',
      selectionRequired: false,
      paginated: true
    })
  })

  it('reads long text and long polylines completely through continuation tools', async () => {
    const longText = ['"', '\\', '\n', '\t'].join('').repeat(7_500)
    const text = data(
      await executeCadTool('draw_text', {
        position: { x: 0, y: 0 },
        text: longText,
        height: 1
      })
    )
    const textId = (text.entityIds as string[])[0]
    const textSummary = data(
      await executeCadTool('list_entities', {
        entityIds: [textId],
        detail: 'geometry'
      })
    )
    expect(
      (
        textSummary.entities as Array<{
          geometry: { contentLength: number; contentTruncated: boolean }
        }>
      )[0].geometry
    ).toMatchObject({
      contentLength: longText.length,
      contentTruncated: true
    })

    let textCursor = 0
    let exactText = ''
    const textPageCharacters: number[] = []
    const textPageSizes: number[] = []
    do {
      const page = data(
        await executeCadTool('get_entity_text', {
          entityId: textId,
          cursor: textCursor,
          chunkSize: 16_000
        })
      )
      textPageCharacters.push(JSON.stringify(page).length)
      textPageSizes.push(page.returnedCharacters as number)
      exactText += page.content as string
      if (!page.hasMore) break
      textCursor = page.nextCursor as number
    } while (true)
    expect(exactText).toBe(longText)
    expect(Math.max(...textPageCharacters)).toBeLessThanOrEqual(28_000)
    expect(textPageSizes.some((size) => size < 16_000)).toBe(true)

    const points = Array.from({ length: 125 }, (_, index) => ({
      x: index,
      y: index % 7
    }))
    const polyline = data(
      await executeCadTool('draw_polyline', {
        points,
        closed: false
      })
    )
    const polylineId = (polyline.entityIds as string[])[0]
    let vertexCursor = 0
    const returnedVertices: Array<{ x: number; y: number }> = []
    do {
      const page = data(
        await executeCadTool('get_polyline_vertices', {
          entityId: polylineId,
          cursor: vertexCursor,
          pageSize: 40
        })
      )
      returnedVertices.push(
        ...(page.vertices as Array<{ x: number; y: number }>)
      )
      if (!page.hasMore) break
      vertexCursor = page.nextCursor as number
    } while (true)
    expect(returnedVertices.map(({ x, y }) => ({ x, y }))).toEqual(points)
  })

  it('changes existing layer properties as one undoable edit', async () => {
    data(
      await executeCadTool('create_layer', {
        name: 'PRINT_SAFE',
        colorCss: '#ffffff'
      })
    )
    const changed = data(
      await executeCadTool('set_layer_properties', {
        name: 'PRINT_SAFE',
        colorCss: '#123456',
        isOff: true,
        isFrozen: true,
        isLocked: true,
        isPlottable: false
      })
    )
    expect(changed.after).toMatchObject({
      colorCss: 'rgb(18,52,86)',
      isOff: true,
      isFrozen: true,
      isLocked: true,
      isPlottable: false
    })

    database.transactionManager.undo()
    const layer = database.tables.layerTable.getAt('PRINT_SAFE')
    expect(layer?.color.RGB).toBe(0xffffff)
    expect(layer?.isOff).toBe(false)
    expect(layer?.isFrozen).toBe(false)
    expect(layer?.isLocked).toBe(false)
    expect(layer?.isPlottable).toBe(true)
  })

  it('matches CAD layer names case-insensitively and reports canonical names and visibility', async () => {
    data(
      await executeCadTool('create_layer', {
        name: 'MixedCase',
        colorCss: '#00a86b'
      })
    )
    const text = data(
      await executeCadTool('draw_text', {
        position: { x: 4, y: 5 },
        text: 'Case-insensitive layer lookup',
        height: 1,
        layer: 'mixedcase'
      })
    )
    const entityId = (text.entityIds as string[])[0]

    const discovered = data(
      await executeCadTool('list_entities', {
        layers: ['MIXEDCASE']
      })
    )
    expect(discovered.matchedCount).toBe(1)
    expect(discovered.entities).toEqual([
      expect.objectContaining({ id: entityId, layer: 'MixedCase' })
    ])

    const reassigned = data(
      await executeCadTool('set_entity_layer', {
        entityIds: [entityId],
        layerName: 'mIxEdCaSe'
      })
    )
    expect(reassigned).toMatchObject({
      layerName: 'MixedCase',
      layerCreated: false
    })
    expect(database.tables.blockTable.getEntityById(entityId)?.layer).toBe(
      'MixedCase'
    )

    data(
      await executeCadTool('set_layer_properties', {
        name: 'MIXEDCASE',
        isOff: true
      })
    )
    const context = data(await executeCadTool('get_drawing_context', {}))
    expect(context.entityCount).toBe(1)
    expect(context.visibleEntityCount).toBe(0)
    expect(
      (
        context.layers as Array<{
          name: string
          entityCount: number
        }>
      ).find((layer) => layer.name === 'MixedCase')
    ).toMatchObject({
      entityCount: 1
    })
  })

  it('continues through more than 100 layers without losing any names', async () => {
    const createdNames = Array.from(
      { length: 125 },
      (_, index) => `AI_LAYER_${index.toString().padStart(3, '0')}`
    )
    for (const name of createdNames) {
      data(await executeCadTool('create_layer', { name }))
    }

    const context = data(await executeCadTool('get_drawing_context', {}))
    expect(context.layerCount).toBe(createdNames.length)
    expect(context.layersReturnedCount).toBe(100)
    expect(context.layersHasMore).toBe(true)
    expect(context.layersNextCursor).toBe(100)

    const returnedNames: string[] = []
    let cursor = 0
    do {
      const page = data(
        await executeCadTool('list_layers', {
          cursor,
          pageSize: 30
        })
      )
      expect(JSON.stringify(page).length).toBeLessThan(32_000)
      returnedNames.push(
        ...(page.layers as Array<{ name: string }>).map((layer) => layer.name)
      )
      if (!page.hasMore) break
      cursor = page.nextCursor as number
    } while (true)

    expect(returnedNames).toHaveLength(createdNames.length)
    expect(new Set(returnedNames)).toEqual(new Set(createdNames))
  })

  it('reports entity color modes and makes explicit white inherit its layer', async () => {
    const line = data(
      await executeCadTool('draw_line', {
        start: { x: 0, y: 0 },
        end: { x: 10, y: 0 }
      })
    )
    const entityId = (line.entityIds as string[])[0]
    data(
      await executeCadTool('set_entity_color', {
        entityIds: [entityId],
        mode: 'explicit',
        colorCss: '#ffffff'
      })
    )
    const explicit = data(
      await executeCadTool('list_entities', {
        entityIds: [entityId]
      })
    )
    expect(
      (
        explicit.entities as Array<{
          style: { color: { mode: string; rgb: number } }
        }>
      )[0].style.color
    ).toMatchObject({
      mode: 'explicit-rgb',
      rgb: 0xffffff
    })

    data(
      await executeCadTool('set_entity_color', {
        entityIds: [entityId],
        mode: 'by-layer'
      })
    )
    const inherited = data(
      await executeCadTool('list_entities', {
        entityIds: [entityId]
      })
    )
    expect(
      (
        inherited.entities as Array<{
          style: { color: { mode: string } }
        }>
      )[0].style.color.mode
    ).toBe('by-layer')

    database.transactionManager.undo()
    expect(database.tables.blockTable.getEntityById(entityId)?.color.RGB).toBe(
      0xffffff
    )
  })

  it('finds drawing-wide text-overlap clusters without a selection', async () => {
    const overlappingIds: string[] = []
    for (const text of ['FIRST NOTE', 'SECOND NOTE']) {
      const drawn = data(
        await executeCadTool('draw_text', {
          position: { x: 10, y: 10 },
          text,
          height: 2.5
        })
      )
      overlappingIds.push((drawn.entityIds as string[])[0])
    }
    data(
      await executeCadTool('draw_text', {
        position: { x: 100, y: 100 },
        text: 'SEPARATE NOTE',
        height: 2.5
      })
    )

    const overlaps = data(
      await executeCadTool('find_text_overlaps', {
        minimumGap: 0
      })
    )
    expect(overlaps.textEntityCount).toBe(3)
    expect(overlaps.overlapClusterCount).toBe(1)
    expect(overlaps.clusters).toEqual([
      expect.objectContaining({
        entityCount: 2,
        entityIds: overlappingIds
      })
    ])
  })

  it('splits a 209-member overlap cluster into bounded, lossless continuation segments', async () => {
    const ids: string[] = []
    for (let index = 0; index < 209; index += 1) {
      const drawn = data(
        await executeCadTool('draw_text', {
          position: { x: 10, y: 10 },
          text: `OVERLAP-${index.toString().padStart(3, '0')}`,
          height: 2.5
        })
      )
      ids.push((drawn.entityIds as string[])[0])
    }

    const returnedIds: string[] = []
    const memberCursors: number[] = []
    let cursor = 0
    let pages = 0
    do {
      const page = data(
        await executeCadTool('find_text_overlaps', {
          minimumGap: 0,
          cursor,
          pageSize: 1
        })
      )
      expect(page.textEntityCount).toBe(209)
      expect(page.overlapClusterCount).toBe(1)
      expect(page.clusterSegmentCount).toBe(3)
      expect(JSON.stringify(page).length).toBeLessThan(32_000)
      const segment = (
        page.clusters as Array<{
          clusterIndex: number
          entityCount: number
          memberCursor: number
          entityIds: string[]
        }>
      )[0]
      expect(segment).toMatchObject({
        clusterIndex: 0,
        entityCount: 209
      })
      memberCursors.push(segment.memberCursor)
      returnedIds.push(...segment.entityIds)
      pages += 1
      if (!page.hasMore) break
      cursor = page.nextCursor as number
    } while (true)

    expect(pages).toBe(3)
    expect(memberCursors).toEqual([0, 100, 200])
    expect(returnedIds).toHaveLength(209)
    expect(new Set(returnedIds)).toEqual(new Set(ids))
  })
})
