import { reactive } from 'vue'
import type { SheetDefinition } from './types'

function defaultSheet(): SheetDefinition {
  return {
    paper: 'A3',
    orientation: 'landscape',
    marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
    scaleDenominator: 200,
    drawingUnit: 'm',
    viewportCenter: 'extents'
  }
}

export const sheetStore = reactive<{ current: SheetDefinition }>({
  current: defaultSheet()
})

export function resetSheet() {
  sheetStore.current = defaultSheet()
}
