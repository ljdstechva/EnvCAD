import {
  AcCmColor,
  AcDbArc,
  AcDbBlockReference,
  AcDbBlockTableRecord,
  AcDbCircle,
  AcDbEntity,
  AcDbHatch,
  AcDbHatchPatternType,
  AcDbHatchStyle,
  AcDbLayerTableRecord,
  AcDbLeader,
  AcDbLeaderAnnotationType,
  AcDbLine,
  AcDbLinetypeTableRecord,
  AcDbMText,
  AcDbPoint,
  AcDbPolyline,
  AcDbSolid,
  AcDbText,
  AcDbUnitsValue,
  AcGiMTextAttachmentPoint,
  AcGeLine2d,
  AcGeLoop2d,
  AcGeMatrix3d,
  AcGePoint2d,
  AcGePoint3d,
  HATCH_PATTERN_SOLID,
  acdbHostApplicationServices,
  type AcDbDatabase
} from '@mlightcad/data-model'
import { sheetStore } from '../sheet/sheetStore'
import { sheetUnitMismatch } from '../sheet/sheetStore'
import { sheetPreviewService } from '../sheet/previewService'
import {
  SHEET_PREVIEW_VIEWS,
  type SheetPreviewView
} from '../sheet/rasterizeSheet'
import { listTemplates } from '../sheet/templates/registry'
import { PAPER_SIZES, type PaperSizeId, type SheetDefinition } from '../sheet/types'
import { agentBridge, type ToolHandler } from './bridge'
import {
  arrowheadGeometry,
  boundingBoxCenter,
  boundingBoxDistance,
  distance,
  hasBulgeArcs,
  linearDimensionGeometry,
  polylineArea,
  polylineLength,
  shoelaceArea,
  unionBoundingBoxes,
  withoutDuplicateClosingVertex,
  type BoundingBox2D,
  type LinearDimensionOrientation,
  type Point2D
} from './geometry'
import { extractPolylineVertices, polylineVertices } from './polyline'
import { parseBoundaryCsv, parseSupportedGeoJson } from './importers'
import { CAD_TOOL_NAMES, type CadToolName, type ToolResult } from './protocol'
import {
  entityGeometriesOverlap,
  minimumDistance,
  pointInPolygon,
  polygonsOverlap,
  type EntityGeometry,
  type PolylineGeometry
} from '../geo/geometry'
import {
  SYMBOL_NAMES,
  createMonitoringPointBlock,
  ensureSymbolBlock,
  symbolClearanceGeometry,
  symbolNameFromBlock,
  type SymbolName
} from '../symbols/library'
import {
  awaitCadSessionRegeneration,
  cadSessionState,
  getCadSessionRevision,
  getCadSessionSnapshot,
  getWorkspaceRevision,
  markCadSessionDatabaseEdited,
  requireEditableCadSession
} from '../cad/session'
import { runCadDatabaseEdit } from '../cad/infrastructure/mlightcad/MlightCadUndoGroupAdapter'
import {
  cloneAndTransformEntities,
  eraseEntities as eraseCadEntities,
  transformEntities
} from '../cad/tools/entities/MlightCadEntityMutations'
import {
  fitDrawingToScreen,
  verifyCurrentCadExtentsFit
} from '../cad/fitDrawing'
import { DrawingReadModel } from '../cad/read-model/DrawingReadModel'
import type { DrawingReadRecord } from '../cad/read-model/DrawingReadRecord'
import {
  drawingVisionService,
  type OverlayBox
} from '../cad/vision/DrawingVisionService'

type InputRecord = Record<string, unknown>

let testDatabaseOverride: AcDbDatabase | undefined
let testReadModelRevision = 0
const drawingReadModel = new DrawingReadModel()

const DIMENSION_LAYER = 'DIMENSIONS'
const BOUNDARY_LAYER = 'BOUNDARY'
const CLEARANCE_LAYER = 'CLEARANCE'
const MONITORING_LAYER = 'MONITORING'
const IMPORT_LAYER = 'IMPORT'
const CHORD_DEGRADATION_NOTE =
  'Polyline bulges were approximated by straight chord geometry for this predicate; arc data were present or could not be verified through the public API.'
const NO_REPROJECTION_NOTE =
  'Coordinates were used as-is; CRS reprojection was NOT performed.'
const DEFAULT_ENTITY_PAGE_SIZE = 100
const MAX_ENTITY_PAGE_SIZE = 500
const MAX_ENTITY_PAGE_CHARACTERS = 28_000
const MAX_ENTITY_TEXT_PREVIEW_CHARACTERS = 2_000
const DEFAULT_TEXT_CHUNK_SIZE = 8_000
const MAX_TEXT_CHUNK_SIZE = 16_000
const DEFAULT_VERTEX_PAGE_SIZE = 100
const MAX_VERTEX_PAGE_SIZE = 500
const MAX_OVERLAP_CLUSTER_MEMBER_COUNT = 100
const MAX_OVERLAP_CLUSTER_RECORD_CHARACTERS = 20_000
const MAX_OVERLAP_CLUSTER_LAYER_PREVIEW = 20
const MAX_IMPORTED_GEOMETRIES_PER_BATCH = 100
const MAX_FIELD_KEY_PREVIEW = 25

type EntityDetailLevel = 'summary' | 'geometry'
type EntityKind =
  | 'text'
  | 'line'
  | 'polyline'
  | 'circle'
  | 'arc'
  | 'block'
  | 'point'
  | 'hatch'
  | 'leader'
  | 'solid'
  | 'other'

function layerKey(name: string): string {
  return name.toUpperCase()
}

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

