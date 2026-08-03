import { reactive, watch } from 'vue'
import {
  markCadSessionSheetEdited,
  type CadDrawingUnit
} from '../cad/session'
import type { SheetDefinition } from './types'

const SHEET_STORAGE_VERSION = 1
const SHEET_STORAGE_PREFIX = `envcad.sheet.v${SHEET_STORAGE_VERSION}:`

interface PersistedSheetDefinition {
  version: typeof SHEET_STORAGE_VERSION
  sheet: SheetDefinition
}

let activeDocumentName: string | undefined
let persistenceSuspended = false

export function defaultSheet(
  databaseUnit: CadDrawingUnit = 'unknown'
): SheetDefinition {
  return {
    paper: 'A3',
    orientation: 'landscape',
    marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
    scaleDenominator: 200,
    drawingUnit: databaseUnit === 'mm' ? 'mm' : 'm',
    viewportCenter: 'extents'
  }
}

export const sheetStore = reactive<{
  current: SheetDefinition
  persistenceError?: string
}>({
  current: defaultSheet(),
  persistenceError: undefined
})

watch(
  () => sheetStore.current,
  (sheet) => {
    if (persistenceSuspended || !activeDocumentName) return
    markCadSessionSheetEdited()
    writePersistedSheet(activeDocumentName, sheet)
  },
  { deep: true, flush: 'sync' }
)

export async function activateSheetDocument(
  documentName: string,
  databaseUnit: CadDrawingUnit
): Promise<SheetDefinition> {
  const normalized = normalizedDocumentName(documentName)
  const persisted = await readPersistedSheet(normalized)
  activeDocumentName = normalized
  replaceCurrentSheet(persisted ?? defaultSheet(databaseUnit))
  return sheetStore.current
}

export function restoreSheetDocument(
  documentName: string,
  sheet: SheetDefinition
): void {
  activeDocumentName = normalizedDocumentName(documentName)
  replaceCurrentSheet(sheet)
}

export function deactivateSheetDocument(): void {
  activeDocumentName = undefined
  replaceCurrentSheet(defaultSheet())
}

export function replaceCurrentSheet(sheet: SheetDefinition): void {
  persistenceSuspended = true
  try {
    sheetStore.current = cloneSheet(sheet)
  } finally {
    persistenceSuspended = false
  }
  if (activeDocumentName) writePersistedSheet(activeDocumentName, sheetStore.current)
}

export function resetSheet(databaseUnit: CadDrawingUnit = 'unknown'): void {
  replaceCurrentSheet(defaultSheet(databaseUnit))
}

export function matchSheetToDatabaseUnit(
  databaseUnit: CadDrawingUnit
): boolean {
  if (databaseUnit !== 'm' && databaseUnit !== 'mm') return false
  sheetStore.current.drawingUnit = databaseUnit
  return true
}

export function sheetUnitMismatch(
  databaseUnit: CadDrawingUnit,
  sheetUnit = sheetStore.current.drawingUnit
): {
  mismatch: boolean
  factor?: number
  message?: string
} {
  if (databaseUnit !== 'm' && databaseUnit !== 'mm') {
    return {
      mismatch: false,
      message: 'The database unit is unknown; verify units before relying on sheet scale.'
    }
  }
  if (databaseUnit === sheetUnit) return { mismatch: false }
  const factor = databaseUnit === 'mm' && sheetUnit === 'm' ? 1000 : 0.001
  return {
    mismatch: true,
    factor,
    message:
      `Database units are ${databaseUnit}; Sheet Preview is configured as ${sheetUnit}. ` +
      `The interpretation differs by a factor of ${formatFactor(factor)}. ` +
      'Use Match database unit before previewing or exporting.'
  }
}

async function readPersistedSheet(
  documentName: string
): Promise<SheetDefinition | undefined> {
  const desktop = window.envcadDesktop
  if (
    desktop &&
    typeof desktop.getSheetPreference === 'function'
  ) {
    try {
      const sheet = await desktop.getSheetPreference(documentName)
      sheetStore.persistenceError = undefined
      return sheet
    } catch {
      sheetStore.persistenceError =
        'Sheet settings could not be loaded from the desktop profile; safe defaults are active.'
      return undefined
    }
  }
  return readBrowserSheet(documentName)
}

function readBrowserSheet(documentName: string): SheetDefinition | undefined {
  try {
    const raw = window.localStorage.getItem(storageKey(documentName))
    if (!raw) {
      sheetStore.persistenceError = undefined
      return undefined
    }
    const parsed = JSON.parse(raw) as Partial<PersistedSheetDefinition>
    if (
      parsed.version !== SHEET_STORAGE_VERSION ||
      !isSheetDefinition(parsed.sheet)
    ) {
      sheetStore.persistenceError =
        'Stored sheet settings were invalid; safe defaults are active.'
      return undefined
    }
    sheetStore.persistenceError = undefined
    return cloneSheet(parsed.sheet)
  } catch {
    sheetStore.persistenceError =
      'Sheet settings could not be loaded from browser storage; safe defaults are active.'
    return undefined
  }
}

function writePersistedSheet(
  documentName: string,
  sheet: SheetDefinition
): void {
  const desktop = window.envcadDesktop
  if (
    desktop &&
    typeof desktop.saveSheetPreference === 'function'
  ) {
    void desktop
      .saveSheetPreference(documentName, cloneSheet(sheet))
      .then(() => {
        sheetStore.persistenceError = undefined
      })
      .catch(() => {
        sheetStore.persistenceError =
          'Sheet settings could not be saved to the desktop profile.'
      })
    return
  }
  try {
    const payload: PersistedSheetDefinition = {
      version: SHEET_STORAGE_VERSION,
      sheet: cloneSheet(sheet)
    }
    window.localStorage.setItem(storageKey(documentName), JSON.stringify(payload))
    sheetStore.persistenceError = undefined
  } catch {
    sheetStore.persistenceError =
      'Sheet settings could not be saved to browser storage.'
  }
}

function storageKey(documentName: string): string {
  return `${SHEET_STORAGE_PREFIX}${documentName}`
}

function normalizedDocumentName(documentName: string): string {
  return documentName.trim().toLowerCase()
}

function cloneSheet(sheet: SheetDefinition): SheetDefinition {
  return JSON.parse(JSON.stringify(sheet)) as SheetDefinition
}

function isSheetDefinition(value: unknown): value is SheetDefinition {
  if (!value || typeof value !== 'object') return false
  const sheet = value as Partial<SheetDefinition>
  return (
    typeof sheet.paper === 'string' &&
    (sheet.orientation === 'portrait' || sheet.orientation === 'landscape') &&
    typeof sheet.scaleDenominator === 'number' &&
    Number.isFinite(sheet.scaleDenominator) &&
    sheet.scaleDenominator > 0 &&
    (sheet.drawingUnit === 'm' || sheet.drawingUnit === 'mm') &&
    !!sheet.marginsMm &&
    typeof sheet.marginsMm.top === 'number' &&
    typeof sheet.marginsMm.right === 'number' &&
    typeof sheet.marginsMm.bottom === 'number' &&
    typeof sheet.marginsMm.left === 'number' &&
    (sheet.viewportCenter === 'extents' ||
      (!!sheet.viewportCenter &&
        typeof sheet.viewportCenter === 'object' &&
        typeof sheet.viewportCenter.x === 'number' &&
        typeof sheet.viewportCenter.y === 'number'))
  )
}

function formatFactor(value: number): string {
  return value >= 1 ? value.toLocaleString('en-US') : String(value)
}
