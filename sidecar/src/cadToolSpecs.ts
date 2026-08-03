import { z } from 'zod'
import type { SelectionContext, ToolResult } from '../../src/agent/protocol'
import {
  CAD_TOOL_NAMES,
  getToolManifestEntry,
  toolCallMayMutate,
  type CadToolName
} from '../../shared/agent-contracts/tool-manifest'
import { utf8ByteLength } from '../../shared/agent-contracts/tool-result'
import { getInputToolSpec } from './inputToolSpecs'

export { CAD_TOOL_NAMES, type CadToolName }

export interface CadToolBridge {
  callTool(name: string, input: unknown): Promise<ToolResult>
  getSelectionSnapshot(): SelectionContext | undefined
  permittedToolNames?(): readonly string[]
}

export interface CadToolSpec<Name extends CadToolName = CadToolName> {
  name: Name
  description: string
  inputSchema: z.ZodObject
  jsonSchema: Record<string, unknown>
  timeoutMs: number
  execute(bridge: CadToolBridge, input: unknown): Promise<ToolResult>
}

export const DEFAULT_PROVIDER_TOOL_OUTPUT_BYTES = 32_000
export const MAX_ENTITY_ID_BATCH_BYTES = 12_000
const MAX_ENTITY_IDS_PER_BATCH = 100
const MAX_TITLE_BLOCK_FIELDS_PER_CALL = 100

export function cadToolMayMutate(name: string, input?: unknown): boolean {
  return toolCallMayMutate(name, input)
}

export function maximumProviderToolOutputBytes(toolName?: string): number {
  return toolName
    ? getToolManifestEntry(toolName)?.maximumOutputBytes ??
        getInputToolSpec(toolName)?.maximumOutputBytes ??
        DEFAULT_PROVIDER_TOOL_OUTPUT_BYTES
    : DEFAULT_PROVIDER_TOOL_OUTPUT_BYTES
}

export { utf8ByteLength }

export function compactMutationResultText(result: ToolResult): string {
  const data =
    typeof result.data === 'object' &&
    result.data !== null &&
    !Array.isArray(result.data)
      ? (result.data as Record<string, unknown>)
      : undefined
  const entityIds = Array.isArray(data?.entityIds)
    ? data.entityIds.filter((value): value is string => typeof value === 'string')
    : []
  return JSON.stringify({
    mutationSucceeded: true,
    metadataCompacted: true,
    affectedEntityCount: entityIds.length,
    entityIdsPreview: entityIds.slice(0, 25),
    entityIdsTruncated: entityIds.length > 25,
    message:
      'The CAD edit completed, but its unexpected full metadata was compacted. Re-read the affected scope with paginated discovery before the next edit.'
  })
}

function entityIdBatch(minimum = 1, maximum = MAX_ENTITY_IDS_PER_BATCH) {
  return z
    .array(z.string().min(1).max(200))
    .min(minimum)
    .max(maximum)
    .superRefine((ids, context) => {
      if (utf8ByteLength(JSON.stringify(ids)) > MAX_ENTITY_ID_BATCH_BYTES) {
        context.addIssue({
          code: 'custom',
          message:
            'this per-call id batch is too large for a guaranteed provider-readable result; ' +
            'continue automatically in smaller batches (this is not a total drawing limit)'
        })
      }
    })
    .describe(
      'One bounded operation batch. Continue automatically with additional batches until every ' +
        'target id is processed; do not ask the user to split the selection.'
    )
}

function titleBlockFields() {
  return z
    .record(z.string().min(1).max(200), z.string().max(4_000))
    .superRefine((fields, context) => {
      if (Object.keys(fields).length > MAX_TITLE_BLOCK_FIELDS_PER_CALL) {
        context.addIssue({
          code: 'custom',
          message: `at most ${MAX_TITLE_BLOCK_FIELDS_PER_CALL} fields may be updated in one call`
        })
      }
    })
}

