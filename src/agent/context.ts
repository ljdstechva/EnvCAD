import { AcDbUnitsValue } from '@mlightcad/data-model'
import {
  getCadSessionRevision,
  requireEditableCadSession
} from '../cad/session'
import { sheetStore } from '../sheet/sheetStore'
import type { SelectionSnapshot, SheetSnapshot } from './protocol'

/**
 * Captures the current selection at SEND time, so the agent operates on a
 * frozen snapshot rather than whatever is selected later. See
 * docs/agent-protocol.md "Selection snapshot semantics".
 */
export function captureSelectionSnapshot(): SelectionSnapshot {
  const revision = getCadSessionRevision()
  try {
    const manager = requireEditableCadSession().manager
    const ids = [...manager.curView.selectionSet.ids]
    const units = AcDbUnitsValue[manager.curDocument.database.insunits] ?? 'Unknown'
    return { ids, count: ids.length, units, revision }
  } catch {
    // No document/view created yet.
    return { ids: [], count: 0, units: 'Unknown', revision }
  }
}

export function captureSheetSnapshot(): SheetSnapshot {
  const current = sheetStore.current
  return {
    paper: current.paper,
    orientation: current.orientation,
    scaleDenominator: current.scaleDenominator,
    drawingUnit: current.drawingUnit,
    templateId: current.templateId,
    fields: current.fields
  }
}
