import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { ToolResult } from '../../src/agent/protocol'
import type { ToolBridge } from './types'

const Point2D = {
  x: z.number().describe('X coordinate in drawing units'),
  y: z.number().describe('Y coordinate in drawing units')
}

interface ForwardedCallToolResult {
  [key: string]: unknown
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function toCallToolResult(result: ToolResult): ForwardedCallToolResult {
  if (result.error) {
    return { content: [{ type: 'text', text: result.error }], isError: true }
  }
  const text =
    typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? null, null, 2)
  return { content: [{ type: 'text', text }] }
}

/** Registers a tool whose handler forwards its args verbatim to the browser. */
function passthrough<Shape extends z.ZodRawShape>(
  bridge: ToolBridge,
  name: string,
  description: string,
  shape: Shape
) {
  return tool(name, description, shape, async (args) => {
    const result = await bridge.callTool(name, args)
    return toCallToolResult(result)
  })
}

export function createCadMcpServer(bridge: ToolBridge) {
  const getSelectedEntities = tool(
    'get_selected_entities',
    'Get the entities in the selection snapshot attached to the current user message. ' +
      'Always call this before acting on "this/these/it/selected" — never guess entity ids. ' +
      'Returns selectedCount: 0 with an empty entities list when the user had nothing selected ' +
      'at the moment they sent their message; that is a definitive "no selection", not a ' +
      'failure, and you must stop and ask them to select something rather than picking entities ' +
      'yourself.',
    {},
    async () => {
      const snapshot = bridge.getSelectionSnapshot()
      const result = await bridge.callTool('get_selected_entities', {
        ids: snapshot?.ids ?? []
      })
      return toCallToolResult(result)
    }
  )

  const getDrawingContext = passthrough(
    bridge,
    'get_drawing_context',
    'Get the current drawing units, the list of layers (with visibility), the current layer, ' +
      'and the drawing extents (bounding box).',
    {}
  )

  const moveEntities = passthrough(
    bridge,
    'move_entities',
    'Move one or more entities by a relative offset (dx, dy) in drawing units.',
    {
      entityIds: z.array(z.string()).min(1).describe('Ids of the entities to move'),
      dx: z.number().describe('Offset along X in drawing units'),
      dy: z.number().describe('Offset along Y in drawing units')
    }
  )

  const copyEntities = passthrough(
    bridge,
    'copy_entities',
    'Duplicate one or more entities, placing the copies offset by (dx, dy) from the originals. ' +
      'The originals are left untouched.',
    {
      entityIds: z.array(z.string()).min(1).describe('Ids of the entities to copy'),
      dx: z.number().describe('Offset along X in drawing units for the copies'),
      dy: z.number().describe('Offset along Y in drawing units for the copies')
    }
  )

  const rotateEntities = passthrough(
    bridge,
    'rotate_entities',
    'Rotate one or more entities by an angle in degrees. If center is omitted, all the listed ' +
      'entities are rotated together about the center of their combined bounding box, which is ' +
      'NOT the same as rotating each entity about its own base point. Pass center explicitly ' +
      'whenever the pivot matters. The center actually used is echoed in the result.',
    {
      entityIds: z.array(z.string()).min(1).describe('Ids of the entities to rotate'),
      angleDeg: z.number().describe('Rotation angle in degrees, counter-clockwise positive'),
      center: z
        .object(Point2D)
        .optional()
        .describe(
          'Pivot point in drawing units; defaults to the center of the combined bounding box of entityIds'
        )
    }
  )

  const scaleEntities = passthrough(
    bridge,
    'scale_entities',
    'Scale one or more entities by a factor. If center is omitted, all the listed entities are ' +
      'scaled together about the center of their combined bounding box, which is NOT the same as ' +
      'scaling each entity about its own base point. Pass center explicitly whenever the base ' +
      'point matters. The center actually used is echoed in the result.',
    {
      entityIds: z.array(z.string()).min(1).describe('Ids of the entities to scale'),
      factor: z.number().positive().describe('Scale factor, e.g. 2 doubles size, 0.5 halves it'),
      center: z
        .object(Point2D)
        .optional()
        .describe(
          'Base point in drawing units; defaults to the center of the combined bounding box of entityIds'
        )
    }
  )

  const deleteEntities = passthrough(
    bridge,
    'delete_entities',
    'Delete one or more entities from the drawing.',
    {
      entityIds: z.array(z.string()).min(1).describe('Ids of the entities to delete')
    }
  )

  const setEntityLayer = passthrough(
    bridge,
    'set_entity_layer',
    'Move one or more entities to a different layer. If the layer does not exist it is created ' +
      'automatically and the result reports layerCreated: true — so check the existing layer ' +
      'names with get_drawing_context first and confirm with the user before introducing a new ' +
      'layer, rather than silently creating one from a misspelled name.',
    {
      entityIds: z.array(z.string()).min(1).describe('Ids of the entities to re-layer'),
      layerName: z.string().describe('Name of the destination layer')
    }
  )

  const changeText = passthrough(
    bridge,
    'change_text',
    'Replace the text content of a single TEXT or MTEXT entity.',
    {
      entityId: z.string().describe('Id of the text entity to edit'),
      newText: z.string().describe('New text content')
    }
  )

  const calculateArea = passthrough(
    bridge,
    'calculate_area',
    'Compute the enclosed area of one or more closed entities (closed polylines, circles, ' +
      'hatches), in drawing units squared. Bulge (arc) segments of a polyline are included ' +
      'exactly. Fails on open entities rather than assuming a closing segment. Always use this ' +
      'instead of estimating an area yourself, and report the units it returns.',
    {
      entityIds: z.array(z.string()).min(1).describe('Ids of the entities to measure')
    }
  )

  const calculateLength = passthrough(
    bridge,
    'calculate_length',
    "Compute the total length of one or more entities (lines, polylines, arcs, circles' " +
      'circumference), in drawing units. Bulge (arc) segments of a polyline are measured along ' +
      'the arc, not the chord. Always use this instead of estimating a length yourself, and ' +
      'report the units it returns.',
    {
      entityIds: z.array(z.string()).min(1).describe('Ids of the entities to measure')
    }
  )

  const drawLine = passthrough(
    bridge,
    'draw_line',
    'Draw a straight line segment from one point to another, in drawing units.',
    {
      start: z.object(Point2D).describe('Line start point'),
      end: z.object(Point2D).describe('Line end point'),
      layer: z.string().optional().describe('Destination layer name; defaults to the current layer')
    }
  )

  const drawPolyline = passthrough(
    bridge,
    'draw_polyline',
    'Draw a connected polyline through an ordered list of vertices, in drawing units.',
    {
      points: z.array(z.object(Point2D)).min(2).describe('Ordered vertices of the polyline'),
      closed: z.boolean().default(false).describe('Whether to close the polyline back to its first vertex'),
      layer: z.string().optional().describe('Destination layer name; defaults to the current layer')
    }
  )

  const drawRectangle = passthrough(
    bridge,
    'draw_rectangle',
    'Draw an axis-aligned rectangle given two opposite corners, in drawing units.',
    {
      corner1: z.object(Point2D).describe('First corner'),
      corner2: z.object(Point2D).describe('Opposite corner'),
      layer: z.string().optional().describe('Destination layer name; defaults to the current layer')
    }
  )

  const drawCircle = passthrough(
    bridge,
    'draw_circle',
    'Draw a circle given a center point and radius, in drawing units.',
    {
      center: z.object(Point2D).describe('Circle center'),
      radius: z.number().positive().describe('Circle radius in drawing units'),
      layer: z.string().optional().describe('Destination layer name; defaults to the current layer')
    }
  )

  const drawArc = passthrough(
    bridge,
    'draw_arc',
    'Draw a circular arc given a center, radius, and start/end angles in degrees ' +
      '(counter-clockwise from the positive X axis).',
    {
      center: z.object(Point2D).describe('Arc center'),
      radius: z.number().positive().describe('Arc radius in drawing units'),
      startAngleDeg: z.number().describe('Start angle in degrees'),
      endAngleDeg: z.number().describe('End angle in degrees'),
      layer: z.string().optional().describe('Destination layer name; defaults to the current layer')
    }
  )

  const drawText = passthrough(
    bridge,
    'draw_text',
    'Place a single-line text entity at a position, in drawing units.',
    {
      position: z.object(Point2D).describe('Text insertion point'),
      text: z.string().describe('Text content'),
      height: z.number().positive().default(2.5).describe('Text height in drawing units'),
      layer: z.string().optional().describe('Destination layer name; defaults to the current layer')
    }
  )

  const addLinearDimension = passthrough(
    bridge,
    'add_linear_dimension',
    'Add an exact linear dimension between two definition points. Horizontal dimensions ' +
      'measure the X projection, vertical dimensions measure the Y projection, and aligned ' +
      'dimensions measure the true point-to-point distance. The browser computes the value and ' +
      'formats the visible label to exactly two decimals; never calculate or substitute the ' +
      'label yourself. Positive horizontal offsets place the dimension above p1; positive ' +
      'vertical offsets place it to the right of p1; positive aligned offsets use the left-hand ' +
      'normal from p1 toward p2. Creates the DIMENSIONS layer if needed.',
    {
      p1: z.object(Point2D).describe('First dimension definition point from actual entity geometry'),
      p2: z.object(Point2D).describe('Second dimension definition point from actual entity geometry'),
      offset: z.number().describe('Signed dimension-line offset in drawing units'),
      orientation: z
        .enum(['horizontal', 'vertical', 'aligned'])
        .describe('Direction in which the dimension is measured')
    }
  )

  const addRadiusDimension = passthrough(
    bridge,
    'add_radius_dimension',
    'Add an exact radius dimension to an existing circle. The browser reads the circle center ' +
      'and radius from the drawing database, computes the visible R label to exactly two decimals, ' +
      'and creates the DIMENSIONS layer if needed. Use the id returned by ' +
      'get_selected_entities; do not infer a radius or center.',
    {
      circleEntityId: z.string().describe('Object id of an existing AcDbCircle'),
      angleDeg: z
        .number()
        .optional()
        .describe('Leader angle counter-clockwise from +X; defaults to 45 degrees')
    }
  )

  const addLeader = passthrough(
    bridge,
    'add_leader',
    'Add an arrowed leader and associated multiline annotation text. Creates the DIMENSIONS ' +
      'layer if needed. If textPosition is omitted, the browser places the label diagonally ' +
      'away from the target to avoid covering it.',
    {
      targetPoint: z.object(Point2D).describe('Point the leader arrow identifies'),
      text: z.string().min(1).describe('Leader annotation text'),
      textPosition: z
        .object(Point2D)
        .optional()
        .describe('Annotation insertion point; omit for a non-overlapping default')
    }
  )

  const addMText = passthrough(
    bridge,
    'add_mtext',
    'Place multiline text at a drawing position. Height is in drawing units. Defaults to the ' +
      'DIMENSIONS layer, which is created automatically; a named layer is also created if needed.',
    {
      position: z.object(Point2D).describe('Top-left text insertion point'),
      text: z.string().min(1).describe('Multiline text content'),
      height: z.number().positive().optional().describe('Text height in drawing units; defaults to 2.5'),
      layer: z.string().optional().describe('Destination layer; defaults to DIMENSIONS')
    }
  )

  const drawHatch = passthrough(
    bridge,
    'draw_hatch',
    'Fill a closed polygon boundary with a hatch pattern, in drawing units.',
    {
      boundary: z.array(z.object(Point2D)).min(3).describe('Ordered vertices of the closed boundary'),
      pattern: z.string().default('SOLID').describe('Hatch pattern name, e.g. "SOLID", "ANSI31"'),
      layer: z.string().optional().describe('Destination layer name; defaults to the current layer')
    }
  )

  const createLayer = passthrough(
    bridge,
    'create_layer',
    'Create a new layer in the drawing.',
    {
      name: z.string().describe('New layer name'),
      colorCss: z.string().optional().describe('CSS color for the layer, e.g. "#ff0000"')
    }
  )

  const setCurrentLayer = passthrough(
    bridge,
    'set_current_layer',
    'Set the current (active) layer that new entities are drawn onto.',
    {
      name: z.string().describe('Layer name to make current (must already exist)')
    }
  )

  const zoomExtents = passthrough(
    bridge,
    'zoom_extents',
    'Zoom and pan the viewport to fit the entire drawing.',
    {}
  )

  const importBoundaryFromCsv = passthrough(
    bridge,
    'import_boundary_from_csv',
    'Import x,y CSV rows (optional x,y header; coordinates are drawing units) as one closed ' +
      'boundary polyline. The browser computes and returns its exact straight-edge area and ' +
      'perimeter. A duplicated final closing row is accepted. Defaults to the BOUNDARY layer.',
    {
      csvText: z.string().min(1).describe('CSV text containing x,y coordinate rows'),
      layer: z.string().optional().describe('Destination layer; defaults to BOUNDARY')
    }
  )

  const importBoundaryFromGeoJson = passthrough(
    bridge,
    'import_boundary_from_geojson',
    'Import GeoJSON Point, LineString, and Polygon features as CAD points and polylines. ' +
      'Polygon exterior and interior rings become separate closed polylines. Coordinates are ' +
      'used as-is: CRS reprojection is NOT performed, and that note is returned to the caller.',
    {
      geojsonText: z.string().min(1).describe('GeoJSON FeatureCollection, Feature, or geometry text'),
      layer: z.string().optional().describe('Destination layer; defaults to IMPORT')
    }
  )

  const checkInsideBoundary = passthrough(
    bridge,
    'check_inside_boundary',
    'Classify each entity as inside, outside, or intersecting a closed boundary polyline. ' +
      'This is the authoritative tool for siting questions; never eyeball containment. ' +
      'Arc-segmented polylines use their chord polygons and the result reports that degradation.',
    {
      entityIds: z.array(z.string()).min(1).describe('Entity ids to classify'),
      boundaryEntityId: z.string().describe('Id of the closed boundary polyline')
    }
  )

  const checkEntityOverlap = passthrough(
    bridge,
    'check_entity_overlap',
    'Return every overlapping pair among two or more point, line, polyline/polygon, circle, or ' +
      'EnvCAD symbol entities. Closed polylines and circles are treated as regions. ' +
      'Arc-segmented polylines use chords and the result reports that degradation.',
    {
      entityIds: z.array(z.string()).min(2).describe('Entity ids to check pairwise')
    }
  )

  const measureClearance = passthrough(
    bridge,
    'measure_clearance',
    'Compute the exact minimum distance and the closest point on each of two supported entities. ' +
      'When draw is true, add one dashed clearance line and one computed distance label on the ' +
      'CLEARANCE layer; the entire annotation is one Ctrl+Z undo step. Arc-segmented polylines ' +
      'use chord geometry and the result reports that degradation.',
    {
      fromEntityId: z.string().describe('First entity id'),
      toEntityId: z.string().describe('Second entity id'),
      draw: z.boolean().optional().describe('Draw the dashed annotation; defaults to false')
    }
  )

  const placeMonitoringPoints = passthrough(
    bridge,
    'place_monitoring_points',
    'Place labelled monitoring-well symbol blocks (circle, crosshair, and label) on the ' +
      'MONITORING layer. Missing labels are generated as prefix-1 through prefix-n. The whole ' +
      'call is one Ctrl+Z undo step.',
    {
      points: z
        .array(
          z.object({
            ...Point2D,
            label: z.string().min(1).optional().describe('Optional explicit point label')
          })
        )
        .min(1),
      prefix: z.string().min(1).optional().describe('Generated-label prefix; defaults to MW')
    }
  )

  const insertSymbol = passthrough(
    bridge,
    'insert_symbol',
    'Insert a reusable block from the EnvCAD environmental symbol library at the supplied ' +
      'drawing position. Rotation is counter-clockwise in degrees and scale is uniform.',
    {
      name: z.enum([
        'monitoring well',
        'storage tank',
        'generator',
        'drain arrow',
        'tree',
        'north arrow'
      ]),
      position: z.object(Point2D),
      rotationDeg: z.number().optional().describe('Counter-clockwise rotation; defaults to 0'),
      scale: z.number().positive().optional().describe('Uniform scale; defaults to 1')
    }
  )

  const getSheetSetup = passthrough(
    bridge,
    'get_sheet_setup',
    'Get the current sheet/page setup together with the exact ids you are allowed to pass to ' +
      'set_sheet_definition: every supported paper size id, and every title-block template with ' +
      'its id, description, supported papers, and the field keys it renders. Call this before ' +
      'setting a paper size, template, or title-block field so you use real ids instead of ' +
      'guessing them.',
    {}
  )

  const setSheetDefinition = passthrough(
    bridge,
    'set_sheet_definition',
    'Partially update the current sheet/page-setup definition. Only the fields provided are ' +
      'changed; omit a field to leave it unchanged. paper and templateId must be ids returned ' +
      'by get_sheet_setup. Sheet settings live outside the drawing database, so this change is ' +
      'NOT undoable with Ctrl+Z — say so when you report it.',
    {
      paper: z
        .string()
        .optional()
        .describe('Paper size id from get_sheet_setup, e.g. "A3", "LETTER"'),
      orientation: z.enum(['portrait', 'landscape']).optional(),
      scaleDenominator: z
        .number()
        .positive()
        .optional()
        .describe('Denominator of the drawing scale, e.g. 250 for 1:250'),
      templateId: z
        .string()
        .optional()
        .describe('Id of the title-block template, from get_sheet_setup'),
      fields: z
        .record(z.string(), z.string())
        .optional()
        .describe('Title-block field values keyed by the template field keys from get_sheet_setup')
    }
  )

  const setTitleBlockFields = passthrough(
    bridge,
    'set_title_block_fields',
    'Update one or more title-block field values (e.g. PROJECT, DRAWING_TITLE, CLIENT) without ' +
      'changing any other sheet settings. Keys must be field keys of the active template — see ' +
      'get_sheet_setup; any key the template does not define is stored but never rendered and ' +
      'comes back in ignoredFieldKeys. Not undoable with Ctrl+Z.',
    {
      fields: z
        .record(z.string(), z.string())
        .describe('Title-block field values, keyed by template field key')
    }
  )

  return createSdkMcpServer({
    name: 'cad',
    version: '1.0.0',
    tools: [
      getSelectedEntities,
      getDrawingContext,
      moveEntities,
      copyEntities,
      rotateEntities,
      scaleEntities,
      deleteEntities,
      setEntityLayer,
      changeText,
      calculateArea,
      calculateLength,
      drawLine,
      drawPolyline,
      drawRectangle,
      drawCircle,
      drawArc,
      drawText,
      addLinearDimension,
      addRadiusDimension,
      addLeader,
      addMText,
      drawHatch,
      createLayer,
      setCurrentLayer,
      zoomExtents,
      importBoundaryFromCsv,
      importBoundaryFromGeoJson,
      checkInsideBoundary,
      checkEntityOverlap,
      measureClearance,
      placeMonitoringPoints,
      insertSymbol,
      getSheetSetup,
      setSheetDefinition,
      setTitleBlockFields
    ]
  })
}
