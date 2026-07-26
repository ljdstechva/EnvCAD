import { AcApDocManager, acapRunDatabaseEdit } from '@mlightcad/cad-simple-viewer'
import {
  AcCmColor,
  AcDbArc,
  AcDbCircle,
  AcDbEntity,
  AcDbHatch,
  AcDbHatchPatternType,
  AcDbHatchStyle,
  AcDbLayerTableRecord,
  AcDbLine,
  AcDbMText,
  AcDbPolyline,
  AcDbText,
  AcDbUnitsValue,
  AcGeLine2d,
  AcGeLoop2d,
  AcGeMatrix3d,
  AcGePoint2d,
  AcGePoint3d,
  HATCH_PATTERN_SOLID,
  type AcDbDatabase
} from '@mlightcad/data-model'
import { sheetStore } from '../sheet/sheetStore'
import { PAPER_SIZES, type PaperSizeId, type SheetDefinition } from '../sheet/types'
import { agentBridge, type ToolHandler } from './bridge'
import {
  boundingBoxCenter,
  distance,
  polylineLength,
  shoelaceArea,
  unionBoundingBoxes,
  withoutDuplicateClosingVertex,
  type BoundingBox2D,
  type Point2D,
  type PolylineVertex
} from './geometry'
import { CAD_TOOL_NAMES, type ToolResult } from './protocol'

type InputRecord = Record<string, unknown>

function errorResult(err: unknown): ToolResult {
  return { error: err instanceof Error ? err.message : String(err) }
}

function asRecord(value: unknown, toolName: string): InputRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${toolName} input must be an object`)
  }
  return value as InputRecord
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`)
  }
  return value
}

function positiveNumber(value: unknown, field: string): number {
  const result = finiteNumber(value, field)
  if (result <= 0) throw new Error(`${field} must be greater than zero`)
  return result
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value.trim()
}

function point2D(value: unknown, field: string): Point2D {
  const record = asRecord(value, field)
  return {
    x: finiteNumber(record.x, `${field}.x`),
    y: finiteNumber(record.y, `${field}.y`)
  }
}

function pointArray(value: unknown, field: string, minimum: number): Point2D[] {
  if (!Array.isArray(value) || value.length < minimum) {
    throw new Error(`${field} must contain at least ${minimum} points`)
  }
  return value.map((point, index) => point2D(point, `${field}[${index}]`))
}

function entityIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('entityIds must contain at least one id')
  }
  const ids = value.map((id, index) => nonEmptyString(id, `entityIds[${index}]`))
  return [...new Set(ids)]
}

function currentDatabase(): AcDbDatabase {
  return AcApDocManager.instance.curDocument.database
}

function drawingUnits(db = currentDatabase()): string {
  return AcDbUnitsValue[db.insunits as AcDbUnitsValue] ?? 'Unknown'
}

function runEdit<T>(label: string, callback: () => T): T {
  const db = currentDatabase()
  let result!: T
  acapRunDatabaseEdit(db, label, () => {
    result = callback()
  })
  return result
}

function resolveEntities(ids: string[], db = currentDatabase()): AcDbEntity[] {
  const entities = ids.map((id) => db.tables.blockTable.getEntityById(id))
  const missing = ids.filter((_, index) => !entities[index])
  if (missing.length > 0) throw new Error(`Entity id(s) not found: ${missing.join(', ')}`)
  return entities as AcDbEntity[]
}

function entityBox(entity: AcDbEntity): BoundingBox2D | null {
  const extents = entity.geometricExtents
  if (extents.isEmpty()) return null
  return {
    min: { x: extents.min.x, y: extents.min.y },
    max: { x: extents.max.x, y: extents.max.y }
  }
}

function commonCenter(entities: AcDbEntity[]): Point2D {
  const box = unionBoundingBoxes(
    entities.map(entityBox).filter((value): value is BoundingBox2D => value !== null)
  )
  if (!box) throw new Error('Cannot determine a center for entities with empty extents')
  return boundingBoxCenter(box)
}

function polylinePoints(polyline: AcDbPolyline): Point2D[] {
  const points: Point2D[] = []
  for (let index = 0; index < polyline.numberOfVertices; index++) {
    const point = polyline.getPoint3dAt(index)
    points.push({ x: point.x, y: point.y })
  }
  return points
}

