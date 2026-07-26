import { AcApDocManager, acapRunDatabaseEdit } from '@mlightcad/cad-simple-viewer'
import { AcDbLine, AcDbUnitsValue, AcGePoint3d } from '@mlightcad/data-model'
import { agentBridge, type ToolHandler } from './bridge'
import { CAD_TOOL_NAMES, type ToolResult } from './protocol'

function errorResult(err: unknown): ToolResult {
  return { error: err instanceof Error ? err.message : String(err) }
}

/** Real handler: reads units, layers, current layer, and extents from the AcDbDatabase. */
function getDrawingContext(): ToolResult {
  try {
    const manager = AcApDocManager.instance
    const db = manager.curDocument.database

    const layers: { name: string; colorCss: string; isOff: boolean }[] = []
    for (const layer of db.tables.layerTable.newIterator()) {
      layers.push({
        name: layer.name,
        colorCss: layer.color.cssColor ?? '#ffffff',
        isOff: layer.isOff
      })
    }

    const extents = db.extents
    return {
      data: {
        units: AcDbUnitsValue[db.insunits as AcDbUnitsValue] ?? 'Unknown',
        currentLayer: db.clayer,
        layers,
        extents: extents.isEmpty()
          ? null
          : {
              min: { x: extents.min.x, y: extents.min.y, z: extents.min.z },
              max: { x: extents.max.x, y: extents.max.y, z: extents.max.z }
            }
      }
    }
  } catch (err) {
    return errorResult(err)
  }
}

/** Real handler: zooms/pans the viewport to fit the whole drawing. */
function zoomExtents(): ToolResult {
  try {
    AcApDocManager.instance.curView.zoomToFitDrawing()
    return { data: { zoomed: true } }
  } catch (err) {
    return errorResult(err)
  }
}

interface DrawLineInput {
  start: { x: number; y: number }
  end: { x: number; y: number }
  layer?: string
}

/**
 * Real handler: draws a line through the viewer's transaction mechanism
 * (acapRunDatabaseEdit) so the new entity is one undoable step.
 */
function drawLine(rawInput: unknown): ToolResult {
  const { start, end, layer } = rawInput as DrawLineInput
  try {
    const manager = AcApDocManager.instance
    const db = manager.curDocument.database
    let entityId = ''
    acapRunDatabaseEdit(db, 'Agent: draw_line', () => {
      const line = new AcDbLine(new AcGePoint3d(start.x, start.y, 0), new AcGePoint3d(end.x, end.y, 0))
      if (layer) line.layer = layer
      db.tables.blockTable.modelSpace.appendEntity(line)
      entityId = line.objectId
    })
    return { data: { entityId, start, end, layer: layer ?? db.clayer } }
  } catch (err) {
    return errorResult(err)
  }
}

const REAL_HANDLERS: Record<string, ToolHandler> = {
  get_drawing_context: () => getDrawingContext(),
  zoom_extents: () => zoomExtents(),
  draw_line: (input) => drawLine(input)
}

/**
 * Registers a handler for every CAD tool name. get_drawing_context,
 * zoom_extents, and draw_line are real; every other tool is a stub that
 * reports {error:"not implemented yet"} — a follow-up session should
 * implement these one at a time following the pattern of the three real
 * handlers above.
 */
export function registerCadHandlers() {
  for (const name of CAD_TOOL_NAMES) {
    const handler = REAL_HANDLERS[name] ?? (() => ({ error: 'not implemented yet' }) as ToolResult)
    agentBridge.registerHandler(name, handler)
  }
}