const Point2D = z.strictObject({
  x: z.number().finite().describe('X coordinate in drawing units'),
  y: z.number().finite().describe('Y coordinate in drawing units')
})
const EntityPageFields = {
  cursor: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Zero-based continuation cursor; use nextCursor from the preceding page'),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(100)
    .describe(
      'Maximum records requested for this page; EnvCAD may return fewer to keep the response provider-readable'
    ),
  detail: z
    .enum(['summary', 'geometry'])
    .default('summary')
    .describe('summary returns index fields; geometry also returns type-specific geometry')
}
const EntityKind = z.enum([
  'text',
  'line',
  'polyline',
  'circle',
  'arc',
  'block',
  'point',
  'hatch',
  'leader',
  'solid',
  'other'
])
const QueryBounds = z.strictObject({
  minX: z.number().finite(),
  minY: z.number().finite(),
  maxX: z.number().finite(),
  maxY: z.number().finite()
})

function validationMessage(name: string, error: z.ZodError): string {
  const details = error.issues
    .map((issue) => {
      const location = issue.path.length > 0 ? issue.path.join('.') : 'input'
      return `${location}: ${issue.message}`
    })
    .join('; ')
  return `Invalid arguments for ${name}: ${details}`
}

function defineTool<Name extends CadToolName>(
  name: Name,
  description: string,
  inputSchema: z.ZodObject,
  prepareInput?: (bridge: CadToolBridge, parsed: unknown) => unknown
): CadToolSpec<Name> {
  const manifest = getToolManifestEntry(name)
  if (!manifest) throw new Error(`Missing canonical tool manifest entry for "${name}".`)
  const jsonSchema = z.toJSONSchema(inputSchema, {
    target: 'draft-07',
    io: 'input',
    reused: 'inline'
  }) as Record<string, unknown>

  return Object.freeze({
    name,
    description,
    inputSchema,
    jsonSchema,
    timeoutMs: manifest.timeoutMs,
    async execute(bridge: CadToolBridge, input: unknown): Promise<ToolResult> {
      const parsed = inputSchema.safeParse(input)
      if (!parsed.success) return { error: validationMessage(name, parsed.error) }
      const mutating = cadToolMayMutate(name, parsed.data)
      if (
        utf8ByteLength(JSON.stringify(parsed.data)) > manifest.maximumInputBytes
      ) {
        return {
          error: mutating
            ? `${name} was not executed because this single edit batch exceeds EnvCAD's ` +
              'provider-readable mutation envelope. Continue automatically with smaller edit ' +
              'batches; this is not a total drawing limit. No CAD change was made.'
            : `${name} was not executed because its arguments exceed EnvCAD's ` +
              'provider-readable input envelope. Retry with a smaller bounded query.'
        }
      }
      const browserInput = prepareInput ? prepareInput(bridge, parsed.data) : parsed.data
      return bridge.callTool(name, browserInput)
    }
  })
}