function boundedInteger(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined) return fallback
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${field} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value.trim()
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`)
  return value
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
  return testDatabaseOverride ?? requireEditableCadSession().database
}

/**
 * Headless integration-test seam. Runtime callers never set this value; tests
 * can exercise database-backed executors without constructing a viewer/WebGL
 * document manager.
 */
export function setCadToolTestDatabase(database: AcDbDatabase | undefined): void {
  testDatabaseOverride = database
  testReadModelRevision += 1
  drawingReadModel.invalidate()
  if (database) acdbHostApplicationServices().workingDatabase = database
}

function drawingUnits(db = currentDatabase()): string {
  return AcDbUnitsValue[db.insunits as AcDbUnitsValue] ?? 'Unknown'
}

function runEdit<T>(label: string, callback: () => T): T {
  const db = currentDatabase()
  const result = runCadDatabaseEdit(db, label, callback)
  if (!testDatabaseOverride) markCadSessionDatabaseEdited()
  else testReadModelRevision += 1
  drawingReadModel.invalidate()
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

function point3D(point: Point2D): AcGePoint3d {
  return new AcGePoint3d(point.x, point.y, 0)
}

function ensureLayerExists(layerName: string, db = currentDatabase()): void {
  if (!db.tables.layerTable.has(layerName)) {
    throw new Error(`Layer not found: ${layerName}`)
  }
}

function canonicalLayerName(
  layerName: string,
  db = currentDatabase()
): string {
  const layer = db.tables.layerTable.getAt(layerName)
  if (!layer) throw new Error(`Layer not found: ${layerName}`)
  return layer.name
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
    entity.layer = canonicalLayerName(layer, db)
  }
  db.tables.blockTable.modelSpace.appendEntity(entity)
  return entity.objectId
}

function annotationLayer(input: InputRecord, db = currentDatabase()): {
  name: string
  created: boolean
} {
  const name = layerFromInput(input) ?? DIMENSION_LAYER
  const { created } = createLayerRecord(db, name)
  return { name: canonicalLayerName(name, db), created }
}

function nextAnnotationBlockName(db = currentDatabase()): string {
  let suffix = 1
  while (db.tables.blockTable.has(`ENVCAD_DIM_${suffix}`)) suffix += 1
  return `ENVCAD_DIM_${suffix}`
}

function localPoint(point: Point2D, origin: Point2D): Point2D {
  return { x: point.x - origin.x, y: point.y - origin.y }
}

function blockLine(start: Point2D, end: Point2D, origin: Point2D): AcDbLine {
  const line = new AcDbLine(point3D(localPoint(start, origin)), point3D(localPoint(end, origin)))
  line.layer = '0'
  return line
}

function blockMText(
  position: Point2D,
  origin: Point2D,
  contents: string,
  height: number,
  rotation = 0,
  attachmentPoint = AcGiMTextAttachmentPoint.MiddleCenter
): AcDbMText {
  const text = new AcDbMText()
  text.location = point3D(localPoint(position, origin))
  text.contents = contents
  text.height = height
  text.rotation = rotation
  text.attachmentPoint = attachmentPoint
  text.layer = '0'
  return text
}

function blockArrow(
  arrow: ReturnType<typeof arrowheadGeometry>,
  origin: Point2D
): AcDbSolid {
  const solid = new AcDbSolid()
  const tip = point3D(localPoint(arrow.tip, origin))
  const baseLeft = point3D(localPoint(arrow.baseLeft, origin))
  const baseRight = point3D(localPoint(arrow.baseRight, origin))
  solid.setPointAt(0, tip)
  solid.setPointAt(1, baseLeft)
  solid.setPointAt(2, baseRight)
  solid.setPointAt(3, baseRight)
  solid.layer = '0'
  return solid
}

function annotationScale(measurement: number): number {
  return Math.min(2.5, Math.max(0.25, measurement / 10))
}

function appendAnnotationBlock(
  db: AcDbDatabase,
  block: AcDbBlockTableRecord,
  origin: Point2D,
  layer: string
): { entityId: string; blockName: string } {
  db.tables.blockTable.add(block)
  const insert = new AcDbBlockReference(block.name)
  insert.position = point3D(origin)
  insert.layer = layer
  db.tables.blockTable.modelSpace.appendEntity(insert)
  return { entityId: insert.objectId, blockName: block.name }
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

function entityText(entity: AcDbEntity): string | undefined {
  if (entity instanceof AcDbMText) return entity.contents
  if (entity instanceof AcDbText) return entity.textString
  return undefined
}

function boundedText(content: string): {
  content: string
  contentLength: number
  contentTruncated: boolean
} {
  const contentTruncated = content.length > MAX_ENTITY_TEXT_PREVIEW_CHARACTERS
  return {
    content: contentTruncated
      ? content.slice(0, MAX_ENTITY_TEXT_PREVIEW_CHARACTERS)
      : content,
    contentLength: content.length,
    contentTruncated
  }
}

function entityKind(entity: AcDbEntity): EntityKind {
  if (entity instanceof AcDbMText || entity instanceof AcDbText) return 'text'
  if (entity instanceof AcDbLine) return 'line'
  if (entity instanceof AcDbPolyline) return 'polyline'
  if (entity instanceof AcDbCircle) return 'circle'
  if (entity instanceof AcDbArc) return 'arc'
  if (entity instanceof AcDbBlockReference) return 'block'
  if (entity instanceof AcDbPoint) return 'point'
  if (entity instanceof AcDbHatch) return 'hatch'
  if (entity instanceof AcDbLeader) return 'leader'
  if (entity instanceof AcDbSolid) return 'solid'
  return 'other'
}

function colorSummary(color: AcCmColor): Record<string, unknown> {
  const mode = color.isByLayer
    ? 'by-layer'
    : color.isByBlock
      ? 'by-block'
      : color.isByACI
        ? 'aci'
        : color.isByColor
          ? 'explicit-rgb'
          : 'none'
  return {
    mode,
    value: color.toString(),
    colorIndex: color.colorIndex ?? null,
    rgb: color.RGB ?? null,
    cssColor: color.cssColor ?? null
  }
}

function entityStyleSummary(entity: AcDbEntity): Record<string, unknown> {
  const transparency = entity.transparency
  const resolvedColor = currentDatabase().tables.layerTable.has(entity.layer)
    ? entity.resolvedColor
    : entity.color
  return {
    color: colorSummary(entity.color),
    resolvedColor: colorSummary(resolvedColor),
    lineType: entity.lineType,
    lineWeight: entity.lineWeight,
    linetypeScale: entity.linetypeScale,
    visibility: entity.visibility,
    transparency: {
      mode: transparency.isByLayer
        ? 'by-layer'
        : transparency.isByBlock
          ? 'by-block'
          : transparency.isByAlpha
            ? 'explicit'
            : 'invalid',
      percentage: transparency.percentage ?? null
    }
  }
}

function geometrySummary(entity: AcDbEntity): Record<string, unknown> {
  if (entity instanceof AcDbPolyline) {
    const vertices = polylineVertices(entity)
    return {
      kind: 'polyline',
      // Vertices carry an AutoCAD bulge when the following segment is a
      // circular arc rather than a straight line.
      vertices: vertices.slice(0, 50),
      vertexCount: vertices.length,
      truncated: vertices.length > 50,
      hasArcSegments: hasBulgeArcs(vertices)
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
      ...boundedText(entity.contents),
      position: { x: entity.location.x, y: entity.location.y, z: entity.location.z },
      height: entity.height,
      width: entity.width,
      rotationDeg: (entity.rotation * 180) / Math.PI,
      attachmentPoint: entity.attachmentPoint
    }
  }
  if (entity instanceof AcDbText) {
    return {
      kind: 'text',
      ...boundedText(entity.textString),
      position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
      height: entity.height,
      rotationDeg: (entity.rotation * 180) / Math.PI
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
  if (entity instanceof AcDbBlockReference) {
    return {
      kind: 'block',
      blockName: entity.blockName,
      position: {
        x: entity.position.x,
        y: entity.position.y,
        z: entity.position.z
      },
      rotationDeg: (entity.rotation * 180) / Math.PI,
      scale: {
        x: entity.scaleFactors.x,
        y: entity.scaleFactors.y,
        z: entity.scaleFactors.z
      }
    }
  }
  if (entity instanceof AcDbPoint) {
    return {
      kind: 'point',
      position: {
        x: entity.position.x,
        y: entity.position.y,
        z: entity.position.z
      }
    }
  }
  return { kind: entity.type }
}

function entitySummary(
  entity: AcDbEntity,
  detail: EntityDetailLevel
): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    id: entity.objectId,
    type: entity.type,
    kind: entityKind(entity),
    layer: entity.layer,
    style: entityStyleSummary(entity),
    bbox: bboxData(entity)
  }
  const text = entityText(entity)
  if (detail === 'geometry') {
    summary.geometry = geometrySummary(entity)
  } else if (text !== undefined) {
    summary.text = boundedText(text)
  } else if (entity instanceof AcDbBlockReference) {
    summary.blockName = entity.blockName
    summary.position = {
      x: entity.position.x,
      y: entity.position.y,
      z: entity.position.z
    }
  }
  if (
    entity instanceof AcDbPolyline ||
    entity instanceof AcDbCircle ||
    entity instanceof AcDbArc ||
    entity instanceof AcDbLine
  ) {
    summary.closed = entity.closed
  }
  return summary
}

function readModelRevisionKey(): string {
  return testDatabaseOverride
    ? `test:${testReadModelRevision}`
    : JSON.stringify(getWorkspaceRevision())
}

function currentDrawingReadModel(
  db = currentDatabase()
): DrawingReadModel {
  const revisionKey = readModelRevisionKey()
  if (drawingReadModel.revisionKey === revisionKey) return drawingReadModel
  const visibleLayers = new Map(
    Array.from(db.tables.layerTable.newIterator()).map((layer) => [
      layerKey(layer.name),
      !layer.isOff && !layer.isFrozen
    ])
  )
  const records: DrawingReadRecord[] = Array.from(
    db.tables.blockTable.modelSpace.newIterator()
  ).map((entity) => {
    const box = entityBox(entity)
    const text = entityText(entity)
    return {
      id: entity.objectId,
      layer: entity.layer,
      type: entity.type,
      kind: entityKind(entity),
      ...(text !== undefined ? { text } : {}),
      ...(box
        ? {
            bounds: {
              minX: box.min.x,
              minY: box.min.y,
              maxX: box.max.x,
              maxY: box.max.y
            }
          }
        : {}),
      visible:
        entity.visibility &&
        visibleLayers.get(layerKey(entity.layer)) !== false,
      space: 'model',
      ...(entity instanceof AcDbText || entity instanceof AcDbMText
        ? { annotationType: 'text' }
        : entity instanceof AcDbLeader
          ? { annotationType: 'leader' }
          : {})
    }
  })
  drawingReadModel.replace(revisionKey, records)
  return drawingReadModel
}

function detailLevel(value: unknown, fallback: EntityDetailLevel): EntityDetailLevel {
  if (value === undefined) return fallback
  if (value !== 'summary' && value !== 'geometry') {
    throw new Error('detail must be "summary" or "geometry"')
  }
  return value
}

function paginateIndexedEntities(
  ids: readonly string[],
  db: AcDbDatabase,
  cursor: number,
  pageSize: number,
  detail: EntityDetailLevel
): {
  entities: Record<string, unknown>[]
  returnedCount: number
  nextCursor: number | null
  hasMore: boolean
} {
  if (cursor > ids.length) {
    throw new Error(`cursor ${cursor} is past the ${ids.length}-entity result set`)
  }
  const entities: Record<string, unknown>[] = []
  let encodedCharacters = 2
  let index = cursor
  while (index < ids.length && entities.length < pageSize) {
    const entity = db.tables.blockTable.getEntityById(ids[index])
    if (!entity) {
      throw new Error(
        'The drawing changed while reading an indexed entity page; restart at cursor 0.'
      )
    }
    const summary = entitySummary(entity, detail)
    const characters = JSON.stringify(summary).length
    if (
      entities.length > 0 &&
      encodedCharacters + characters + 1 > MAX_ENTITY_PAGE_CHARACTERS
    ) {
      break
    }
    entities.push(summary)
    encodedCharacters += characters + (entities.length > 1 ? 1 : 0)
    index += 1
  }
  return {
    entities,
    returnedCount: entities.length,
    nextCursor: index < ids.length ? index : null,
    hasMore: index < ids.length
  }
}

function paginateSelectedEntities(
  ids: readonly string[],
  db: AcDbDatabase,
  cursor: number,
  pageSize: number,
  detail: EntityDetailLevel
): {
  entities: Record<string, unknown>[]
  missingIds: string[]
  scannedCount: number
  returnedCount: number
  nextCursor: number | null
  hasMore: boolean
} {
  if (cursor > ids.length) {
    throw new Error(`cursor ${cursor} is past the ${ids.length}-entity selection`)
  }

  const entities: Record<string, unknown>[] = []
  const missingIds: string[] = []
  let encodedCharacters = 2
  let index = cursor
  while (index < ids.length && index - cursor < pageSize) {
    const id = ids[index]
    const entity = db.tables.blockTable.getEntityById(id)
    const summary = entity ? entitySummary(entity, detail) : undefined
    const encoded = JSON.stringify(summary ?? id)
    if (
      index > cursor &&
      encodedCharacters + encoded.length + 1 > MAX_ENTITY_PAGE_CHARACTERS
    ) {
      break
    }
    if (summary) entities.push(summary)
    else missingIds.push(id)
    encodedCharacters += encoded.length + (index > cursor ? 1 : 0)
    index += 1
  }

  const hasMore = index < ids.length
  return {
    entities,
    missingIds,
    scannedCount: index - cursor,
    returnedCount: entities.length,
    nextCursor: hasMore ? index : null,
    hasMore
  }
}

function queryRevision() {
  return testDatabaseOverride
    ? { documentRevision: 0, contentRevision: 0 }
    : getCadSessionRevision()
}

function getSelectedEntities(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'get_selected_entities')
  if (!Array.isArray(input.ids) || !input.ids.every((id) => typeof id === 'string')) {
    throw new Error('ids must be an array of strings')
  }
  const cursor = boundedInteger(input.cursor, 'cursor', 0, 0, Number.MAX_SAFE_INTEGER)
  const pageSize = boundedInteger(
    input.pageSize,
    'pageSize',
    DEFAULT_ENTITY_PAGE_SIZE,
    1,
    MAX_ENTITY_PAGE_SIZE
  )
  const detail = detailLevel(input.detail, 'geometry')
  const ids = [...new Set(input.ids as string[])]
  const db = currentDatabase()
  const matchedCount = ids.reduce(
    (count, id) =>
      count + (db.tables.blockTable.getEntityById(id) ? 1 : 0),
    0
  )
  const page = paginateSelectedEntities(ids, db, cursor, pageSize, detail)

  return {
    data: {
      units: drawingUnits(db),
      // An empty list means the user sent their message with nothing
      // selected, not that the lookup failed.
      selectedCount: ids.length,
      matchedCount,
      missingCount: ids.length - matchedCount,
      detail,
      cursor,
      pageSize,
      ...page,
      revision: queryRevision()
    }
  }
}

function stringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === 'string' && entry.trim() !== '')
  ) {
    throw new Error(`${field} must be an array of non-empty strings`)
  }
  return [...new Set(value.map((entry) => entry.trim()))]
}

function queryBounds(value: unknown): {
  minX: number
  minY: number
  maxX: number
  maxY: number
} | undefined {
  if (value === undefined) return undefined
  const bounds = asRecord(value, 'bounds')
  const result = {
    minX: finiteNumber(bounds.minX, 'bounds.minX'),
    minY: finiteNumber(bounds.minY, 'bounds.minY'),
    maxX: finiteNumber(bounds.maxX, 'bounds.maxX'),
    maxY: finiteNumber(bounds.maxY, 'bounds.maxY')
  }
  if (result.maxX < result.minX || result.maxY < result.minY) {
    throw new Error('bounds maximums must be greater than or equal to minimums')
  }
  return result
}

function listEntities(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'list_entities')
  const cursor = boundedInteger(input.cursor, 'cursor', 0, 0, Number.MAX_SAFE_INTEGER)
  const pageSize = boundedInteger(
    input.pageSize,
    'pageSize',
    DEFAULT_ENTITY_PAGE_SIZE,
    1,
    MAX_ENTITY_PAGE_SIZE
  )
  const detail = detailLevel(input.detail, 'summary')
  const entityIdsFilter = stringArray(input.entityIds, 'entityIds')
  const layers = stringArray(input.layers, 'layers')
  const types = stringArray(input.types, 'types')
  const kinds = stringArray(input.kinds, 'kinds') as EntityKind[] | undefined
  const textContains =
    input.textContains === undefined
      ? undefined
      : nonEmptyString(input.textContains, 'textContains').toLocaleLowerCase()
  const bounds = queryBounds(input.bounds)
  const db = currentDatabase()
  const matches = currentDrawingReadModel(db).query({
    ...(entityIdsFilter ? { entityIds: entityIdsFilter } : {}),
    ...(layers ? { layers } : {}),
    ...(types ? { types } : {}),
    ...(kinds ? { kinds } : {}),
    ...(textContains ? { textContains } : {}),
    ...(bounds ? { bounds } : {}),
    space: 'model'
  })
  const page = paginateIndexedEntities(
    matches,
    db,
    cursor,
    pageSize,
    detail
  )

  return {
    data: {
      units: drawingUnits(db),
      matchedCount: matches.length,
      detail,
      cursor,
      pageSize,
      ...page,
      filters: {
        ...(entityIdsFilter ? { entityIdCount: entityIdsFilter.length } : {}),
        ...(layers ? { layerCount: layers.length } : {}),
        ...(types ? { typeCount: types.length } : {}),
        ...(kinds ? { kindCount: kinds.length } : {}),
        ...(textContains ? { textContains: input.textContains } : {}),
        ...(bounds ? { bounded: true } : {})
      },
      revision: queryRevision()
    }
  }
}

interface TextEntityBox {
  entity: AcDbMText | AcDbText
  box: BoundingBox2D
}

function textBoxesOverlap(
  left: BoundingBox2D,
  right: BoundingBox2D,
  minimumGap: number
): boolean {
  const clearance = boundingBoxDistance(left, right)
  return clearance === 0 || clearance < minimumGap
}

function buildOverlapClusterSegments(
  group: readonly TextEntityBox[],
  clusterIndex: number
): Record<string, unknown>[] {
  const entityIds = group.map((entry) => entry.entity.objectId)
  const layerNames = [
    ...new Map(
      group.map((entry) => [
        layerKey(entry.entity.layer),
        entry.entity.layer
      ])
    ).values()
  ].sort((left, right) => left.localeCompare(right))
  const layerPreview = layerNames.slice(0, MAX_OVERLAP_CLUSTER_LAYER_PREVIEW)
  const base = {
    clusterIndex,
    entityCount: group.length,
    layerCount: layerNames.length,
    layers: layerPreview,
    layersTruncated: layerPreview.length < layerNames.length,
    bbox: unionBoundingBoxes(group.map((entry) => entry.box)),
    textSamples: group.slice(0, 5).map((entry) => ({
      entityId: entry.entity.objectId,
      content: (entityText(entry.entity) ?? '').slice(0, 160)
    }))
  }
  const record = (start: number, end: number) => ({
    ...base,
    memberCursor: start,
    entityIds: entityIds.slice(start, end),
    membersReturnedCount: end - start,
    membersNextCursor: end < entityIds.length ? end : null,
    membersHasMore: end < entityIds.length
  })
  const segments: Record<string, unknown>[] = []
  let start = 0
  while (start < entityIds.length) {
    let end = start
    while (
      end < entityIds.length &&
      end - start < MAX_OVERLAP_CLUSTER_MEMBER_COUNT
    ) {
      const candidate = record(start, end + 1)
      if (
        end > start &&
        JSON.stringify(candidate).length >
          MAX_OVERLAP_CLUSTER_RECORD_CHARACTERS
      ) {
        break
      }
      if (
        end === start &&
        JSON.stringify(candidate).length >
          MAX_OVERLAP_CLUSTER_RECORD_CHARACTERS
      ) {
        throw new Error(
          `Overlap-cluster member ${entityIds[start]} cannot fit in a bounded response`
        )
      }
      end += 1
    }
    segments.push(record(start, end))
    start = end
  }
  return segments
}

function findTextOverlaps(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'find_text_overlaps')
  const layers = stringArray(input.layers, 'layers')
  const bounds = queryBounds(input.bounds)
  const minimumGap =
    input.minimumGap === undefined
      ? 0
      : finiteNumber(input.minimumGap, 'minimumGap')
  if (minimumGap < 0) throw new Error('minimumGap must be zero or greater')
  const cursor = boundedInteger(input.cursor, 'cursor', 0, 0, Number.MAX_SAFE_INTEGER)
  const pageSize = boundedInteger(
    input.pageSize,
    'pageSize',
    DEFAULT_ENTITY_PAGE_SIZE,
    1,
    MAX_ENTITY_PAGE_SIZE
  )
  const db = currentDatabase()
  const candidateIds = currentDrawingReadModel(db).query({
    kinds: ['text'],
    ...(layers ? { layers } : {}),
    ...(bounds ? { bounds } : {}),
    space: 'model'
  })
  const candidates: TextEntityBox[] = candidateIds
    .map((id) => db.tables.blockTable.getEntityById(id))
    .filter(
      (entity): entity is AcDbMText | AcDbText =>
        entity instanceof AcDbMText || entity instanceof AcDbText
    )
    .map((entity) => ({ entity, box: entityBox(entity) }))
    .filter(
      (entry): entry is TextEntityBox => entry.box !== null
    )
    .sort(
      (left, right) =>
        left.box.min.x - right.box.min.x ||
        left.box.min.y - right.box.min.y ||
        left.entity.objectId.localeCompare(right.entity.objectId)
    )

  const parent = candidates.map((_, index) => index)
  const find = (index: number): number => {
    let root = index
    while (parent[root] !== root) root = parent[root]
    while (parent[index] !== index) {
      const next = parent[index]
      parent[index] = root
      index = next
    }
    return root
  }
  const union = (left: number, right: number) => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot
  }

  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      if (
        candidates[right].box.min.x >
        candidates[left].box.max.x + minimumGap
      ) {
        break
      }
      if (
        textBoxesOverlap(
          candidates[left].box,
          candidates[right].box,
          minimumGap
        )
      ) {
        union(left, right)
      }
    }
  }

  const grouped = new Map<number, TextEntityBox[]>()
  candidates.forEach((candidate, index) => {
    const root = find(index)
    const group = grouped.get(root) ?? []
    group.push(candidate)
    grouped.set(root, group)
  })
  const clusterGroups = [...grouped.values()].filter(
    (group) => group.length > 1
  )
  const clusterSegments = clusterGroups.flatMap((group, index) =>
    buildOverlapClusterSegments(group, index)
  )
  const page = paginateRecords(
    clusterSegments,
    cursor,
    pageSize,
    'overlap-cluster segment'
  )

  return {
    data: {
      units: drawingUnits(db),
      textEntityCount: candidates.length,
      overlapClusterCount: clusterGroups.length,
      clusterSegmentCount: clusterSegments.length,
      minimumGap,
      cursor,
      pageSize,
      clusters: page.records,
      returnedCount: page.returnedCount,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      filters: {
        ...(layers ? { layerCount: layers.length } : {}),
        ...(bounds ? { bounded: true } : {})
      },
      revision: queryRevision()
    }
  }
}

function getEntityText(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'get_entity_text')
  const entityId = nonEmptyString(input.entityId, 'entityId')
  const cursor = boundedInteger(input.cursor, 'cursor', 0, 0, Number.MAX_SAFE_INTEGER)
  const chunkSize = boundedInteger(
    input.chunkSize,
    'chunkSize',
    DEFAULT_TEXT_CHUNK_SIZE,
    1,
    MAX_TEXT_CHUNK_SIZE
  )
  const entity = currentDatabase().tables.blockTable.getEntityById(entityId)
  if (!entity) throw new Error(`Entity id not found: ${entityId}`)
  const content = entityText(entity)
  if (content === undefined) {
    throw new Error(`Entity ${entityId} (${entity.type}) is not TEXT or MTEXT`)
  }
  if (cursor > content.length) {
    throw new Error(`cursor ${cursor} is past the ${content.length}-character text`)
  }
  const requestedEnd = Math.min(content.length, cursor + chunkSize)
  const revision = queryRevision()
  const buildPage = (end: number) => ({
      entityId,
      type: entity.type,
      layer: entity.layer,
      cursor,
      chunkSize,
      content: content.slice(cursor, end),
      totalCharacters: content.length,
      returnedCharacters: end - cursor,
      nextCursor: end < content.length ? end : null,
      hasMore: end < content.length,
      revision
  })
  let lower = cursor
  let upper = requestedEnd
  while (lower < upper) {
    const candidate = Math.ceil((lower + upper) / 2)
    if (
      JSON.stringify(buildPage(candidate)).length <=
      MAX_ENTITY_PAGE_CHARACTERS
    ) {
      lower = candidate
    } else {
      upper = candidate - 1
    }
  }
  if (lower === cursor && requestedEnd > cursor) {
    throw new Error(
      `Entity ${entityId} text metadata cannot fit one character in a bounded response`
    )
  }
  return { data: buildPage(lower) }
}

function getPolylineVertices(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'get_polyline_vertices')
  const entityId = nonEmptyString(input.entityId, 'entityId')
  const cursor = boundedInteger(input.cursor, 'cursor', 0, 0, Number.MAX_SAFE_INTEGER)
  const pageSize = boundedInteger(
    input.pageSize,
    'pageSize',
    DEFAULT_VERTEX_PAGE_SIZE,
    1,
    MAX_VERTEX_PAGE_SIZE
  )
  const entity = currentDatabase().tables.blockTable.getEntityById(entityId)
  if (!entity) throw new Error(`Entity id not found: ${entityId}`)
  if (!(entity instanceof AcDbPolyline)) {
    throw new Error(`Entity ${entityId} (${entity.type}) is not a polyline`)
  }
  const vertices = polylineVertices(entity)
  if (cursor > vertices.length) {
    throw new Error(`cursor ${cursor} is past the ${vertices.length}-vertex polyline`)
  }
  const page: typeof vertices = []
  let encodedCharacters = 2
  let end = cursor
  while (end < vertices.length && page.length < pageSize) {
    const vertex = vertices[end]
    const vertexCharacters = JSON.stringify(vertex).length
    if (
      page.length > 0 &&
      encodedCharacters + vertexCharacters + 1 > MAX_ENTITY_PAGE_CHARACTERS
    ) {
      break
    }
    page.push(vertex)
    encodedCharacters += vertexCharacters + (page.length > 1 ? 1 : 0)
    end += 1
  }

  return {
    data: {
      entityId,
      layer: entity.layer,
      units: drawingUnits(),
      closed: entity.closed,
      cursor,
      pageSize,
      vertices: page,
      vertexCount: vertices.length,
      returnedCount: end - cursor,
      nextCursor: end < vertices.length ? end : null,
      hasMore: end < vertices.length,
      revision: queryRevision()
    }
  }
}

function buildLayerSummaries(
  db: AcDbDatabase,
  readModel: DrawingReadModel
): Record<string, unknown>[] {
  return Array.from(db.tables.layerTable.newIterator()).map((layer) => {
    const stats = readModel.layerStats(layer.name)
    return {
      name: layer.name,
      colorCss: layer.color.cssColor ?? '#ffffff',
      isOff: layer.isOff,
      isFrozen: layer.isFrozen,
      isLocked: layer.isLocked,
      isPlottable: layer.isPlottable,
      entityCount: stats?.entityCount ?? 0,
      entityKinds: stats
        ? Object.fromEntries(
            [...stats.entityKinds.entries()].sort(([left], [right]) =>
              left.localeCompare(right)
            )
          )
        : {}
    }
  })
}

function paginateRecords<T>(
  records: readonly T[],
  cursor: number,
  pageSize: number,
  label: string
): {
  records: T[]
  returnedCount: number
  nextCursor: number | null
  hasMore: boolean
} {
  if (cursor > records.length) {
    throw new Error(`cursor ${cursor} is past the ${records.length}-${label} result set`)
  }
  const page: T[] = []
  let encodedCharacters = 2
  let index = cursor
  while (index < records.length && page.length < pageSize) {
    const record = records[index]
    const recordCharacters = JSON.stringify(record).length
    if (recordCharacters > MAX_ENTITY_PAGE_CHARACTERS) {
      throw new Error(
        `${label} record ${index} exceeds the bounded response size`
      )
    }
    if (
      page.length > 0 &&
      encodedCharacters + recordCharacters + 1 > MAX_ENTITY_PAGE_CHARACTERS
    ) {
      break
    }
    page.push(record)
    encodedCharacters += recordCharacters + (page.length > 1 ? 1 : 0)
    index += 1
  }
  const hasMore = index < records.length
  return {
    records: page,
    returnedCount: page.length,
    nextCursor: hasMore ? index : null,
    hasMore
  }
}

function listLayers(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'list_layers')
  const cursor = boundedInteger(input.cursor, 'cursor', 0, 0, Number.MAX_SAFE_INTEGER)
  const pageSize = boundedInteger(
    input.pageSize,
    'pageSize',
    DEFAULT_ENTITY_PAGE_SIZE,
    1,
    MAX_ENTITY_PAGE_SIZE
  )
  const db = currentDatabase()
  const layers = buildLayerSummaries(db, currentDrawingReadModel(db))
  const page = paginateRecords(layers, cursor, pageSize, 'layer')

  return {
    data: {
      layerCount: layers.length,
      cursor,
      pageSize,
      layers: page.records,
      returnedCount: page.returnedCount,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      revision: queryRevision()
    }
  }
}

/** Reads units, layers, current layer, and extents from the live database. */
function getDrawingContext(): ToolResult {
  if (!testDatabaseOverride && cadSessionState.status !== 'active') {
    const snapshot = getCadSessionSnapshot()
    return {
      data: {
        entityIds: [],
        documentOpen: false,
        documentName: snapshot.documentName,
        editable: false,
        viewReady: false,
        activeLayout: snapshot.activeLayout,
        entityCount: 0,
        visibleEntityCount: 0,
        databaseUnit: 'unknown',
        units: 'Unknown',
        currentLayer: null,
        layers: [],
        layerCount: 0,
        layersReturnedCount: 0,
        layersNextCursor: null,
        layersHasMore: false,
        drawingExtents: null,
        extents: null,
        sheetDrawingUnit: sheetStore.current.drawingUnit,
        sheetScaleDenominator: sheetStore.current.scaleDenominator,
        unitMismatch: false,
        lifecycleStatus: snapshot.status,
        error: snapshot.error
      }
    }
  }

  const db = currentDatabase()
  const readModel = currentDrawingReadModel(db)
  const allLayers = buildLayerSummaries(db, readModel)
  const layerPage = paginateRecords(
    allLayers,
    0,
    DEFAULT_ENTITY_PAGE_SIZE,
    'layer'
  )
  const visibleEntityCount = readModel.visibleCount

  const storedExtents = db.extents
  const fallbackExtents = readModel.extents()
  const extents =
    storedExtents.isEmpty() && fallbackExtents
      ? {
          min: {
            x: fallbackExtents.minX,
            y: fallbackExtents.minY,
            z: 0
          },
          max: {
            x: fallbackExtents.maxX,
            y: fallbackExtents.maxY,
            z: 0
          }
        }
      : storedExtents.isEmpty()
        ? null
        : {
            min: { x: storedExtents.min.x, y: storedExtents.min.y, z: storedExtents.min.z },
            max: { x: storedExtents.max.x, y: storedExtents.max.y, z: storedExtents.max.z }
          }
  const snapshot = testDatabaseOverride
    ? undefined
    : getCadSessionSnapshot()
  const mismatch = sheetUnitMismatch(
    snapshot?.databaseUnit ?? 'unknown',
    sheetStore.current.drawingUnit
  )
  const normalizedExtents = extents
    ? {
        minX: extents.min.x,
        minY: extents.min.y,
        maxX: extents.max.x,
        maxY: extents.max.y
      }
    : null
  return {
    data: {
      entityIds: [],
      documentOpen: snapshot ? snapshot.status === 'active' : true,
      documentName: snapshot?.documentName,
      editable: snapshot?.editable ?? true,
      viewReady: snapshot?.viewReady ?? false,
      activeLayout: snapshot?.activeLayout,
      entityCount: readModel.size,
      visibleEntityCount,
      databaseUnit: snapshot?.databaseUnit ?? drawingUnits(db),
      units: drawingUnits(db),
      currentLayer: db.clayer,
      layers: layerPage.records,
      layerCount: allLayers.length,
      layersReturnedCount: layerPage.returnedCount,
      layersNextCursor: layerPage.nextCursor,
      layersHasMore: layerPage.hasMore,
      drawingExtents: normalizedExtents,
      extents,
      sheetDrawingUnit: sheetStore.current.drawingUnit,
      sheetScaleDenominator: sheetStore.current.scaleDenominator,
      unitMismatch: mismatch.mismatch,
      unitMismatchFactor: mismatch.factor,
      lifecycleStatus: snapshot?.status ?? 'active',
      entityDiscovery: {
        tool: 'list_entities',
        selectionRequired: false,
        paginated: true
      },
      revision: queryRevision()
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
    const count = transformEntities(
      db,
      entities,
      new AcGeMatrix3d().makeTranslation(dx, dy, 0)
    )
    if (count !== entities.length) throw new Error('Not every entity could be opened for move')
    resolveEntities(ids, db)
  })
  return { data: { entityIds: ids, dx, dy } }
}

function copyEntities(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'copy_entities')
  const ids = entityIds(input.entityIds)
  const dx = finiteNumber(input.dx, 'dx')
  const dy = finiteNumber(input.dy, 'dy')
  const db = currentDatabase()
  const entities = resolveEntities(ids, db)
  const newIds = runEdit('Agent: copy_entities', () => {
    const copies = cloneAndTransformEntities(
      db,
      entities,
      new AcGeMatrix3d().makeTranslation(dx, dy, 0)
    )
    const copiedIds = copies.map((entity) => entity.objectId)
    if (copiedIds.length !== entities.length) {
      throw new Error('Not every entity could be copied')
    }
    if (copiedIds.some((id) => !db.tables.blockTable.getEntityById(id))) {
      throw new Error('A copied entity was not present before transaction commit')
    }
    return copiedIds
  })
  return {
    data: {
      entityIds: newIds,
      sourceCount: ids.length,
      copiedCount: newIds.length,
      dx,
      dy
    }
  }
}

function rotateEntities(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'rotate_entities')
  const ids = entityIds(input.entityIds)
  const angleDeg = finiteNumber(input.angleDeg, 'angleDeg')
  const db = currentDatabase()
  const entities = resolveEntities(ids, db)
  const center = input.center === undefined ? commonCenter(entities) : point2D(input.center, 'center')
  const matrix = new AcGeMatrix3d()
    .makeTranslation(center.x, center.y, 0)
    .multiply(new AcGeMatrix3d().makeRotationZ((angleDeg * Math.PI) / 180))
    .multiply(new AcGeMatrix3d().makeTranslation(-center.x, -center.y, 0))
  runEdit('Agent: rotate_entities', () => {
    const count = transformEntities(db, entities, matrix)
    if (count !== entities.length) throw new Error('Not every entity could be opened for rotation')
    resolveEntities(ids, db)
  })
  return { data: { entityIds: ids, angleDeg, center } }
}

function scaleEntities(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'scale_entities')
  const ids = entityIds(input.entityIds)
  const factor = positiveNumber(input.factor, 'factor')
  const db = currentDatabase()
  const entities = resolveEntities(ids, db)
  const center = input.center === undefined ? commonCenter(entities) : point2D(input.center, 'center')
  const matrix = new AcGeMatrix3d()
    .makeTranslation(center.x, center.y, 0)
    .multiply(new AcGeMatrix3d().makeScale(factor, factor, factor))
    .multiply(new AcGeMatrix3d().makeTranslation(-center.x, -center.y, 0))
  runEdit('Agent: scale_entities', () => {
    const count = transformEntities(db, entities, matrix)
    if (count !== entities.length) throw new Error('Not every entity could be opened for scaling')
    resolveEntities(ids, db)
  })
  return { data: { entityIds: ids, factor, center } }
}

function deleteEntities(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'delete_entities')
  const ids = entityIds(input.entityIds)
  const db = currentDatabase()
  resolveEntities(ids, db)
  runEdit('Agent: delete_entities', () => {
    const count = eraseCadEntities(db, ids)
    if (count !== ids.length) throw new Error('Not every entity could be deleted')
    if (ids.some((id) => db.tables.blockTable.getEntityById(id))) {
      throw new Error('A deleted entity remained present before transaction commit')
    }
  })
  return { data: { entityIds: ids } }
}

function setEntityLayer(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'set_entity_layer')
  const ids = entityIds(input.entityIds)
  const layerName = nonEmptyString(input.layerName, 'layerName')
  const db = currentDatabase()
  resolveEntities(ids, db)
  let appliedLayerName = layerName
  const layerCreated = runEdit('Agent: set_entity_layer', () => {
    const created = createLayerRecord(db, layerName).created
    const layer = db.tables.layerTable.getAt(layerName)
    if (!layer) throw new Error(`Layer not found after creation: ${layerName}`)
    appliedLayerName = layer.name
    for (const id of ids) {
      const entity = db.openEntityForWrite(id) as AcDbEntity | undefined
      if (!entity) throw new Error(`Entity could not be opened for write: ${id}`)
      entity.layer = appliedLayerName
    }
    return created
  })
  return { data: { entityIds: ids, layerName: appliedLayerName, layerCreated } }
}

function setEntityColor(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'set_entity_color')
  const ids = entityIds(input.entityIds)
  const mode = nonEmptyString(input.mode, 'mode')
  if (mode !== 'by-layer' && mode !== 'by-block' && mode !== 'explicit') {
    throw new Error('mode must be "by-layer", "by-block", or "explicit"')
  }
  const colorCss =
    input.colorCss === undefined
      ? undefined
      : nonEmptyString(input.colorCss, 'colorCss')
  if (mode === 'explicit' && colorCss === undefined) {
    throw new Error('colorCss is required when mode is "explicit"')
  }
  if (mode !== 'explicit' && colorCss !== undefined) {
    throw new Error('colorCss is only valid when mode is "explicit"')
  }
  const color =
    mode === 'by-layer'
      ? new AcCmColor().setByLayer()
      : mode === 'by-block'
        ? new AcCmColor().setByBlock()
        : parseCssColor(colorCss as string)
  const db = currentDatabase()
  resolveEntities(ids, db)
  runEdit('Agent: set_entity_color', () => {
    for (const id of ids) {
      const entity = db.openEntityForWrite(id)
      if (!entity) throw new Error(`Entity could not be opened for write: ${id}`)
      entity.color = color.clone()
    }
  })
  return {
    data: {
      entityIds: ids,
      mode,
      colorCss: mode === 'explicit' ? color.cssColor ?? colorCss : null
    }
  }
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
  return {
    data: {
      entityIds: [id],
      textCharacterCount: (input.newText as string).length,
      contentChanged: true
    }
  }
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
    if (entity instanceof AcDbPolyline) {
      // Bulge-aware: the chord polygon plus each arc's circular segment.
      area = polylineArea(polylineVertices(entity), entity.closed)
    } else if (entity instanceof AcDbCircle) area = Math.PI * entity.radius * entity.radius
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
  return {
    data: {
      entityIds: [id],
      vertexCount: points.length,
      closed,
      layer: layer ?? currentDatabase().clayer
    }
  }
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
    data: {
      entityIds: [id],
      position,
      textCharacterCount: (input.text as string).length,
      height,
      layer: layer ?? currentDatabase().clayer
    }
  }
}

function addLinearDimension(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'add_linear_dimension')
  const p1 = point2D(input.p1, 'p1')
  const p2 = point2D(input.p2, 'p2')
  const offset = finiteNumber(input.offset, 'offset')
  if (
    input.orientation !== 'horizontal' &&
    input.orientation !== 'vertical' &&
    input.orientation !== 'aligned'
  ) {
    throw new Error('orientation must be horizontal, vertical, or aligned')
  }
  const orientation = input.orientation as LinearDimensionOrientation
  const geometry = linearDimensionGeometry(p1, p2, offset, orientation)
  const displayText = geometry.measurement.toFixed(2)
  const scale = annotationScale(geometry.measurement)
  const direction = {
    x: (geometry.dimensionLine.end.x - geometry.dimensionLine.start.x) / geometry.measurement,
    y: (geometry.dimensionLine.end.y - geometry.dimensionLine.start.y) / geometry.measurement
  }

  const result = runEdit('Agent: add_linear_dimension', () => {
    const db = currentDatabase()
    const layer = annotationLayer({}, db)
    const block = new AcDbBlockTableRecord()
    block.name = nextAnnotationBlockName(db)
    block.appendEntity([
      blockLine(geometry.extensionLine1.start, geometry.extensionLine1.end, p1),
      blockLine(geometry.extensionLine2.start, geometry.extensionLine2.end, p1),
      blockLine(geometry.dimensionLine.start, geometry.dimensionLine.end, p1),
      blockArrow(
        arrowheadGeometry(geometry.dimensionLine.start, direction, scale, scale * 0.6),
        p1
      ),
      blockArrow(
        arrowheadGeometry(
          geometry.dimensionLine.end,
          { x: -direction.x, y: -direction.y },
          scale,
          scale * 0.6
        ),
        p1
      ),
      blockMText(
        geometry.textPosition,
        p1,
        displayText,
        scale,
        geometry.angleRad,
        AcGiMTextAttachmentPoint.MiddleCenter
      )
    ])
    return { ...appendAnnotationBlock(db, block, p1, layer.name), layer }
  })

  return {
    data: {
      entityIds: [result.entityId],
      blockName: result.blockName,
      p1,
      p2,
      offset,
      orientation,
      measurement: geometry.measurement,
      displayText,
      layer: result.layer.name,
      layerCreated: result.layer.created
    }
  }
}

function addRadiusDimension(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'add_radius_dimension')
  const circleEntityId = nonEmptyString(input.circleEntityId, 'circleEntityId')
  const angleDeg =
    input.angleDeg === undefined ? 45 : finiteNumber(input.angleDeg, 'angleDeg')
  const db = currentDatabase()
  const entity = db.tables.blockTable.getEntityById(circleEntityId)
  if (!entity) throw new Error(`Entity id not found: ${circleEntityId}`)
  if (!(entity instanceof AcDbCircle)) {
    throw new Error(
      `add_radius_dimension requires a circle entity; ${circleEntityId} is ${entity.type}`
    )
  }

  const center = { x: entity.center.x, y: entity.center.y }
  const radius = entity.radius
  const angleRad = (angleDeg * Math.PI) / 180
  const direction = { x: Math.cos(angleRad), y: Math.sin(angleRad) }
  const chordPoint = {
    x: center.x + direction.x * radius,
    y: center.y + direction.y * radius
  }
  const scale = annotationScale(radius * 2)
  const extension = Math.max(scale * 3, radius * 0.35)
  const leaderEnd = {
    x: center.x + direction.x * (radius + extension),
    y: center.y + direction.y * (radius + extension)
  }
  const displayText = `R ${radius.toFixed(2)}`

  const result = runEdit('Agent: add_radius_dimension', () => {
    const liveDb = currentDatabase()
    const layer = annotationLayer(input, liveDb)
    const block = new AcDbBlockTableRecord()
    block.name = nextAnnotationBlockName(liveDb)
    block.appendEntity([
      blockLine(center, leaderEnd, center),
      blockArrow(
        arrowheadGeometry(
          chordPoint,
          { x: -direction.x, y: -direction.y },
          scale,
          scale * 0.6
        ),
        center
      ),
      blockMText(
        leaderEnd,
        center,
        displayText,
        scale,
        0,
        AcGiMTextAttachmentPoint.MiddleCenter
      )
    ])
    return { ...appendAnnotationBlock(liveDb, block, center, layer.name), layer }
  })

  return {
    data: {
      entityIds: [result.entityId],
      blockName: result.blockName,
      circleEntityId,
      center,
      radius,
      measurement: radius,
      displayText,
      angleDeg,
      layer: result.layer.name,
      layerCreated: result.layer.created
    }
  }
}

function addLeader(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'add_leader')
  const targetPoint = point2D(input.targetPoint, 'targetPoint')
  const text = nonEmptyString(input.text, 'text')
  const textPosition =
    input.textPosition === undefined
      ? { x: targetPoint.x + 10, y: targetPoint.y + 10 }
      : point2D(input.textPosition, 'textPosition')
  if (distance(targetPoint, textPosition) <= 1e-12) {
    throw new Error('textPosition must differ from targetPoint')
  }
  const height = 2.5

  const result = runEdit('Agent: add_leader', () => {
    const db = currentDatabase()
    const layer = annotationLayer({}, db)
    const annotation = new AcDbMText()
    annotation.location = point3D(textPosition)
    annotation.contents = text
    annotation.height = height
    annotation.attachmentPoint =
      textPosition.x >= targetPoint.x
        ? AcGiMTextAttachmentPoint.MiddleLeft
        : AcGiMTextAttachmentPoint.MiddleRight
    annotation.layer = layer.name
    db.tables.blockTable.modelSpace.appendEntity(annotation)

    const leader = new AcDbLeader()
    leader.appendVertex(point3D(targetPoint))
    leader.appendVertex(point3D(textPosition))
    leader.hasArrowHead = true
    leader.hasHookLine = true
    leader.annoType = AcDbLeaderAnnotationType.MText
    leader.textHeight = height
    leader.associatedAnnotation = annotation.objectId
    leader.layer = layer.name
    db.tables.blockTable.modelSpace.appendEntity(leader)
    return { leaderId: leader.objectId, textId: annotation.objectId, layer }
  })

  return {
    data: {
      entityIds: [result.leaderId, result.textId],
      targetPoint,
      textCharacterCount: text.length,
      textPosition,
      height,
      layer: result.layer.name,
      layerCreated: result.layer.created
    }
  }
}

function addMText(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'add_mtext')
  const position = point2D(input.position, 'position')
  const text = nonEmptyString(input.text, 'text')
  const height = input.height === undefined ? 2.5 : positiveNumber(input.height, 'height')

  const result = runEdit('Agent: add_mtext', () => {
    const db = currentDatabase()
    const layer = annotationLayer(input, db)
    const mtext = new AcDbMText()
    mtext.location = point3D(position)
    mtext.contents = text
    mtext.height = height
    mtext.attachmentPoint = AcGiMTextAttachmentPoint.TopLeft
    mtext.layer = layer.name
    db.tables.blockTable.modelSpace.appendEntity(mtext)
    return { entityId: mtext.objectId, layer }
  })

  return {
    data: {
      entityIds: [result.entityId],
      position,
      textCharacterCount: text.length,
      height,
      layer: result.layer.name,
      layerCreated: result.layer.created
    }
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
  return {
    data: {
      entityIds: [id],
      boundaryVertexCount: vertices.length,
      pattern,
      layer: layer ?? currentDatabase().clayer
    }
  }
}

function createLayer(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'create_layer')
  const name = nonEmptyString(input.name, 'name')
  const colorCss =
    input.colorCss === undefined ? undefined : nonEmptyString(input.colorCss, 'colorCss')
  const result = runEdit('Agent: create_layer', () => createLayerRecord(currentDatabase(), name, colorCss))
  return { data: { entityIds: [], name, ...result } }
}

function setLayerProperties(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'set_layer_properties')
  const name = nonEmptyString(input.name, 'name')
  const colorCss =
    input.colorCss === undefined
      ? undefined
      : nonEmptyString(input.colorCss, 'colorCss')
  const isOff = optionalBoolean(input.isOff, 'isOff')
  const isFrozen = optionalBoolean(input.isFrozen, 'isFrozen')
  const isLocked = optionalBoolean(input.isLocked, 'isLocked')
  const isPlottable = optionalBoolean(input.isPlottable, 'isPlottable')
  if (
    colorCss === undefined &&
    isOff === undefined &&
    isFrozen === undefined &&
    isLocked === undefined &&
    isPlottable === undefined
  ) {
    throw new Error('At least one layer property must be provided')
  }

  const db = currentDatabase()
  const layer = db.tables.layerTable.getAt(name)
  if (!layer) throw new Error(`Layer not found: ${name}`)
  const properties = (record: AcDbLayerTableRecord) => ({
    colorCss: record.color.cssColor ?? '#ffffff',
    isOff: record.isOff,
    isFrozen: record.isFrozen,
    isLocked: record.isLocked,
    isPlottable: record.isPlottable
  })
  const before = properties(layer)
  runEdit('Agent: set_layer_properties', () => {
    const writable = db.openObjectForWrite<AcDbLayerTableRecord>(layer.objectId)
    if (!writable) throw new Error(`Layer could not be opened for write: ${name}`)
    if (colorCss !== undefined) writable.color = parseCssColor(colorCss)
    if (isOff !== undefined) writable.isOff = isOff
    if (isFrozen !== undefined) writable.isFrozen = isFrozen
    if (isLocked !== undefined) writable.isLocked = isLocked
    if (isPlottable !== undefined) writable.isPlottable = isPlottable
  })

  const updatedLayer = db.tables.layerTable.getAt(name)
  if (!updatedLayer) throw new Error(`Layer disappeared after update: ${name}`)
  return { data: { entityIds: [], name, before, after: properties(updatedLayer) } }
}

function setCurrentLayer(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'set_current_layer')
  const name = nonEmptyString(input.name, 'name')
  const { manager } = requireEditableCadSession()
  const changed = manager.curDocument.layerService.setCurrentLayer(name)
  if (!changed) throw new Error(`Layer not found: ${name}`)
  markCadSessionDatabaseEdited()
  return {
    data: {
      entityIds: [],
      name: manager.curDocument.database.clayer
    }
  }
}

async function zoomExtents(): Promise<ToolResult> {
  const result = await fitDrawingToScreen()
  return {
    data: {
      entityIds: [],
      zoomed: result.completeExtentsFit,
      fittedExtents: result.extents,
      entityCount: result.entityCount,
      activeLayout: result.activeLayout,
      viewport: {
        width: result.viewportWidth,
        height: result.viewportHeight
      },
      regenerationCompleted: result.regenerationCompleted,
      completeExtentsFit: result.completeExtentsFit
    }
  }
}

/** Current sheet, plus every paper size, template, and field key the agent may name. */
function getSheetSetup(): ToolResult {
  const mismatch = sheetUnitMismatch(
    cadSessionState.databaseUnit,
    sheetStore.current.drawingUnit
  )
  return {
    data: {
      entityIds: [],
      documentOpen:
        cadSessionState.status === 'active' && cadSessionState.editable,
      documentName: cadSessionState.documentName,
      databaseUnit: cadSessionState.databaseUnit,
      databaseUnitName: cadSessionState.databaseUnitName,
      unitMismatch: mismatch.mismatch,
      unitMismatchFactor: mismatch.factor,
      unitWarning: mismatch.message,
      current: { ...sheetStore.current },
      paperSizes: Object.entries(PAPER_SIZES).map(([id, size]) => ({
        id,
        portraitWidthMm: size.widthMm,
        portraitHeightMm: size.heightMm
      })),
      templates: listTemplates().map((template) => ({
        id: template.id,
        name: template.name,
        description: template.description,
        supportedPapers: template.supportedPapers,
        fieldKeys: template.fields.map((field) => field.key)
      }))
    }
  }
}

function resolveTemplateId(value: unknown): string {
  const templateId = nonEmptyString(value, 'templateId')
  const templates = listTemplates()
  if (!templates.some((template) => template.id === templateId)) {
    throw new Error(
      `Unknown title-block template: ${templateId}. Available templates: ${templates
        .map((template) => `${template.id} (${template.name})`)
        .join('; ')}`
    )
  }
  return templateId
}

/** Field keys not defined by the active template, so the caller can be told they will not render. */
function unknownFieldKeys(fields: Record<string, string>, templateId: string | undefined): string[] {
  const template = listTemplates().find((candidate) => candidate.id === templateId)
  if (!template) return []
  const known = new Set(template.fields.map((field) => field.key))
  return Object.keys(fields).filter((key) => !known.has(key))
}

function setSheetDefinition(rawInput: unknown): ToolResult {
  requireEditableCadSession()
  const input = asRecord(rawInput, 'set_sheet_definition')
  const update: Partial<SheetDefinition> = {}
  if (input.paper !== undefined) {
    const paper = nonEmptyString(input.paper, 'paper').toUpperCase() as PaperSizeId
    if (!(paper in PAPER_SIZES)) {
      throw new Error(
        `Unsupported paper size: ${String(input.paper)}. Supported sizes: ${Object.keys(PAPER_SIZES).join(', ')}`
      )
    }
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
  if (input.drawingUnit !== undefined) {
    if (input.drawingUnit !== 'm' && input.drawingUnit !== 'mm') {
      throw new Error('drawingUnit must be m or mm')
    }
    update.drawingUnit = input.drawingUnit
  }
  if (input.templateId !== undefined) {
    update.templateId = resolveTemplateId(input.templateId)
  }

  let ignoredFieldKeys: string[] = []
  if (input.fields !== undefined) {
    const fields = asRecord(input.fields, 'fields')
    if (!Object.values(fields).every((value) => typeof value === 'string')) {
      throw new Error('fields must contain only string values')
    }
    ignoredFieldKeys = unknownFieldKeys(
      fields as Record<string, string>,
      update.templateId ?? sheetStore.current.templateId
    )
    update.fields = { ...(sheetStore.current.fields ?? {}), ...(fields as Record<string, string>) }
  }
  sheetStore.current = { ...sheetStore.current, ...update }
  const mismatch = sheetUnitMismatch(
    cadSessionState.databaseUnit,
    sheetStore.current.drawingUnit
  )
  return {
    data: {
      entityIds: [],
      sheet: {
        paper: sheetStore.current.paper,
        orientation: sheetStore.current.orientation,
        scaleDenominator: sheetStore.current.scaleDenominator,
        drawingUnit: sheetStore.current.drawingUnit,
        templateId: sheetStore.current.templateId,
        fieldCount: Object.keys(sheetStore.current.fields ?? {}).length
      },
      updatedKeys: Object.keys(update),
      databaseUnit: cadSessionState.databaseUnit,
      unitMismatch: mismatch.mismatch,
      unitMismatchFactor: mismatch.factor,
      geometryScaled: false,
      ignoredFieldCount: ignoredFieldKeys.length,
      ignoredFieldKeysPreview: ignoredFieldKeys.slice(
        0,
        MAX_FIELD_KEY_PREVIEW
      )
    }
  }
}

function setTitleBlockFields(rawInput: unknown): ToolResult {
  requireEditableCadSession()
  const input = asRecord(rawInput, 'set_title_block_fields')
  const fields = asRecord(input.fields, 'fields')
  if (!Object.values(fields).every((value) => typeof value === 'string')) {
    throw new Error('fields must contain only string values')
  }
  const ignoredFieldKeys = unknownFieldKeys(
    fields as Record<string, string>,
    sheetStore.current.templateId
  )
  sheetStore.current = {
    ...sheetStore.current,
    fields: { ...(sheetStore.current.fields ?? {}), ...(fields as Record<string, string>) }
  }
  return {
    data: {
      entityIds: [],
      updatedFieldCount: Object.keys(fields).length,
      updatedFieldKeysPreview: Object.keys(fields).slice(
        0,
        MAX_FIELD_KEY_PREVIEW
      ),
      storedFieldCount: Object.keys(sheetStore.current.fields ?? {}).length,
      ignoredFieldCount: ignoredFieldKeys.length,
      ignoredFieldKeysPreview: ignoredFieldKeys.slice(
        0,
        MAX_FIELD_KEY_PREVIEW
      )
    }
  }
}

async function getViewStatus(): Promise<ToolResult> {
  await awaitCadSessionRegeneration()
  const snapshot = getCadSessionSnapshot()
  const currentFit = verifyCurrentCadExtentsFit()
  const mismatch = sheetUnitMismatch(
    snapshot.databaseUnit,
    sheetStore.current.drawingUnit
  )
  return {
    data: {
      entityIds: [],
      lifecycleStatus: snapshot.status,
      documentOpen: snapshot.status === 'active',
      documentName: snapshot.documentName,
      editable: snapshot.editable,
      viewReady: snapshot.viewReady,
      activeLayout: snapshot.activeLayout,
      canvas: getCanvasDimensions(),
      entityCount: snapshot.entityCount,
      visibleEntityCount: snapshot.visibleEntityCount,
      renderableGeometryCount: snapshot.renderableGeometryCount,
      renderedEntityCount: snapshot.renderedEntityCount,
      drawingExtents: snapshot.drawingExtents,
      databaseUnit: snapshot.databaseUnit,
      lastRegeneration: snapshot.lastRegeneration,
      lastFitDrawing: snapshot.lastFit,
      currentFitVerification: currentFit,
      completeExtentsFit: currentFit.complete,
      sheetPreview: snapshot.sheetPreview,
      sheetWarnings: snapshot.sheetPreview.warnings,
      sheetDrawingUnit: sheetStore.current.drawingUnit,
      unitMismatch: mismatch.mismatch,
      unitMismatchFactor: mismatch.factor
    }
  }
}

async function inspectSheetPreview(rawInput: unknown): Promise<ToolResult> {
  requireEditableCadSession()
  const input = asRecord(rawInput, 'inspect_sheet_preview')
  if (Object.keys(input).some((key) => key !== 'view')) {
    throw new Error('inspect_sheet_preview input contains unsupported fields')
  }
  const view = input.view ?? 'full'
  if (
    typeof view !== 'string' ||
    !SHEET_PREVIEW_VIEWS.includes(view as SheetPreviewView)
  ) {
    throw new Error(
      `view must be one of: ${SHEET_PREVIEW_VIEWS.join(', ')}`
    )
  }
  const regeneration = await awaitCadSessionRegeneration()
  if (regeneration && !regeneration.completed) {
    throw new Error(
      regeneration.error
        ? `CAD regeneration failed: ${regeneration.error}`
        : 'CAD regeneration is incomplete.'
    )
  }
  return drawingVisionService.recordSheet(
    await sheetPreviewService.capture(view as SheetPreviewView)
  )
}

async function inspectModelView(rawInput: unknown): Promise<ToolResult> {
  const input = asRecord(rawInput, 'inspect_model_view')
  if (Object.keys(input).length > 0) {
    throw new Error('inspect_model_view input contains unsupported fields')
  }
  return drawingVisionService.captureModel('model-view')
}

async function inspectRegion(rawInput: unknown): Promise<ToolResult> {
  const input = asRecord(rawInput, 'inspect_region')
  const bounds = queryBounds(input.bounds)
  if (!bounds) throw new Error('inspect_region.bounds is required')
  if (bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) {
    throw new Error('inspect_region bounds must have positive width and height')
  }
  return drawingVisionService.captureModel('region', bounds)
}

async function inspectSelection(rawInput: unknown): Promise<ToolResult> {
  const input = asRecord(rawInput, 'inspect_selection')
  const ids = entityIds(input.entityIds)
  const entities = resolveEntities(ids)
  const bounds = unionBoundingBoxes(
    entities
      .map(entityBox)
      .filter((box): box is BoundingBox2D => box !== null)
  )
  if (!bounds) {
    throw new Error('The selected entities have no capturable extents.')
  }
  return drawingVisionService.captureModel(
    'selection',
    {
      minX: bounds.min.x,
      minY: bounds.min.y,
      maxX: bounds.max.x,
      maxY: bounds.max.y
    },
    ids
  )
}

async function compareBeforeAfter(rawInput: unknown): Promise<ToolResult> {
  const input = asRecord(rawInput, 'compare_before_after')
  return drawingVisionService.compare(
    nonEmptyString(input.beforeEvidenceId, 'beforeEvidenceId'),
    nonEmptyString(input.afterEvidenceId, 'afterEvidenceId')
  )
}

async function renderAnalysisOverlay(rawInput: unknown): Promise<ToolResult> {
  const input = asRecord(rawInput, 'render_analysis_overlay')
  if (!Array.isArray(input.boxes) || input.boxes.length < 1 || input.boxes.length > 50) {
    throw new Error('boxes must contain from 1 through 50 overlays')
  }
  const boxes = input.boxes.map((value, index): OverlayBox => {
    const box = asRecord(value, `boxes[${index}]`)
    const result = {
      x: finiteNumber(box.x, `boxes[${index}].x`),
      y: finiteNumber(box.y, `boxes[${index}].y`),
      width: positiveNumber(box.width, `boxes[${index}].width`),
      height: positiveNumber(box.height, `boxes[${index}].height`),
      ...(box.label === undefined
        ? {}
        : { label: nonEmptyString(box.label, `boxes[${index}].label`) })
    }
    if (
      result.x < 0 ||
      result.y < 0 ||
      result.x + result.width > 1 ||
      result.y + result.height > 1
    ) {
      throw new Error(`boxes[${index}] must remain inside the normalized image`)
    }
    return result
  })
  return drawingVisionService.overlay(
    nonEmptyString(input.evidenceId, 'evidenceId'),
    boxes
  )
}

function getCanvasDimensions(): { width: number; height: number } {
  if (
    cadSessionState.status !== 'active' ||
    !cadSessionState.editable ||
    !cadSessionState.viewReady
  ) {
    return { width: 0, height: 0 }
  }
  const { view } = requireEditableCadSession()
  return { width: view.width, height: view.height }
}

interface ExtractedGeometry {
  geometry: EntityGeometry
  chordApproximation: boolean
}

function entityGeometry(entity: AcDbEntity): ExtractedGeometry {
  if (entity instanceof AcDbPoint) {
    return {
      geometry: { kind: 'point', point: { x: entity.position.x, y: entity.position.y } },
      chordApproximation: false
    }
  }
  if (entity instanceof AcDbLine) {
    return {
      geometry: {
        kind: 'segment',
        start: { x: entity.startPoint.x, y: entity.startPoint.y },
        end: { x: entity.endPoint.x, y: entity.endPoint.y }
      },
      chordApproximation: false
    }
  }
  if (entity instanceof AcDbPolyline) {
    const extraction = extractPolylineVertices(entity)
    const vertices = extraction.vertices
    return {
      geometry: {
        kind: 'polyline',
        points: vertices.map(({ x, y }) => ({ x, y })),
        closed: entity.closed
      },
      chordApproximation: !extraction.bulgesVerified || hasBulgeArcs(vertices)
    }
  }
  if (entity instanceof AcDbCircle) {
    return {
      geometry: {
        kind: 'circle',
        center: { x: entity.center.x, y: entity.center.y },
        radius: entity.radius
      },
      chordApproximation: false
    }
  }
  if (entity instanceof AcDbBlockReference) {
    const scaleX = entity.scaleFactors.x
    const scaleY = entity.scaleFactors.y
    if (
      !Number.isFinite(scaleX) ||
      !Number.isFinite(scaleY) ||
      Math.abs(Math.abs(scaleX) - Math.abs(scaleY)) > 1e-9
    ) {
      throw new Error(
        `Block reference ${entity.objectId} has non-uniform scale and cannot be measured exactly`
      )
    }
    const scale = Math.abs(scaleX)
    const position = { x: entity.position.x, y: entity.position.y }
    const rotationDeg = (entity.rotation * 180) / Math.PI
    const symbolName = symbolNameFromBlock(entity.blockName)
    if (symbolName) {
      return {
        geometry: symbolClearanceGeometry(symbolName, position, rotationDeg, scale),
        chordApproximation: false
      }
    }
    if (entity.blockName.startsWith('ENVCAD_MONITORING_')) {
      return {
        geometry: symbolClearanceGeometry('monitoring well', position, rotationDeg, scale),
        chordApproximation: false
      }
    }
  }
  throw new Error(
    `Entity ${entity.objectId} (${entity.type}) is not supported; use a point, line, polyline, circle, or EnvCAD symbol`
  )
}

function chordNotes(extracted: readonly ExtractedGeometry[]): string[] {
  return extracted.some((item) => item.chordApproximation) ? [CHORD_DEGRADATION_NOTE] : []
}

function createPolylineEntity(points: readonly Point2D[], closed: boolean, layer: string): AcDbPolyline {
  const entity = new AcDbPolyline()
  const vertices = closed ? withoutDuplicateClosingVertex(points) : [...points]
  vertices.forEach((point, index) =>
    entity.addVertexAt(index, new AcGePoint2d(point.x, point.y))
  )
  entity.closed = closed
  entity.layer = layer
  return entity
}

function importBoundaryFromCsv(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'import_boundary_from_csv')
  const csvText = nonEmptyString(input.csvText, 'csvText')
  const suppliedPoints = parseBoundaryCsv(csvText)
  const points = withoutDuplicateClosingVertex(suppliedPoints)
  if (points.length < 3 || shoelaceArea(points) <= 0) {
    throw new Error('CSV boundary must enclose a non-zero area')
  }
  const layer = layerFromInput(input) ?? BOUNDARY_LAYER
  const area = shoelaceArea(points)
  const perimeter = polylineLength(points, true)
  const result = runEdit('Agent: import_boundary_from_csv', () => {
    const db = currentDatabase()
    const layerResult = createLayerRecord(db, layer)
    const appliedLayer = canonicalLayerName(layer, db)
    const entity = createPolylineEntity(points, true, appliedLayer)
    db.tables.blockTable.modelSpace.appendEntity(entity)
    return {
      entityId: entity.objectId,
      layer: appliedLayer,
      layerCreated: layerResult.created
    }
  })

  return {
    data: {
      entityIds: [result.entityId],
      entityId: result.entityId,
      layer: result.layer,
      layerCreated: result.layerCreated,
      inputRowCount: suppliedPoints.length,
      vertexCount: points.length,
      area,
      perimeter,
      units: drawingUnits(),
      areaUnits: `${drawingUnits()} squared`
    }
  }
}

function importBoundaryFromGeoJson(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'import_boundary_from_geojson')
  const geojsonText = nonEmptyString(input.geojsonText, 'geojsonText')
  const geometries = parseSupportedGeoJson(geojsonText)
  if (geometries.length === 0) throw new Error('GeoJSON contains no supported geometries')
  if (geometries.length > MAX_IMPORTED_GEOMETRIES_PER_BATCH) {
    throw new Error(
      `GeoJSON expands to ${geometries.length} entities; continue automatically in batches of ` +
        `${MAX_IMPORTED_GEOMETRIES_PER_BATCH}. No CAD change was made.`
    )
  }
  const layer = layerFromInput(input) ?? IMPORT_LAYER

  const result = runEdit('Agent: import_boundary_from_geojson', () => {
    const db = currentDatabase()
    const layerResult = createLayerRecord(db, layer)
    const appliedLayer = canonicalLayerName(layer, db)
    const entityIds: string[] = []
    for (const geometry of geometries) {
      if (geometry.kind === 'point') {
        const point = new AcDbPoint()
        point.position = point3D(geometry.point)
        point.layer = appliedLayer
        db.tables.blockTable.modelSpace.appendEntity(point)
        entityIds.push(point.objectId)
      } else {
        const entity = createPolylineEntity(
          geometry.points,
          geometry.closed,
          appliedLayer
        )
        db.tables.blockTable.modelSpace.appendEntity(entity)
        entityIds.push(entity.objectId)
      }
    }
    return { entityIds, layer: appliedLayer, layerCreated: layerResult.created }
  })

  return {
    data: {
      entityIds: result.entityIds,
      importedCount: result.entityIds.length,
      layer: result.layer,
      layerCreated: result.layerCreated,
      geometryKindCounts: Object.fromEntries(
        [...new Set(geometries.map((geometry) => geometry.kind))].map((kind) => [
          kind,
          geometries.filter((geometry) => geometry.kind === kind).length
        ])
      ),
      crsNote: NO_REPROJECTION_NOTE
    }
  }
}

type BoundaryStatus = 'inside' | 'outside' | 'intersecting'

function boundaryOutline(boundary: PolylineGeometry): PolylineGeometry {
  return {
    kind: 'polyline',
    points: [...boundary.points, boundary.points[0]],
    closed: false
  }
}

function classifyAgainstBoundary(
  candidate: EntityGeometry,
  boundary: PolylineGeometry
): BoundaryStatus {
  const outline = boundaryOutline(boundary)
  if (candidate.kind === 'composite') {
    const statuses = candidate.parts.map((part) => classifyAgainstBoundary(part, boundary))
    if (statuses.every((status) => status === 'inside')) return 'inside'
    if (statuses.every((status) => status === 'outside')) return 'outside'
    return 'intersecting'
  }
  if (candidate.kind === 'point') {
    const location = pointInPolygon(candidate.point, boundary.points)
    return location === 'boundary' ? 'intersecting' : location
  }
  if (candidate.kind === 'circle') {
    const centerLocation = pointInPolygon(candidate.center, boundary.points)
    const edgeDistance = minimumDistance(
      { kind: 'point', point: candidate.center },
      outline
    ).distance
    if (Math.abs(edgeDistance - candidate.radius) <= 1e-9 || edgeDistance < candidate.radius) {
      return 'intersecting'
    }
    return centerLocation === 'inside' ? 'inside' : 'outside'
  }

  const points =
    candidate.kind === 'segment' ? [candidate.start, candidate.end] : candidate.points
  const locations = points.map((point) => pointInPolygon(point, boundary.points))
  if (locations.some((location) => location === 'boundary')) return 'intersecting'
  if (minimumDistance(candidate, outline).distance <= 1e-9) return 'intersecting'
  if (locations.every((location) => location === 'inside')) return 'inside'

  if (
    candidate.kind === 'polyline' &&
    candidate.closed &&
    candidate.points.length >= 3 &&
    polygonsOverlap(candidate.points, boundary.points)
  ) {
    return 'intersecting'
  }
  return locations.every((location) => location === 'outside') ? 'outside' : 'intersecting'
}

function checkInsideBoundary(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'check_inside_boundary')
  const ids = entityIds(input.entityIds)
  const boundaryEntityId = nonEmptyString(input.boundaryEntityId, 'boundaryEntityId')
  const db = currentDatabase()
  const boundaryEntity = db.tables.blockTable.getEntityById(boundaryEntityId)
  if (!boundaryEntity) throw new Error(`Boundary entity id not found: ${boundaryEntityId}`)
  if (!(boundaryEntity instanceof AcDbPolyline) || !boundaryEntity.closed) {
    throw new Error('boundaryEntityId must identify a closed polyline')
  }
  const boundaryExtracted = entityGeometry(boundaryEntity)
  const boundary = boundaryExtracted.geometry
  if (boundary.kind !== 'polyline' || boundary.points.length < 3) {
    throw new Error('Boundary polyline must contain at least three vertices')
  }
  const entities = resolveEntities(ids, db)
  const extracted = entities.map(entityGeometry)
  const results = entities.map((entity, index) => ({
    entityId: entity.objectId,
    status: classifyAgainstBoundary(extracted[index].geometry, boundary)
  }))

  return {
    data: {
      boundaryEntityId,
      results,
      degradationNotes: chordNotes([boundaryExtracted, ...extracted])
    }
  }
}

function checkEntityOverlap(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'check_entity_overlap')
  const ids = entityIds(input.entityIds)
  if (ids.length < 2) throw new Error('entityIds must contain at least two distinct ids')
  const entities = resolveEntities(ids)
  const extracted = entities.map(entityGeometry)
  const overlappingPairs: Array<{ entityIdA: string; entityIdB: string }> = []
  for (let first = 0; first < entities.length; first++) {
    for (let second = first + 1; second < entities.length; second++) {
      if (entityGeometriesOverlap(extracted[first].geometry, extracted[second].geometry)) {
        overlappingPairs.push({
          entityIdA: entities[first].objectId,
          entityIdB: entities[second].objectId
        })
      }
    }
  }
  return {
    data: {
      checkedEntityIds: ids,
      overlappingPairs,
      overlapCount: overlappingPairs.length,
      degradationNotes: chordNotes(extracted)
    }
  }
}

function ensureDashedLinetype(db: AcDbDatabase): boolean {
  if (db.tables.linetypeTable.has('DASHED')) return false
  db.tables.linetypeTable.add(
    new AcDbLinetypeTableRecord({
      name: 'DASHED',
      standardFlag: 0,
      description: 'EnvCAD clearance annotation',
      totalPatternLength: 2,
      pattern: [
        { elementLength: 1, elementTypeFlag: 0 },
        { elementLength: -1, elementTypeFlag: 0 }
      ]
    })
  )
  return true
}

function drawClearanceAnnotation(
  closest: ReturnType<typeof minimumDistance>,
  units: string
): {
  entityIds: string[]
  layerCreated: boolean
  linetypeCreated: boolean
  label: string
} {
  const db = currentDatabase()
  const layerResult = createLayerRecord(db, CLEARANCE_LAYER)
  const linetypeCreated = ensureDashedLinetype(db)
  const line = new AcDbLine(point3D(closest.pointOnA), point3D(closest.pointOnB))
  line.layer = CLEARANCE_LAYER
  line.lineType = 'DASHED'
  line.linetypeScale = Math.max(0.25, closest.distance / 10)
  db.tables.blockTable.modelSpace.appendEntity(line)

  const label = `${closest.distance.toFixed(2)} ${units}`
  const labelEntity = new AcDbText()
  labelEntity.position = point3D({
    x: (closest.pointOnA.x + closest.pointOnB.x) / 2,
    y: (closest.pointOnA.y + closest.pointOnB.y) / 2
  })
  labelEntity.textString = label
  labelEntity.height = Math.min(2.5, Math.max(0.5, closest.distance / 8))
  labelEntity.layer = CLEARANCE_LAYER
  db.tables.blockTable.modelSpace.appendEntity(labelEntity)
  return {
    entityIds: [line.objectId, labelEntity.objectId],
    layerCreated: layerResult.created,
    linetypeCreated,
    label
  }
}

function measureClearance(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'measure_clearance')
  const fromEntityId = nonEmptyString(input.fromEntityId, 'fromEntityId')
  const toEntityId = nonEmptyString(input.toEntityId, 'toEntityId')
  if (fromEntityId === toEntityId) throw new Error('fromEntityId and toEntityId must be different')
  const draw = input.draw === undefined ? false : input.draw
  if (typeof draw !== 'boolean') throw new Error('draw must be a boolean')
  const [fromEntity, toEntity] = resolveEntities([fromEntityId, toEntityId])
  const from = entityGeometry(fromEntity)
  const to = entityGeometry(toEntity)
  const closest = minimumDistance(from.geometry, to.geometry)
  const units = drawingUnits()
  const annotation = draw
    ? runEdit('Agent: measure_clearance', () => drawClearanceAnnotation(closest, units))
    : null

  return {
    data: {
      fromEntityId,
      toEntityId,
      distance: closest.distance,
      units,
      fromClosestPoint: closest.pointOnA,
      toClosestPoint: closest.pointOnB,
      drawn: draw,
      annotationEntityIds: annotation?.entityIds ?? [],
      annotationLayer: annotation ? CLEARANCE_LAYER : null,
      annotationLabel: annotation?.label ?? null,
      layerCreated: annotation?.layerCreated ?? false,
      linetypeCreated: annotation?.linetypeCreated ?? false,
      degradationNotes: chordNotes([from, to])
    }
  }
}

function nextMonitoringBlockName(db: AcDbDatabase, label: string): string {
  const safeLabel = label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'POINT'
  let suffix = 1
  let candidate = `ENVCAD_MONITORING_${safeLabel}`
  while (db.tables.blockTable.has(candidate)) {
    suffix += 1
    candidate = `ENVCAD_MONITORING_${safeLabel}_${suffix}`
  }
  return candidate
}

function placeMonitoringPoints(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'place_monitoring_points')
  if (!Array.isArray(input.points) || input.points.length === 0) {
    throw new Error('points must contain at least one monitoring point')
  }
  const prefix = input.prefix === undefined ? 'MW' : nonEmptyString(input.prefix, 'prefix')
  const points = input.points.map((value, index) => {
    const record = asRecord(value, `points[${index}]`)
    return {
      position: point2D(record, `points[${index}]`),
      label:
        record.label === undefined
          ? `${prefix}-${index + 1}`
          : nonEmptyString(record.label, `points[${index}].label`)
    }
  })

  const placed = runEdit('Agent: place_monitoring_points', () => {
    const db = currentDatabase()
    const layerCreated = createLayerRecord(db, MONITORING_LAYER).created
    const results: Array<{ entityId: string; blockName: string; position: Point2D; label: string }> = []
    for (const point of points) {
      const name = nextMonitoringBlockName(db, point.label)
      createMonitoringPointBlock(db, name, point.label)
      const insert = new AcDbBlockReference(name)
      insert.position = point3D(point.position)
      insert.layer = MONITORING_LAYER
      db.tables.blockTable.modelSpace.appendEntity(insert)
      results.push({
        entityId: insert.objectId,
        blockName: name,
        position: point.position,
        label: point.label
      })
    }
    return { layerCreated, results }
  })

  return {
    data: {
      entityIds: placed.results.map((result) => result.entityId),
      placedCount: placed.results.length,
      labels: placed.results.map((result) => result.label),
      layer: MONITORING_LAYER,
      layerCreated: placed.layerCreated,
      prefix
    }
  }
}

function symbolName(value: unknown): SymbolName {
  const name = nonEmptyString(value, 'name')
  if (!(SYMBOL_NAMES as readonly string[]).includes(name)) {
    throw new Error(`Unknown symbol: ${name}. Available symbols: ${SYMBOL_NAMES.join(', ')}`)
  }
  return name as SymbolName
}

function insertSymbol(rawInput: unknown): ToolResult {
  const input = asRecord(rawInput, 'insert_symbol')
  const name = symbolName(input.name)
  const position = point2D(input.position, 'position')
  const rotationDeg =
    input.rotationDeg === undefined ? 0 : finiteNumber(input.rotationDeg, 'rotationDeg')
  const scale = input.scale === undefined ? 1 : positiveNumber(input.scale, 'scale')
  const result = runEdit('Agent: insert_symbol', () => {
    const db = currentDatabase()
    const block = ensureSymbolBlock(db, name)
    const insert = new AcDbBlockReference(block.blockName)
    insert.position = point3D(position)
    insert.rotation = (rotationDeg * Math.PI) / 180
    insert.scaleFactors = new AcGePoint3d(scale, scale, scale)
    insert.layer = db.clayer
    db.tables.blockTable.modelSpace.appendEntity(insert)
    return {
      entityId: insert.objectId,
      blockName: block.blockName,
      blockCreated: block.created,
      layer: insert.layer
    }
  })
  return {
    data: {
      entityIds: [result.entityId],
      ...result,
      name,
      position,
      rotationDeg,
      scale
    }
  }
}

const REAL_HANDLERS: Record<(typeof CAD_TOOL_NAMES)[number], ToolHandler> = {
  get_selected_entities: (input) => getSelectedEntities(input),
  list_entities: (input) => listEntities(input),
  list_layers: (input) => listLayers(input),
  find_text_overlaps: (input) => findTextOverlaps(input),
  get_entity_text: (input) => getEntityText(input),
  get_polyline_vertices: (input) => getPolylineVertices(input),
  get_drawing_context: () => getDrawingContext(),
  get_view_status: () => getViewStatus(),
  inspect_sheet_preview: (input) => inspectSheetPreview(input),
  inspect_model_view: (input) => inspectModelView(input),
  inspect_region: (input) => inspectRegion(input),
  inspect_selection: (input) => inspectSelection(input),
  compare_before_after: (input) => compareBeforeAfter(input),
  render_analysis_overlay: (input) => renderAnalysisOverlay(input),
  move_entities: (input) => moveEntities(input),
  copy_entities: (input) => copyEntities(input),
  rotate_entities: (input) => rotateEntities(input),
  scale_entities: (input) => scaleEntities(input),
  delete_entities: (input) => deleteEntities(input),
  set_entity_layer: (input) => setEntityLayer(input),
  set_entity_color: (input) => setEntityColor(input),
  change_text: (input) => changeText(input),
  calculate_area: (input) => calculateArea(input),
  calculate_length: (input) => calculateLength(input),
  draw_line: (input) => drawLine(input),
  draw_polyline: (input) => drawPolyline(input),
  draw_rectangle: (input) => drawRectangle(input),
  draw_circle: (input) => drawCircle(input),
  draw_arc: (input) => drawArc(input),
  draw_text: (input) => drawText(input),
  add_linear_dimension: (input) => addLinearDimension(input),
  add_radius_dimension: (input) => addRadiusDimension(input),
  add_leader: (input) => addLeader(input),
  add_mtext: (input) => addMText(input),
  draw_hatch: (input) => drawHatch(input),
  create_layer: (input) => createLayer(input),
  set_layer_properties: (input) => setLayerProperties(input),
  set_current_layer: (input) => setCurrentLayer(input),
  zoom_extents: () => zoomExtents(),
  import_boundary_from_csv: (input) => importBoundaryFromCsv(input),
  import_boundary_from_geojson: (input) => importBoundaryFromGeoJson(input),
  check_inside_boundary: (input) => checkInsideBoundary(input),
  check_entity_overlap: (input) => checkEntityOverlap(input),
  measure_clearance: (input) => measureClearance(input),
  place_monitoring_points: (input) => placeMonitoringPoints(input),
  insert_symbol: (input) => insertSymbol(input),
  get_sheet_setup: () => getSheetSetup(),
  set_sheet_definition: (input) => setSheetDefinition(input),
  set_title_block_fields: (input) => setTitleBlockFields(input)
}

/** Runs the same deterministic browser executor used by both agent and toolbar calls. */
export async function executeCadTool(name: CadToolName, input: unknown): Promise<ToolResult> {
  try {
    return await REAL_HANDLERS[name](input)
  } catch (err) {
    return errorResult(err)
  }
}

/** Registers deterministic browser implementations for every CAD agent tool. */
export function registerCadHandlers() {
  for (const name of CAD_TOOL_NAMES) {
    agentBridge.registerHandler(name, (input) => executeCadTool(name, input))
  }
}