function polylineVertices(polyline: AcDbPolyline): PolylineVertex[] {
  const geometry = (
    polyline as unknown as {
      _geo?: { vertices?: Array<{ x: number; y: number; bulge?: number }> }
    }
  )._geo
  if (geometry?.vertices?.length === polyline.numberOfVertices) {
    return geometry.vertices.map((vertex) => ({
      x: vertex.x,
      y: vertex.y,
      ...(vertex.bulge === undefined ? {} : { bulge: vertex.bulge })
    }))
  }
  return polylinePoints(polyline)
}

function point3D(point: Point2D): AcGePoint3d {
  return new AcGePoint3d(point.x, point.y, 0)
}

function ensureLayerExists(layerName: string, db = currentDatabase()): void {
  if (!db.tables.layerTable.has(layerName)) {
    throw new Error(`Layer not found: ${layerName}`)
  }
}

function createLayerRecord(
  db: AcDbDatabase,
  name: string,
  colorCss?: string
): { created: boolean; colorCss: string } {
  const existing = db.tables.layerTable.getAt(name)
  if (existing) {
    return { created: false, colorCss: existing.color.cssColor ?? '#ffffff' }
  }

  const color = colorCss ? parseCssColor(colorCss) : undefined
  const layer = new AcDbLayerTableRecord({
    name,
    isOff: false,
    isPlottable: true,
    linetype: 'Continuous',
    ...(color ? { color } : {})
  })
  db.tables.layerTable.add(layer)
  return { created: true, colorCss: layer.color.cssColor ?? colorCss ?? '#ffffff' }
}

function parseCssColor(value: string): AcCmColor {
  const normalized = value.trim()
  if (normalized.startsWith('#') && !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(normalized)) {
    throw new Error(`Invalid layer color: ${value}`)
  }
  const functionalMatch = normalized.match(
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*(?:0(?:\.\d+)?|1(?:\.0+)?))?\s*\)$/i
  )
  if (
    normalized.toLowerCase().startsWith('rgb') &&
    (!functionalMatch || functionalMatch.slice(1, 4).some((component) => Number(component) > 255))
  ) {
    throw new Error(`Invalid layer color: ${value}`)
  }

  const color = new AcCmColor().setRGBFromCss(normalized)
  if (color.RGB === undefined) throw new Error(`Invalid layer color: ${value}`)
  return color
}

function layerFromInput(input: InputRecord): string | undefined {
  return input.layer === undefined ? undefined : nonEmptyString(input.layer, 'layer')
}

function appendEntity(entity: AcDbEntity, layer?: string): string {
  const db = currentDatabase()
  if (layer) {
    ensureLayerExists(layer, db)
    entity.layer = layer
  }
  db.tables.blockTable.modelSpace.appendEntity(entity)
  return entity.objectId
}

function bboxData(entity: AcDbEntity) {
  const extents = entity.geometricExtents
  return extents.isEmpty()
    ? null
    : {
        min: { x: extents.min.x, y: extents.min.y, z: extents.min.z },
        max: { x: extents.max.x, y: extents.max.y, z: extents.max.z }
      }
}

function geometrySummary(entity: AcDbEntity): Record<string, unknown> {
  if (entity instanceof AcDbPolyline) {
    const vertices = polylinePoints(entity)
    return {
      kind: 'polyline',
      vertices: vertices.slice(0, 50),
      vertexCount: vertices.length,
      truncated: vertices.length > 50
    }
  }
  if (entity instanceof AcDbCircle) {
    return {
      kind: 'circle',
      center: { x: entity.center.x, y: entity.center.y, z: entity.center.z },
      radius: entity.radius
    }
  }
  if (entity instanceof AcDbMText) {
    return {
      kind: 'text',
      content: entity.contents,
      position: { x: entity.location.x, y: entity.location.y, z: entity.location.z }
    }
  }
  if (entity instanceof AcDbText) {
    return {
      kind: 'text',
      content: entity.textString,
      position: { x: entity.position.x, y: entity.position.y, z: entity.position.z }
    }
  }
  if (entity instanceof AcDbLine) {
    return {
      kind: 'line',
      start: { x: entity.startPoint.x, y: entity.startPoint.y, z: entity.startPoint.z },
      end: { x: entity.endPoint.x, y: entity.endPoint.y, z: entity.endPoint.z }
    }
  }
  if (entity instanceof AcDbArc) {
    return {
      kind: 'arc',
      center: { x: entity.center.x, y: entity.center.y, z: entity.center.z },
      radius: entity.radius,
      startAngleDeg: (entity.startAngle * 180) / Math.PI,
      endAngleDeg: (entity.endAngle * 180) / Math.PI
    }
  }
  return { kind: entity.type }
}

