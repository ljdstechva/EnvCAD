import { z } from 'zod'
import type { SelectionSnapshot, ToolResult } from '../../src/agent/protocol'

export interface CadToolBridge {
  callTool(name: string, input: unknown): Promise<ToolResult>
  getSelectionSnapshot(): SelectionSnapshot | undefined
}

export interface CadToolSpec<Name extends string = string> {
  name: Name
  description: string
  inputSchema: z.ZodObject
  jsonSchema: Record<string, unknown>
  timeoutMs: number
  execute(bridge: CadToolBridge, input: unknown): Promise<ToolResult>
}

const DEFAULT_TOOL_TIMEOUT_MS = 30_000
const Point2D = z.strictObject({
  x: z.number().finite().describe('X coordinate in drawing units'),
  y: z.number().finite().describe('Y coordinate in drawing units')
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

function defineTool<Name extends string>(
  name: Name,
  description: string,
  inputSchema: z.ZodObject,
  prepareInput?: (bridge: CadToolBridge, parsed: unknown) => unknown
): CadToolSpec<Name> {
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
    timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
    async execute(bridge: CadToolBridge, input: unknown): Promise<ToolResult> {
      const parsed = inputSchema.safeParse(input)
      if (!parsed.success) return { error: validationMessage(name, parsed.error) }
      const browserInput = prepareInput ? prepareInput(bridge, parsed.data) : parsed.data
      return bridge.callTool(name, browserInput)
    }
  })
}

const specs = [
  defineTool(
    'get_selected_entities',
    'Get the entities in the selection snapshot attached to the current user message. ' +
      'Always call this before acting on "this/these/it/selected" — never guess entity ids. ' +
      'Returns selectedCount: 0 with an empty entities list when the user had nothing selected ' +
      'at the moment they sent their message; that is a definitive "no selection", not a ' +
      'failure, and you must stop and ask them to select something rather than picking entities ' +
      'yourself.',
    z.strictObject({}),
    (bridge) => ({ ids: bridge.getSelectionSnapshot()?.ids ?? [] })
  ),
  defineTool(
    'get_drawing_context',
    'Get the current drawing units, the list of layers (with visibility), the current layer, ' +
      'and the drawing extents (bounding box).',
    z.strictObject({})
  ),
  defineTool(
    'move_entities',
    'Move one or more entities by a relative offset (dx, dy) in drawing units.',
    z.strictObject({
      entityIds: z.array(z.string()).min(1).describe('Ids of the entities to move'),
      dx: z.number().finite().describe('Offset along X in drawing units'),
      dy: z.number().finite().describe('Offset along Y in drawing units')
    })
  ),
  defineTool(
    'copy_entities',
    'Duplicate one or more entities, placing the copies offset by (dx, dy) from the originals. ' +
      'The originals are left untouched.',
    z.strictObject({
      entityIds: z.array(z.string()).min(1).describe('Ids of the entities to copy'),
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
      entityIds: z.array(z.string()).min(1).describe('Ids of the entities to rotate'),
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
      entityIds: z.array(z.string()).min(1).describe('Ids of the entities to scale'),
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
      entityIds: z.array(z.string()).min(1).describe('Ids of the entities to delete')
    })
  ),
  defineTool(
    'set_entity_layer',
    'Move one or more entities to a different layer. If the layer does not exist it is created ' +
      'automatically and the result reports layerCreated: true — so check the existing layer ' +
      'names with get_drawing_context first and confirm with the user before introducing a new ' +
      'layer, rather than silently creating one from a misspelled name.',
    z.strictObject({
      entityIds: z.array(z.string()).min(1).describe('Ids of the entities to re-layer'),
      layerName: z.string().min(1).describe('Name of the destination layer')
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
      entityIds: z.array(z.string()).min(1).describe('Ids of the entities to measure')
    })
  ),
  defineTool(
    'calculate_length',
    'Compute the total length of one or more entities (lines, polylines, arcs, and circle ' +
      'circumferences), in drawing units. Bulge (arc) segments of a polyline are measured along ' +
      'the arc, not the chord. Always use this instead of estimating a length yourself, and ' +
      'report the units it returns.',
    z.strictObject({
      entityIds: z.array(z.string()).min(1).describe('Ids of the entities to measure')
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
    'set_current_layer',
    'Set the current (active) layer that new entities are drawn onto.',
    z.strictObject({
      name: z.string().min(1).describe('Layer name to make current (must already exist)')
    })
  ),
  defineTool(
    'zoom_extents',
    'Zoom and pan the viewport to fit the entire drawing.',
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
      'used as-is: CRS reprojection is NOT performed, and that note is returned to the caller.',
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
      entityIds: z.array(z.string()).min(1).describe('Entity ids to classify'),
      boundaryEntityId: z.string().min(1).describe('Id of the closed boundary polyline')
    })
  ),
  defineTool(
    'check_entity_overlap',
    'Return every overlapping pair among two or more point, line, polyline/polygon, circle, or ' +
      'EnvCAD symbol entities. Closed polylines and circles are treated as regions. ' +
      'Arc-segmented polylines use chords and the result reports that degradation.',
    z.strictObject({
      entityIds: z.array(z.string()).min(2).describe('Entity ids to check pairwise')
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
            label: z.string().min(1).optional().describe('Optional explicit point label')
          })
        )
        .min(1),
      prefix: z.string().min(1).optional().describe('Generated-label prefix; defaults to MW')
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
      templateId: z.string().min(1).optional().describe('Id of the title-block template, from get_sheet_setup'),
      fields: z
        .record(z.string(), z.string())
        .optional()
        .describe('Title-block field values keyed by the template field keys from get_sheet_setup')
    })
  ),
  defineTool(
    'set_title_block_fields',
    'Update one or more title-block field values (e.g. PROJECT, DRAWING_TITLE, CLIENT) without ' +
      'changing any other sheet settings. Keys must be field keys of the active template — see ' +
      'get_sheet_setup; any key the template does not define is stored but never rendered and ' +
      'comes back in ignoredFieldKeys. Not undoable with Ctrl+Z.',
    z.strictObject({
      fields: z
        .record(z.string(), z.string())
        .describe('Title-block field values, keyed by template field key')
    })
  )
] as const satisfies readonly CadToolSpec[]

export const CAD_TOOL_SPECS: readonly CadToolSpec[] = Object.freeze([...specs])
export type CadToolName = (typeof specs)[number]['name']
export const CAD_TOOL_NAMES = Object.freeze(
  specs.map((spec) => spec.name)
) as readonly CadToolName[]

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
