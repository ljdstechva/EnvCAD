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
      'Always call this before acting on "this/these/selected" — never guess entity ids. ' +
      'Returns an empty selection if the user did not have anything selected when they sent ' +
      'their message.',
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
    'Rotate one or more entities by an angle in degrees, about an optional center point ' +
      '(defaults to each entity\'s own origin/base point if omitted).',
    {
      entityIds: z.array(z.string()).min(1).describe('Ids of the entities to rotate'),
      angleDeg: z.number().describe('Rotation angle in degrees, counter-clockwise positive'),
      center: z.object(Point2D).optional().describe('Center of rotation, in drawing units')
    }
  )

  const scaleEntities = passthrough(
    bridge,
    'scale_entities',
    'Scale one or more entities by a factor, about an optional center point (defaults to each ' +
      "entity's own origin/base point if omitted).",
    {
      entityIds: z.array(z.string()).min(1).describe('Ids of the entities to scale'),
      factor: z.number().describe('Scale factor, e.g. 2 doubles size, 0.5 halves it'),
      center: z.object(Point2D).optional().describe('Center of scaling, in drawing units')
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
    'Move one or more entities to a different layer.',
    {
      entityIds: z.array(z.string()).min(1).describe('Ids of the entities to re-layer'),
      layerName: z.string().describe('Name of the destination layer (must already exist)')
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
    'Compute the enclosed area of one or more closed entities (e.g. closed polylines, circles, ' +
      'hatches), in drawing units squared. Always use this instead of estimating an area yourself.',
    {
      entityIds: z.array(z.string()).min(1).describe('Ids of the entities to measure')
    }
  )

  const calculateLength = passthrough(
    bridge,
    'calculate_length',
    'Compute the total length of one or more entities (lines, polylines, arcs, circles\' ' +
      'circumference), in drawing units. Always use this instead of estimating a length yourself.',
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

  const setSheetDefinition = passthrough(
    bridge,
    'set_sheet_definition',
    'Partially update the current sheet/page-setup definition. Only the fields provided are ' +
      'changed; omit a field to leave it unchanged.',
    {
      paper: z.string().optional().describe('Paper size id, e.g. "A3", "LETTER"'),
      orientation: z.enum(['portrait', 'landscape']).optional(),
      scaleDenominator: z.number().positive().optional().describe('Denominator of the drawing scale, e.g. 200 for 1:200'),
      templateId: z.string().optional().describe('Id of the title-block template to use'),
      fields: z.record(z.string(), z.string()).optional().describe('Title-block field values, by field name')
    }
  )

  const setTitleBlockFields = passthrough(
    bridge,
    'set_title_block_fields',
    'Update one or more title-block field values (e.g. project name, drawn-by, date) without ' +
      'changing any other sheet settings.',
    {
      fields: z.record(z.string(), z.string()).describe('Title-block field values, by field name')
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
      drawHatch,
      createLayer,
      setCurrentLayer,
      zoomExtents,
      setSheetDefinition,
      setTitleBlockFields
    ]
  })
}