function getSelectedEntities(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'get_selected_entities')
  if (!Array.isArray(input.ids) || !input.ids.every((id) => typeof id === 'string')) {
    throw new Error('ids must be an array of strings')
  }
  const ids = [...new Set(input.ids as string[])]
  const db = currentDatabase()
  const entities: Record<string, unknown>[] = []
  const missingIds: string[] = []

  for (const id of ids) {
    const entity = db.tables.blockTable.getEntityById(id)
    if (!entity) {
      missingIds.push(id)
      continue
    }
    const summary: Record<string, unknown> = {
      id: entity.objectId,
      type: entity.type,
      layer: entity.layer,
      geometry: geometrySummary(entity),
      bbox: bboxData(entity)
    }
    if (
      entity instanceof AcDbPolyline ||
      entity instanceof AcDbCircle ||
      entity instanceof AcDbArc ||
      entity instanceof AcDbLine
    ) {
      summary.closed = entity.closed
    }
    entities.push(summary)
  }

  return { data: { units: drawingUnits(db), entities, missingIds } }
}

/** Reads units, layers, current layer, and extents from the live database. */
function getDrawingContext(): ToolResult {
  const db = currentDatabase()
  const layers: { name: string; colorCss: string; isOff: boolean }[] = []
  for (const layer of db.tables.layerTable.newIterator()) {
    layers.push({
      name: layer.name,
      colorCss: layer.color.cssColor ?? '#ffffff',
      isOff: layer.isOff
    })
  }

  const storedExtents = db.extents
  const fallbackExtents = Array.from(db.tables.blockTable.modelSpace.newIterator())
    .map((entity) => entity.geometricExtents)
    .filter((extents) => !extents.isEmpty())
  const extents =
    storedExtents.isEmpty() && fallbackExtents.length > 0
      ? {
          min: {
            x: Math.min(...fallbackExtents.map((value) => value.min.x)),
            y: Math.min(...fallbackExtents.map((value) => value.min.y)),
            z: Math.min(...fallbackExtents.map((value) => value.min.z))
          },
          max: {
            x: Math.max(...fallbackExtents.map((value) => value.max.x)),
            y: Math.max(...fallbackExtents.map((value) => value.max.y)),
            z: Math.max(...fallbackExtents.map((value) => value.max.z))
          }
        }
      : storedExtents.isEmpty()
        ? null
        : {
            min: { x: storedExtents.min.x, y: storedExtents.min.y, z: storedExtents.min.z },
            max: { x: storedExtents.max.x, y: storedExtents.max.y, z: storedExtents.max.z }
          }
  return {
    data: {
      units: drawingUnits(db),
      currentLayer: db.clayer,
      layers,
      extents
    }
  }
}

function moveEntities(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'move_entities')
  const ids = entityIds(input.entityIds)
  const dx = finiteNumber(input.dx, 'dx')
  const dy = finiteNumber(input.dy, 'dy')
  const db = currentDatabase()
  const entities = resolveEntities(ids, db)
  runEdit('Agent: move_entities', () => {
    const count = AcApDocManager.instance.curDocument.entityService.translateEntities(entities, {
      x: dx,
      y: dy,
      z: 0
    })
    if (count !== entities.length) throw new Error('Not every entity could be opened for move')
  })
  return { data: { entityIds: ids, dx, dy } }
}