const specs = [
  defineTool(
    'get_selected_entities',
    'Get the entities in the selection snapshot attached to the current user message. ' +
      'Always call this before acting on "this/these/it/selected"; never guess entity ids. ' +
      'The result is automatically bounded and paginated: when hasMore is true, call again with ' +
      'nextCursor until every selected entity has been read. Never ask the user to make smaller ' +
      'selections merely because a page continues. A zero selectedCount only means there is no ' +
      'selected referent; it does not prevent drawing-wide discovery through list_entities.',
    z.strictObject({
      ...EntityPageFields,
      detail: EntityPageFields.detail.default('geometry')
    })
  ),
  defineTool(
    'list_entities',
    'Discover model-space entities directly from the open drawing; no user selection is required. ' +
      'Use it for named objects, layers, whole-drawing review, and broad requests such as formatting ' +
      'the sheet. Filter by ids, exact layer names, CAD types, friendly kinds, text, or intersecting ' +
      'bounds. Results are automatically bounded and paginated. When hasMore is true, continue with ' +
      'nextCursor using the same filters and detail until complete; never ask the user to select ' +
      'smaller batches because a continuation exists.',
    z.strictObject({
      entityIds: z.array(z.string().min(1)).min(1).optional(),
      layers: z.array(z.string().min(1)).min(1).optional(),
      types: z.array(z.string().min(1)).min(1).optional(),
      kinds: z.array(EntityKind).min(1).optional(),
      textContains: z.string().min(1).optional(),
      bounds: QueryBounds.optional(),
      ...EntityPageFields
    })
  ),
  defineTool(
    'list_layers',
    'Read every drawing layer with color, visibility/lock/plot state, entity count, and entity-kind ' +
      'counts without requiring a selection. Results are automatically bounded and paginated; ' +
      'continue with nextCursor until hasMore is false.',
    z.strictObject({
      cursor: EntityPageFields.cursor,
      pageSize: EntityPageFields.pageSize
    })
  ),
  defineTool(
    'find_text_overlaps',
    'Find connected clusters of TEXT/MTEXT bounding boxes that overlap or violate a requested ' +
      'minimum gap. No selection is required. Use this for whole-drawing note/callout cleanup, ' +
      'then read each cluster through list_entities before moving anything. Large clusters are ' +
      'split into bounded member segments with the same clusterIndex. Continue the top-level ' +
      'nextCursor until hasMore is false to receive every cluster member.',
    z.strictObject({
      layers: z.array(z.string().min(1)).min(1).optional(),
      bounds: QueryBounds.optional(),
      minimumGap: z
        .number()
        .finite()
        .min(0)
        .default(0)
        .describe('Required clear gap between text bounding boxes, in drawing units'),
      cursor: EntityPageFields.cursor,
      pageSize: EntityPageFields.pageSize
    })
  ),
  defineTool(
    'get_entity_text',
    'Read the exact full contents of one TEXT or MTEXT entity without a selection. Entity-list ' +
      'previews are intentionally compact; when hasMore is true, continue with nextCursor until ' +
      'all characters have been read.',
    z.strictObject({
      entityId: z.string().min(1),
      cursor: z.number().int().min(0).default(0),
      chunkSize: z.number().int().min(1).max(16_000).default(8_000)
    })
  ),
  defineTool(
    'get_polyline_vertices',
    'Read every exact vertex and bulge of one polyline without a selection. Geometry summaries ' +
      'show at most the first 50 vertices; when hasMore is true, continue with nextCursor until ' +
      'all vertices have been read.',
    z.strictObject({
      entityId: z.string().min(1),
      cursor: z.number().int().min(0).default(0),
      pageSize: z.number().int().min(1).max(500).default(100)
    })
  ),
  defineTool(
    'get_drawing_context',
    'Get the authoritative document lifecycle, editability, view readiness, active layout, ' +
      'database and sheet units, drawing extents, and the first bounded page of layers with color, ' +
      'state, entity count, and entity-kind counts. If layersHasMore is true, continue with ' +
      'list_layers. No selection is required. This is safe when no drawing is open and then ' +
      'explicitly reports documentOpen=false.',
    z.strictObject({})
  ),
  defineTool(
    'get_view_status',
    'Read the authoritative render state after drawing or fitting: document lifecycle, active ' +
      'layout, canvas dimensions, entity/visible counts, extents, regeneration, last Fit Drawing ' +
      'verification, Sheet Preview status and warnings, and database/sheet unit mismatch. This ' +
      'does not expose drawing text. Use it after a long drawing sequence and after zoom_extents.',
    z.strictObject({})
  ),
  defineTool(
    'inspect_sheet_preview',
    'Return the actual current Sheet Preview as a bounded raster image plus render metadata. ' +
      'This is the only visual-proof tool: entity counts, extents, and get_view_status are not ' +
      'evidence that the page is visible, readable, unclipped, or free of overlap. Use full ' +
      'first; use a quadrant only when the full page lacks enough detail. This tool is read-only ' +
      'and never changes the drawing, page setup, selection, zoom, or active tab.',
    z.strictObject({
      view: z
        .enum([
          'full',
          'top-left',
          'top-right',
          'bottom-left',
          'bottom-right'
        ])
        .default('full')
        .describe('Bounded page view to capture')
      })
  ),
  defineTool(
    'inspect_model_view',
    'Capture the current model canvas as revision-bound visual evidence. Use this for visibility ' +
      'and appearance questions about the active viewport; database metadata alone is not visual proof.',
    z.strictObject({})
  ),
  defineTool(
    'inspect_region',
    'Capture one drawing-coordinate region from the current model viewport. Prefer this over a ' +
      'full view when a bounded area contains the relevant layout or annotation evidence.',
    z.strictObject({
      bounds: QueryBounds.refine(
        (bounds) =>
          bounds.maxX > bounds.minX && bounds.maxY > bounds.minY,
        'Region bounds must have positive width and height'
      )
    })
  ),
  defineTool(
    'inspect_selection',
    'Capture visual evidence around exact entity ids. Read the frozen selection first and pass ' +
      'only the returned ids; the evidence records those ids and the current workspace revision.',
    z.strictObject({
      entityIds: entityIdBatch()
    })
  ),
  defineTool(
    'compare_before_after',
    'Create one bounded side-by-side image from two previously captured evidence ids. The two ' +
      'artifacts must belong to the same drawing.',
    z.strictObject({
      beforeEvidenceId: z.string().min(1).max(200),
      afterEvidenceId: z.string().min(1).max(200)
    })
  ),
  defineTool(
    'render_analysis_overlay',
    'Render bounded normalized highlight boxes over existing visual evidence. Coordinates are ' +
      'fractions of image width and height from 0 through 1.',
    z.strictObject({
      evidenceId: z.string().min(1).max(200),
      boxes: z
        .array(
          z.strictObject({
            x: z.number().min(0).max(1),
            y: z.number().min(0).max(1),
            width: z.number().positive().max(1),
            height: z.number().positive().max(1),
            label: z.string().min(1).max(100).optional()
          }).refine(
            (box) => box.x + box.width <= 1 && box.y + box.height <= 1,
            'Overlay box must remain inside the image'
          )
        )
        .min(1)
        .max(50)
    })
  ),
  defineTool(
    'move_entities',
    'Move one or more entities by a relative offset (dx, dy) in drawing units. For a large ' +
      'target set, repeat this tool automatically with successive id batches until all ids are moved.',
    z.strictObject({
      entityIds: entityIdBatch().describe('Ids of the entities to move in this batch'),
      dx: z.number().finite().describe('Offset along X in drawing units'),
      dy: z.number().finite().describe('Offset along Y in drawing units')
    })
  ),
  defineTool(
    'copy_entities',
    'Duplicate one or more entities, placing the copies offset by (dx, dy) from the originals. ' +
      'The originals are left untouched.',
    z.strictObject({
      entityIds: entityIdBatch().describe('Ids of the entities to copy in this batch'),
      dx: z.number().finite().describe('Offset along X in drawing units for the copies'),
      dy: z.number().finite().describe('Offset along Y in drawing units for the copies')
    })
  ),
  defineTool(
    'rotate_entities',
    'Rotate one or more entities by an angle in degrees. If center is omitted, all the listed ' +
      'entities are rotated together about the center of their combined bounding box, which is ' +
      'NOT the same as rotating each entity about its own base point. Pass center explicitly ' +
      'whenever the pivot matters. The center actually used is echoed in the result.',
    z.strictObject({
      entityIds: entityIdBatch().describe('Ids of the entities to rotate in this batch'),
      angleDeg: z.number().finite().describe('Rotation angle in degrees, counter-clockwise positive'),
      center: Point2D.optional().describe(
        'Pivot point in drawing units; defaults to the center of the combined bounding box of entityIds'
      )
    })
  ),
  defineTool(
    'scale_entities',
    'Scale one or more entities by a factor. If center is omitted, all the listed entities are ' +
      'scaled together about the center of their combined bounding box, which is NOT the same as ' +
      'scaling each entity about its own base point. Pass center explicitly whenever the base ' +
      'point matters. The center actually used is echoed in the result.',
    z.strictObject({
      entityIds: entityIdBatch().describe('Ids of the entities to scale in this batch'),
      factor: z.number().positive().finite().describe('Scale factor, e.g. 2 doubles size, 0.5 halves it'),
      center: Point2D.optional().describe(
        'Base point in drawing units; defaults to the center of the combined bounding box of entityIds'
      )
    })
  ),
  defineTool(
    'delete_entities',
    'Delete one or more entities from the drawing.',
    z.strictObject({
      entityIds: entityIdBatch().describe('Ids of the entities to delete in this batch')
    })
  ),
  defineTool(
    'set_entity_layer',
    'Move one or more entities to a different layer. If the layer does not exist it is created ' +
      'automatically and the result reports layerCreated: true — so check the existing layer ' +
      'names with get_drawing_context first and confirm with the user before introducing a new ' +
      'layer, rather than silently creating one from a misspelled name.',
    z.strictObject({
      entityIds: entityIdBatch().describe('Ids of the entities to re-layer in this batch'),
      layerName: z.string().min(1).describe('Name of the destination layer')
    })
  ),
  defineTool(
    'set_entity_color',
    'Set one or more entities to inherit color from their layer/block or use one explicit color. ' +
      'Use list_entities to inspect stored and resolved colors first. This is the correct way to ' +
      'repair explicit true-white entities; changing their layer alone does not override an ' +
      'explicit entity color. The whole call is one undoable edit.',
    z.strictObject({
      entityIds: entityIdBatch(),
      mode: z.enum(['by-layer', 'by-block', 'explicit']),
      colorCss: z
        .string()
        .min(1)
        .optional()
        .describe('Required only for explicit mode, e.g. "#000000"')
    })
  ),
  defineTool(
    'change_text',
    'Replace the text content of a single TEXT or MTEXT entity.',
    z.strictObject({
      entityId: z.string().min(1).describe('Id of the text entity to edit'),
      newText: z.string().describe('New text content')
    })
  ),
  defineTool(
    'calculate_area',
    'Compute the enclosed area of one or more closed entities (closed polylines, circles, ' +
      'hatches), in drawing units squared. Bulge (arc) segments of a polyline are included ' +
      'exactly. Fails on open entities rather than assuming a closing segment. Always use this ' +
      'instead of estimating an area yourself, and report the units it returns.',
    z.strictObject({
      entityIds: entityIdBatch().describe('Ids of the entities to measure in this batch')
    })
  ),
  defineTool(
    'calculate_length',
    'Compute the total length of one or more entities (lines, polylines, arcs, and circle ' +
      'circumferences), in drawing units. Bulge (arc) segments of a polyline are measured along ' +
      'the arc, not the chord. Always use this instead of estimating a length yourself, and ' +
      'report the units it returns.',
    z.strictObject({
      entityIds: entityIdBatch().describe('Ids of the entities to measure in this batch')
    })
  ),
  defineTool(
    'draw_line',
    'Draw a straight line segment from one point to another, in drawing units.',
    z.strictObject({
      start: Point2D.describe('Line start point'),
      end: Point2D.describe('Line end point'),
      layer: z.string().min(1).optional().describe('Destination layer name; defaults to the current layer')
    })
  ),
  defineTool(
    'draw_polyline',
    'Draw a connected polyline through an ordered list of vertices, in drawing units.',
    z.strictObject({
      points: z.array(Point2D).min(2).describe('Ordered vertices of the polyline'),
      closed: z.boolean().default(false).describe('Whether to close the polyline back to its first vertex'),
      layer: z.string().min(1).optional().describe('Destination layer name; defaults to the current layer')
    })
  ),
  defineTool(
    'draw_rectangle',
    'Draw an axis-aligned rectangle given two opposite corners, in drawing units.',
    z.strictObject({
      corner1: Point2D.describe('First corner'),
      corner2: Point2D.describe('Opposite corner'),
      layer: z.string().min(1).optional().describe('Destination layer name; defaults to the current layer')
    })
  ),
  defineTool(
    'draw_circle',
    'Draw a circle given a center point and radius, in drawing units.',
    z.strictObject({
      center: Point2D.describe('Circle center'),
      radius: z.number().positive().finite().describe('Circle radius in drawing units'),
      layer: z.string().min(1).optional().describe('Destination layer name; defaults to the current layer')
    })
  ),
  defineTool(
    'draw_arc',
    'Draw a circular arc given a center, radius, and start/end angles in degrees ' +
      '(counter-clockwise from the positive X axis).',
    z.strictObject({
      center: Point2D.describe('Arc center'),
      radius: z.number().positive().finite().describe('Arc radius in drawing units'),
      startAngleDeg: z.number().finite().describe('Start angle in degrees'),
      endAngleDeg: z.number().finite().describe('End angle in degrees'),
      layer: z.string().min(1).optional().describe('Destination layer name; defaults to the current layer')
    })
  ),
  defineTool(
    'draw_text',
    'Place a single-line text entity at a position, in drawing units.',
    z.strictObject({
      position: Point2D.describe('Text insertion point'),
      text: z.string().describe('Text content'),
      height: z.number().positive().finite().default(2.5).describe('Text height in drawing units'),
      layer: z.string().min(1).optional().describe('Destination layer name; defaults to the current layer')
    })
  ),
  defineTool(
    'add_linear_dimension',
    'Add an exact linear dimension between two definition points. Horizontal dimensions ' +
      'measure the X projection, vertical dimensions measure the Y projection, and aligned ' +
      'dimensions measure the true point-to-point distance. The browser computes the value and ' +
      'formats the visible label to exactly two decimals; never calculate or substitute the ' +
      'label yourself. Positive horizontal offsets place the dimension above p1; positive ' +
      'vertical offsets place it to the right of p1; positive aligned offsets use the left-hand ' +
      'normal from p1 toward p2. Creates the DIMENSIONS layer if needed.',
    z.strictObject({
      p1: Point2D.describe('First dimension definition point from actual entity geometry'),
      p2: Point2D.describe('Second dimension definition point from actual entity geometry'),
      offset: z.number().finite().describe('Signed dimension-line offset in drawing units'),
      orientation: z
        .enum(['horizontal', 'vertical', 'aligned'])
        .describe('Direction in which the dimension is measured')
    })
  ),
  defineTool(
    'add_radius_dimension',
    'Add an exact radius dimension to an existing circle. The browser reads the circle center ' +
      'and radius from the drawing database, computes the visible R label to exactly two decimals, ' +
      'and creates the destination layer if needed (DIMENSIONS by default). Use the actual circle ' +
      'id returned by draw_circle or get_selected_entities; do not infer a radius or center.',
    z.strictObject({
      circleEntityId: z.string().min(1).describe('Object id of an existing AcDbCircle'),
      angleDeg: z
        .number()
        .finite()
        .optional()
        .describe('Leader angle counter-clockwise from +X; defaults to 45 degrees'),
      layer: z
        .string()
        .min(1)
        .optional()
        .describe('Destination layer name; defaults to DIMENSIONS')
    })
  ),
  defineTool(
    'add_leader',
    'Add an arrowed leader and associated multiline annotation text. Creates the DIMENSIONS ' +
      'layer if needed. If textPosition is omitted, the browser places the label diagonally ' +
      'away from the target to avoid covering it.',
    z.strictObject({
      targetPoint: Point2D.describe('Point the leader arrow identifies'),
      text: z.string().min(1).describe('Leader annotation text'),
      textPosition: Point2D.optional().describe(
        'Annotation insertion point; omit for a non-overlapping default'
      )
    })
  ),
  defineTool(
    'add_mtext',
    'Place multiline text at a drawing position. Height is in drawing units. Defaults to the ' +
      'DIMENSIONS layer, which is created automatically; a named layer is also created if needed.',
    z.strictObject({
      position: Point2D.describe('Top-left text insertion point'),
      text: z.string().min(1).describe('Multiline text content'),
      height: z.number().positive().finite().optional().describe('Text height in drawing units; defaults to 2.5'),
      layer: z.string().min(1).optional().describe('Destination layer; defaults to DIMENSIONS')
    })
  ),
  defineTool(
    'draw_hatch',
    'Fill a closed polygon boundary with a hatch pattern, in drawing units.',
    z.strictObject({
      boundary: z.array(Point2D).min(3).describe('Ordered vertices of the closed boundary'),
      pattern: z.string().min(1).default('SOLID').describe('Hatch pattern name, e.g. "SOLID", "ANSI31"'),
      layer: z.string().min(1).optional().describe('Destination layer name; defaults to the current layer')
    })
  ),
  defineTool(
    'create_layer',
    'Create a new layer in the drawing.',
    z.strictObject({
      name: z.string().min(1).describe('New layer name'),
      colorCss: z.string().min(1).optional().describe('CSS color for the layer, e.g. "#ff0000"')
    })
  ),
  defineTool(
    'set_layer_properties',
    'Change one or more properties of an existing layer as one undoable edit. Omitted properties ' +
      'remain unchanged. Read the exact layer name and current properties from get_drawing_context ' +
      'first. At least one property besides name is required.',
    z.strictObject({
      name: z.string().min(1).describe('Exact existing layer name'),
      colorCss: z.string().min(1).optional().describe('CSS color, e.g. "#ff0000"'),
      isOff: z.boolean().optional(),
      isFrozen: z.boolean().optional(),
      isLocked: z.boolean().optional(),
      isPlottable: z.boolean().optional()
    })
  ),
  defineTool(
    'set_current_layer',
    'Set the current (active) layer that new entities are drawn onto.',
    z.strictObject({
      name: z.string().min(1).describe('Layer name to make current (must already exist)')
    })
  ),
  defineTool(
    'zoom_extents',
    'Run the same verified Fit Drawing operation as the toolbar. It requires an active editable ' +
      'Model view, regenerates visible geometry, rejects invalid extents, fits with padding, and ' +
      'fails unless the complete extents are proven inside the resulting viewport.',
    z.strictObject({})
  ),
  defineTool(
    'import_boundary_from_csv',
    'Import x,y CSV rows (optional x,y header; coordinates are drawing units) as one closed ' +
      'boundary polyline. The browser computes and returns its exact straight-edge area and ' +
      'perimeter. A duplicated final closing row is accepted. Defaults to the BOUNDARY layer.',
    z.strictObject({
      csvText: z.string().min(1).describe('CSV text containing x,y coordinate rows'),
      layer: z.string().min(1).optional().describe('Destination layer; defaults to BOUNDARY')
    })
  ),
  defineTool(
    'import_boundary_from_geojson',
    'Import GeoJSON Point, LineString, and Polygon features as CAD points and polylines. ' +
      'Polygon exterior and interior rings become separate closed polylines. Coordinates are ' +
      'used as-is: CRS reprojection is NOT performed, and that note is returned to the caller. ' +
      'For a larger collection, continue automatically with successive FeatureCollection batches.',
    z.strictObject({
      geojsonText: z.string().min(1).describe('GeoJSON FeatureCollection, Feature, or geometry text'),
      layer: z.string().min(1).optional().describe('Destination layer; defaults to IMPORT')
    })
  ),
  defineTool(
    'check_inside_boundary',
    'Classify each entity as inside, outside, or intersecting a closed boundary polyline. ' +
      'This is the authoritative tool for siting questions; never eyeball containment. ' +
      'Arc-segmented polylines use their chord polygons and the result reports that degradation.',
    z.strictObject({
      entityIds: entityIdBatch().describe('Entity ids to classify in this batch'),
      boundaryEntityId: z.string().min(1).describe('Id of the closed boundary polyline')
    })
  ),
  defineTool(
    'check_entity_overlap',
    'Return every overlapping pair among two or more point, line, polyline/polygon, circle, or ' +
      'EnvCAD symbol entities. Closed polylines and circles are treated as regions. ' +
      'Arc-segmented polylines use chords and the result reports that degradation.',
    z.strictObject({
      entityIds: entityIdBatch(2, 10).describe(
        'Entity ids to check pairwise in this call; use repeated pair/group calls for larger sets'
      )
    })
  ),
  defineTool(
    'measure_clearance',
    'Compute the exact minimum distance and the closest point on each of two supported entities. ' +
      'When draw is true, add one dashed clearance line and one computed distance label on the ' +
      'CLEARANCE layer; the entire annotation is one Ctrl+Z undo step. Arc-segmented polylines ' +
      'use chord geometry and the result reports that degradation.',
    z.strictObject({
      fromEntityId: z.string().min(1).describe('First entity id'),
      toEntityId: z.string().min(1).describe('Second entity id'),
      draw: z.boolean().optional().describe('Draw the dashed annotation; defaults to false')
    })
  ),
  defineTool(
    'place_monitoring_points',
    'Place labelled monitoring-well symbol blocks (circle, crosshair, and label) on the ' +
      'MONITORING layer. Missing labels are generated as prefix-1 through prefix-n. The whole ' +
      'call is one Ctrl+Z undo step.',
    z.strictObject({
      points: z
        .array(
          z.strictObject({
            ...Point2D.shape,
            label: z
              .string()
              .min(1)
              .max(200)
              .optional()
              .describe('Optional explicit point label')
          })
        )
        .min(1)
        .max(50)
        .describe(
          'One placement batch; continue automatically with explicit labels for additional points'
        ),
      prefix: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe('Generated-label prefix; defaults to MW')
    })
  ),
  defineTool(
    'insert_symbol',
    'Insert a reusable block from the EnvCAD environmental symbol library at the supplied ' +
      'drawing position. Rotation is counter-clockwise in degrees and scale is uniform.',
    z.strictObject({
      name: z.enum([
        'monitoring well',
        'storage tank',
        'generator',
        'drain arrow',
        'tree',
        'north arrow'
      ]),
      position: Point2D,
      rotationDeg: z.number().finite().optional().describe('Counter-clockwise rotation; defaults to 0'),
      scale: z.number().positive().finite().optional().describe('Uniform scale; defaults to 1')
    })
  ),
  defineTool(
    'get_sheet_setup',
    'Get the current sheet/page setup together with the exact ids you are allowed to pass to ' +
      'set_sheet_definition: every supported paper size id, and every title-block template with ' +
      'its id, description, supported papers, and the field keys it renders. Call this before ' +
      'setting a paper size, template, or title-block field so you use real ids instead of ' +
      'guessing them.',
    z.strictObject({})
  ),
  defineTool(
    'set_sheet_definition',
    'Partially update the current sheet/page-setup definition. Only the fields provided are ' +
      'changed; omit a field to leave it unchanged. paper and templateId must be ids returned ' +
      'by get_sheet_setup. Sheet settings live outside the drawing database, so this change is ' +
      'NOT undoable with Ctrl+Z — say so when you report it.',
    z.strictObject({
      paper: z
        .string()
        .min(1)
        .optional()
        .describe('Paper size id from get_sheet_setup, e.g. "A3", "LETTER"'),
      orientation: z.enum(['portrait', 'landscape']).optional(),
      scaleDenominator: z
        .number()
        .positive()
        .finite()
        .optional()
        .describe('Denominator of the drawing scale, e.g. 250 for 1:250'),
      drawingUnit: z
        .enum(['m', 'mm'])
        .optional()
        .describe(
          'Explicit sheet interpretation unit. Changing this never scales model geometry.'
        ),
      templateId: z.string().min(1).optional().describe('Id of the title-block template, from get_sheet_setup'),
      fields: titleBlockFields()
        .optional()
        .describe('Title-block field values keyed by the template field keys from get_sheet_setup')
    })
  ),
  defineTool(
    'set_title_block_fields',
    'Update one or more title-block field values (e.g. PROJECT, DRAWING_TITLE, CLIENT) without ' +
      'changing any other sheet settings. Keys must be field keys of the active template — see ' +
      'get_sheet_setup; the result reports a bounded ignored-field preview/count. ' +
      'Not undoable with Ctrl+Z.',
    z.strictObject({
      fields: titleBlockFields()
        .describe('Title-block field values, keyed by template field key')
    })
  )
] as const satisfies readonly CadToolSpec[]

export const CAD_TOOL_SPECS: readonly CadToolSpec[] = Object.freeze([...specs])

const specificationNames = new Set(specs.map((spec) => spec.name))
if (
  specificationNames.size !== CAD_TOOL_NAMES.length ||
  CAD_TOOL_NAMES.some((name) => !specificationNames.has(name))
) {
  throw new Error('CAD tool specifications do not match the canonical tool manifest.')
}

const SPEC_BY_NAME = new Map<string, (typeof specs)[number]>(
  specs.map((spec) => [spec.name, spec])
)

export function getCadToolSpec(
  name: string
): (typeof specs)[number] | undefined {
  return SPEC_BY_NAME.get(name)
}

export async function executeCadTool(
  bridge: CadToolBridge,
  name: string,
  input: unknown
): Promise<ToolResult> {
  const spec = getCadToolSpec(name)
  if (!spec) return { error: `Unknown CAD tool: ${name}` }
  return spec.execute(bridge, input)
}