function copyEntities(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'copy_entities')
  const ids = entityIds(input.entityIds)
  const dx = finiteNumber(input.dx, 'dx')
  const dy = finiteNumber(input.dy, 'dy')
  const entities = resolveEntities(ids)
  const copies = runEdit('Agent: copy_entities', () =>
    AcApDocManager.instance.curDocument.entityService.cloneAndTransform(
      entities,
      new AcGeMatrix3d().makeTranslation(dx, dy, 0)
    )
  )
  const newIds = copies.map((entity) => entity.objectId)
  if (newIds.length !== entities.length) throw new Error('Not every entity could be copied')
  return { data: { entityIds: newIds, sourceEntityIds: ids, dx, dy } }
}

function rotateEntities(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'rotate_entities')
  const ids = entityIds(input.entityIds)
  const angleDeg = finiteNumber(input.angleDeg, 'angleDeg')
  const entities = resolveEntities(ids)
  const center = input.center === undefined ? commonCenter(entities) : point2D(input.center, 'center')
  runEdit('Agent: rotate_entities', () => {
    const count = AcApDocManager.instance.curDocument.entityService.rotateEntities(
      entities,
      { ...center, z: 0 },
      (angleDeg * Math.PI) / 180
    )
    if (count !== entities.length) throw new Error('Not every entity could be opened for rotation')
  })
  return { data: { entityIds: ids, angleDeg, center } }
}

function scaleEntities(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'scale_entities')
  const ids = entityIds(input.entityIds)
  const factor = positiveNumber(input.factor, 'factor')
  const entities = resolveEntities(ids)
  const center = input.center === undefined ? commonCenter(entities) : point2D(input.center, 'center')
  const matrix = new AcGeMatrix3d()
    .makeTranslation(center.x, center.y, 0)
    .multiply(new AcGeMatrix3d().makeScale(factor, factor, factor))
    .multiply(new AcGeMatrix3d().makeTranslation(-center.x, -center.y, 0))
  runEdit('Agent: scale_entities', () => {
    const count = AcApDocManager.instance.curDocument.entityService.transformEntities(entities, matrix)
    if (count !== entities.length) throw new Error('Not every entity could be opened for scaling')
  })
  return { data: { entityIds: ids, factor, center } }
}

function deleteEntities(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'delete_entities')
  const ids = entityIds(input.entityIds)
  resolveEntities(ids)
  runEdit('Agent: delete_entities', () => {
    const count = AcApDocManager.instance.curDocument.entityService.eraseEntities(ids)
    if (count !== ids.length) throw new Error('Not every entity could be deleted')
  })
  return { data: { entityIds: ids } }
}

function setEntityLayer(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'set_entity_layer')
  const ids = entityIds(input.entityIds)
  const layerName = nonEmptyString(input.layerName, 'layerName')
  const db = currentDatabase()
  resolveEntities(ids, db)
  const layerCreated = runEdit('Agent: set_entity_layer', () => {
    const created = createLayerRecord(db, layerName).created
    for (const id of ids) {
      const entity = db.openEntityForWrite(id) as AcDbEntity | undefined
      if (!entity) throw new Error(`Entity could not be opened for write: ${id}`)
      entity.layer = layerName
    }
    return created
  })
  return { data: { entityIds: ids, layerName, layerCreated } }
}

function changeText(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'change_text')
  const id = nonEmptyString(input.entityId, 'entityId')
  if (typeof input.newText !== 'string') throw new Error('newText must be a string')
  const entity = resolveEntities([id])[0]
  if (!(entity instanceof AcDbText) && !(entity instanceof AcDbMText)) {
    throw new Error(`Entity ${id} is ${entity.type}, not TEXT or MTEXT`)
  }
  runEdit('Agent: change_text', () => {
    const opened = currentDatabase().openEntityForWrite(id)
    if (opened instanceof AcDbText) opened.textString = input.newText as string
    else if (opened instanceof AcDbMText) opened.contents = input.newText as string
    else throw new Error(`Text entity could not be opened for write: ${id}`)
  })
  return { data: { entityIds: [id], text: input.newText } }
}

function calculateArea(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'calculate_area')
  const ids = entityIds(input.entityIds)
  const entities = resolveEntities(ids)
  const openIds = entities
    .filter((entity) => {
      if (
        entity instanceof AcDbPolyline ||
        entity instanceof AcDbCircle ||
        entity instanceof AcDbArc ||
        entity instanceof AcDbLine
      ) {
        return !entity.closed
      }
      return false
    })
    .map((entity) => entity.objectId)
  if (openIds.length > 0) throw new Error(`Area requires closed entities; open entity id(s): ${openIds.join(', ')}`)

  const measurements = entities.map((entity) => {
    let area: number
    if (entity instanceof AcDbPolyline) area = shoelaceArea(polylinePoints(entity))
    else if (entity instanceof AcDbCircle) area = Math.PI * entity.radius * entity.radius
    else if (entity instanceof AcDbHatch) area = entity.area
    else throw new Error(`Area is not supported for entity ${entity.objectId} (${entity.type})`)
    return { entityId: entity.objectId, area }
  })
  const units = drawingUnits()
  return {
    data: {
      entityIds: ids,
      units: `${units}²`,
      totalArea: measurements.reduce((total, item) => total + item.area, 0),
      measurements
    }
  }
}

function arcSweepRadians(arc: AcDbArc): number {
  const tau = Math.PI * 2
  const normalized = ((arc.endAngle - arc.startAngle) % tau + tau) % tau
  return normalized === 0 && arc.closed ? tau : normalized
}

function calculateLength(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'calculate_length')
  const ids = entityIds(input.entityIds)
  const entities = resolveEntities(ids)
  const measurements = entities.map((entity) => {
    let length: number
    if (entity instanceof AcDbLine) length = distance(entity.startPoint, entity.endPoint)
    else if (entity instanceof AcDbPolyline) {
      length = polylineLength(polylineVertices(entity), entity.closed)
    } else if (entity instanceof AcDbCircle) length = 2 * Math.PI * entity.radius
    else if (entity instanceof AcDbArc) length = arcSweepRadians(entity) * entity.radius
    else throw new Error(`Length is not supported for entity ${entity.objectId} (${entity.type})`)
    return { entityId: entity.objectId, length }
  })
  return {
    data: {
      entityIds: ids,
      units: drawingUnits(),
      totalLength: measurements.reduce((total, item) => total + item.length, 0),
      measurements
    }
  }
}

function drawLine(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'draw_line')
  const start = point2D(input.start, 'start')
  const end = point2D(input.end, 'end')
  const layer = layerFromInput(input)
  if (layer) ensureLayerExists(layer)
  const id = runEdit('Agent: draw_line', () =>
    appendEntity(new AcDbLine(point3D(start), point3D(end)), layer)
  )
  return { data: { entityIds: [id], start, end, layer: layer ?? currentDatabase().clayer } }
}

function drawPolyline(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'draw_polyline')
  const points = pointArray(input.points, 'points', 2)
  if (input.closed !== undefined && typeof input.closed !== 'boolean') {
    throw new Error('closed must be a boolean')
  }
  const closed = input.closed === true
  const layer = layerFromInput(input)
  if (layer) ensureLayerExists(layer)
  const id = runEdit('Agent: draw_polyline', () => {
    const polyline = new AcDbPolyline()
    points.forEach((point, index) => polyline.addVertexAt(index, new AcGePoint2d(point.x, point.y)))
    polyline.closed = closed
    return appendEntity(polyline, layer)
  })
  return { data: { entityIds: [id], points, closed, layer: layer ?? currentDatabase().clayer } }
}

function drawRectangle(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'draw_rectangle')
  const corner1 = point2D(input.corner1, 'corner1')
  const corner2 = point2D(input.corner2, 'corner2')
  if (corner1.x === corner2.x || corner1.y === corner2.y) {
    throw new Error('Rectangle corners must define non-zero width and height')
  }
  const points = [
    corner1,
    { x: corner2.x, y: corner1.y },
    corner2,
    { x: corner1.x, y: corner2.y }
  ]
  const layer = layerFromInput(input)
  if (layer) ensureLayerExists(layer)
  const id = runEdit('Agent: draw_rectangle', () => {
    const polyline = new AcDbPolyline()
    points.forEach((point, index) => polyline.addVertexAt(index, new AcGePoint2d(point.x, point.y)))
    polyline.closed = true
    return appendEntity(polyline, layer)
  })
  return { data: { entityIds: [id], corner1, corner2, layer: layer ?? currentDatabase().clayer } }
}

function drawCircle(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'draw_circle')
  const center = point2D(input.center, 'center')
  const radius = positiveNumber(input.radius, 'radius')
  const layer = layerFromInput(input)
  if (layer) ensureLayerExists(layer)
  const id = runEdit('Agent: draw_circle', () =>
    appendEntity(new AcDbCircle(point3D(center), radius), layer)
  )
  return { data: { entityIds: [id], center, radius, layer: layer ?? currentDatabase().clayer } }
}

function drawArc(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'draw_arc')
  const center = point2D(input.center, 'center')
  const radius = positiveNumber(input.radius, 'radius')
  const startAngleDeg = finiteNumber(input.startAngleDeg, 'startAngleDeg')
  const endAngleDeg = finiteNumber(input.endAngleDeg, 'endAngleDeg')
  const layer = layerFromInput(input)
  if (layer) ensureLayerExists(layer)
  const id = runEdit('Agent: draw_arc', () =>
    appendEntity(
      new AcDbArc(
        point3D(center),
        radius,
        (startAngleDeg * Math.PI) / 180,
        (endAngleDeg * Math.PI) / 180
      ),
      layer
    )
  )
  return {
    data: {
      entityIds: [id],
      center,
      radius,
      startAngleDeg,
      endAngleDeg,
      layer: layer ?? currentDatabase().clayer
    }
  }
}

function drawText(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'draw_text')
  const position = point2D(input.position, 'position')
  if (typeof input.text !== 'string') throw new Error('text must be a string')
  const height = input.height === undefined ? 2.5 : positiveNumber(input.height, 'height')
  const layer = layerFromInput(input)
  if (layer) ensureLayerExists(layer)
  const id = runEdit('Agent: draw_text', () => {
    const text = new AcDbText()
    text.position = point3D(position)
    text.textString = input.text as string
    text.height = height
    return appendEntity(text, layer)
  })
  return {
    data: { entityIds: [id], position, text: input.text, height, layer: layer ?? currentDatabase().clayer }
  }
}

function createClosedBoundary(points: Point2D[]): AcGeLoop2d {
  const vertices = withoutDuplicateClosingVertex(points)
  const loop = new AcGeLoop2d()
  for (let index = 0; index < vertices.length; index++) {
    const start = vertices[index]
    const end = vertices[(index + 1) % vertices.length]
    loop.add(
      new AcGeLine2d(new AcGePoint2d(start.x, start.y), new AcGePoint2d(end.x, end.y))
    )
  }
  return loop
}

function drawHatch(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'draw_hatch')
  const boundary = pointArray(input.boundary, 'boundary', 3)
  const vertices = withoutDuplicateClosingVertex(boundary)
  if (vertices.length < 3 || shoelaceArea(vertices) === 0) {
    throw new Error('Hatch boundary must enclose a non-zero area')
  }
  const pattern = input.pattern === undefined ? HATCH_PATTERN_SOLID : nonEmptyString(input.pattern, 'pattern')
  const layer = layerFromInput(input)
  if (layer) ensureLayerExists(layer)
  const id = runEdit('Agent: draw_hatch', () => {
    const hatch = new AcDbHatch()
    hatch.database = currentDatabase()
    hatch.patternName = pattern
    hatch.patternType = AcDbHatchPatternType.Predefined
    hatch.patternScale = 1
    hatch.patternAngle = 0
    hatch.hatchStyle = AcDbHatchStyle.Normal
    hatch.isSolidFill = pattern.toUpperCase() === HATCH_PATTERN_SOLID
    hatch.add(createClosedBoundary(vertices))
    return appendEntity(hatch, layer)
  })
  return { data: { entityIds: [id], boundary: vertices, pattern, layer: layer ?? currentDatabase().clayer } }
}

function createLayer(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'create_layer')
  const name = nonEmptyString(input.name, 'name')
  const colorCss =
    input.colorCss === undefined ? undefined : nonEmptyString(input.colorCss, 'colorCss')
  const result = runEdit('Agent: create_layer', () => createLayerRecord(currentDatabase(), name, colorCss))
  return { data: { entityIds: [], name, ...result } }
}

function setCurrentLayer(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'set_current_layer')
  const name = nonEmptyString(input.name, 'name')
  const changed = AcApDocManager.instance.curDocument.layerService.setCurrentLayer(name)
  if (!changed) throw new Error(`Layer not found: ${name}`)
  return { data: { entityIds: [], name } }
}

function zoomExtents(): ToolResult {
  AcApDocManager.instance.curView.zoomToFitDrawing()
  return { data: { zoomed: true } }
}

function setSheetDefinition(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'set_sheet_definition')
  const update: Partial<SheetDefinition> = {}
  if (input.paper !== undefined) {
    const paper = nonEmptyString(input.paper, 'paper') as PaperSizeId
    if (!(paper in PAPER_SIZES)) throw new Error(`Unsupported paper size: ${paper}`)
    update.paper = paper
  }
  if (input.orientation !== undefined) {
    if (input.orientation !== 'portrait' && input.orientation !== 'landscape') {
      throw new Error('orientation must be portrait or landscape')
    }
    update.orientation = input.orientation
  }
  if (input.scaleDenominator !== undefined) {
    update.scaleDenominator = positiveNumber(input.scaleDenominator, 'scaleDenominator')
  }
  if (input.templateId !== undefined) {
    update.templateId = nonEmptyString(input.templateId, 'templateId')
  }
  if (input.fields !== undefined) {
    const fields = asRecord(input.fields, 'fields')
    if (!Object.values(fields).every((value) => typeof value === 'string')) {
      throw new Error('fields must contain only string values')
    }
    update.fields = { ...(sheetStore.current.fields ?? {}), ...(fields as Record<string, string>) }
  }
  sheetStore.current = { ...sheetStore.current, ...update }
  return { data: { entityIds: [], sheet: { ...sheetStore.current } } }
}

function setTitleBlockFields(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'set_title_block_fields')
  const fields = asRecord(input.fields, 'fields')
  if (!Object.values(fields).every((value) => typeof value === 'string')) {
    throw new Error('fields must contain only string values')
  }
  sheetStore.current = {
    ...sheetStore.current,
    fields: { ...(sheetStore.current.fields ?? {}), ...(fields as Record<string, string>) }
  }
  return { data: { entityIds: [], fields: { ...sheetStore.current.fields } } }
}

const REAL_HANDLERS: Record<(typeof CAD_TOOL_NAMES)[number], ToolHandler> = {
  get_selected_entities: (input) => getSelectedEntities(input),
  get_drawing_context: () => getDrawingContext(),
  move_entities: (input) => moveEntities(input),
  copy_entities: (input) => copyEntities(input),
  rotate_entities: (input) => rotateEntities(input),
  scale_entities: (input) => scaleEntities(input),
  delete_entities: (input) => deleteEntities(input),
  set_entity_layer: (input) => setEntityLayer(input),
  change_text: (input) => changeText(input),
  calculate_area: (input) => calculateArea(input),
  calculate_length: (input) => calculateLength(input),
  draw_line: (input) => drawLine(input),
  draw_polyline: (input) => drawPolyline(input),
  draw_rectangle: (input) => drawRectangle(input),
  draw_circle: (input) => drawCircle(input),
  draw_arc: (input) => drawArc(input),
  draw_text: (input) => drawText(input),
  draw_hatch: (input) => drawHatch(input),
  create_layer: (input) => createLayer(input),
  set_current_layer: (input) => setCurrentLayer(input),
  zoom_extents: () => zoomExtents(),
  set_sheet_definition: (input) => setSheetDefinition(input),
  set_title_block_fields: (input) => setTitleBlockFields(input)
}

/** Registers deterministic browser implementations for every CAD agent tool. */
export function registerCadHandlers() {
  for (const name of CAD_TOOL_NAMES) {
    const handler = REAL_HANDLERS[name]
    agentBridge.registerHandler(name, (input) => {
      try {
        return handler(input)
      } catch (err) {
        return errorResult(err)
      }
    })
  }
}
