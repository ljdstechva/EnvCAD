import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  PaperSizeId,
  SheetDefinition
} from '../src/sheet/types'

export const SHEET_PREFERENCES_SCHEMA_VERSION = 1
const MAX_DOCUMENTS = 200
const MAX_DOCUMENT_NAME_LENGTH = 260
const MAX_TEMPLATE_ID_LENGTH = 200
const MAX_FIELD_COUNT = 100
const MAX_FIELD_KEY_LENGTH = 100
const MAX_FIELD_VALUE_LENGTH = 4_000
const PAPER_SIZES = new Set<PaperSizeId>([
  'A4',
  'A3',
  'A2',
  'A1',
  'A0',
  'LETTER',
  'ANSI_B',
  'ANSI_C',
  'ANSI_D'
])

interface SheetPreferencesFile {
  schemaVersion: typeof SHEET_PREFERENCES_SCHEMA_VERSION
  sheets: Record<string, SheetDefinition>
}

export interface SheetPreferencesLogger {
  warn(message: string): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteBounded(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  )
}

export function normalizeSheetDocumentName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_DOCUMENT_NAME_LENGTH ||
    /[\u0000-\u001f]/.test(value)
  ) {
    throw new Error('Sheet document name is invalid.')
  }
  return value.trim().toLowerCase()
}

export function parseSheetDefinition(value: unknown): SheetDefinition {
  if (!isRecord(value)) throw new Error('Sheet definition must be an object.')
  const allowedKeys = new Set([
    'paper',
    'orientation',
    'marginsMm',
    'scaleDenominator',
    'drawingUnit',
    'viewportCenter',
    'templateId',
    'fields',
    'northRotationDeg'
  ])
  if (!Object.keys(value).every((key) => allowedKeys.has(key))) {
    throw new Error('Sheet definition contains unknown properties.')
  }
  if (!PAPER_SIZES.has(value.paper as PaperSizeId)) {
    throw new Error('Sheet paper size is invalid.')
  }
  if (value.orientation !== 'portrait' && value.orientation !== 'landscape') {
    throw new Error('Sheet orientation is invalid.')
  }
  const margins = value.marginsMm
  if (!isRecord(margins)) throw new Error('Sheet margins are invalid.')
  const marginKeys = ['top', 'right', 'bottom', 'left'] as const
  if (
    !Object.keys(margins).every((key) =>
      marginKeys.includes(key as typeof marginKeys[number])
    ) ||
    !isFiniteBounded(margins.top, 0, 100_000) ||
    !isFiniteBounded(margins.right, 0, 100_000) ||
    !isFiniteBounded(margins.bottom, 0, 100_000) ||
    !isFiniteBounded(margins.left, 0, 100_000)
  ) {
    throw new Error('Sheet margins are invalid.')
  }
  if (!isFiniteBounded(value.scaleDenominator, 1, 1e9)) {
    throw new Error('Sheet scale is invalid.')
  }
  if (value.drawingUnit !== 'm' && value.drawingUnit !== 'mm') {
    throw new Error('Sheet drawing unit is invalid.')
  }
  let viewportCenter: SheetDefinition['viewportCenter']
  if (value.viewportCenter === 'extents') viewportCenter = 'extents'
  else if (
    isRecord(value.viewportCenter) &&
    Object.keys(value.viewportCenter).every((key) => key === 'x' || key === 'y') &&
    isFiniteBounded(value.viewportCenter.x, -1e12, 1e12) &&
    isFiniteBounded(value.viewportCenter.y, -1e12, 1e12)
  ) {
    viewportCenter = {
      x: value.viewportCenter.x,
      y: value.viewportCenter.y
    }
  } else {
    throw new Error('Sheet viewport center is invalid.')
  }
  if (
    value.templateId !== undefined &&
    (typeof value.templateId !== 'string' ||
      value.templateId.length === 0 ||
      value.templateId.length > MAX_TEMPLATE_ID_LENGTH)
  ) {
    throw new Error('Sheet template ID is invalid.')
  }
  let fields: Record<string, string> | undefined
  if (value.fields !== undefined) {
    if (
      !isRecord(value.fields) ||
      Object.keys(value.fields).length > MAX_FIELD_COUNT
    ) {
      throw new Error('Sheet title-block fields are invalid.')
    }
    fields = {}
    for (const [key, fieldValue] of Object.entries(value.fields)) {
      if (
        key.length === 0 ||
        key.length > MAX_FIELD_KEY_LENGTH ||
        typeof fieldValue !== 'string' ||
        fieldValue.length > MAX_FIELD_VALUE_LENGTH
      ) {
        throw new Error('Sheet title-block fields are invalid.')
      }
      fields[key] = fieldValue
    }
  }
  if (
    value.northRotationDeg !== undefined &&
    !isFiniteBounded(value.northRotationDeg, -360_000, 360_000)
  ) {
    throw new Error('Sheet north rotation is invalid.')
  }
  return {
    paper: value.paper as PaperSizeId,
    orientation: value.orientation,
    marginsMm: {
      top: margins.top,
      right: margins.right,
      bottom: margins.bottom,
      left: margins.left
    },
    scaleDenominator: value.scaleDenominator,
    drawingUnit: value.drawingUnit,
    viewportCenter,
    ...(value.templateId ? { templateId: value.templateId } : {}),
    ...(fields ? { fields } : {}),
    ...(value.northRotationDeg !== undefined
      ? { northRotationDeg: value.northRotationDeg }
      : {})
  }
}

function emptyPreferences(): SheetPreferencesFile {
  return {
    schemaVersion: SHEET_PREFERENCES_SCHEMA_VERSION,
    sheets: {}
  }
}

function parsePreferencesFile(value: unknown): SheetPreferencesFile {
  if (
    !isRecord(value) ||
    !Object.keys(value).every(
      (key) => key === 'schemaVersion' || key === 'sheets'
    ) ||
    value.schemaVersion !== SHEET_PREFERENCES_SCHEMA_VERSION ||
    !isRecord(value.sheets) ||
    Object.keys(value.sheets).length > MAX_DOCUMENTS
  ) {
    throw new Error('Sheet preferences file is invalid.')
  }
  const sheets: Record<string, SheetDefinition> = {}
  for (const [documentName, sheet] of Object.entries(value.sheets)) {
    const normalized = normalizeSheetDocumentName(documentName)
    if (normalized !== documentName) {
      throw new Error('Sheet preference document names must be normalized.')
    }
    sheets[normalized] = parseSheetDefinition(sheet)
  }
  return {
    schemaVersion: SHEET_PREFERENCES_SCHEMA_VERSION,
    sheets
  }
}

export class SheetPreferencesStore {
  private pending: Promise<void> = Promise.resolve()

  constructor(
    readonly filePath: string,
    private readonly logger: SheetPreferencesLogger = console
  ) {}

  async load(documentName: unknown): Promise<SheetDefinition | undefined> {
    const normalized = normalizeSheetDocumentName(documentName)
    await this.pending
    const preferences = await this.readSafe()
    const sheet = preferences.sheets[normalized]
    return sheet ? structuredClone(sheet) : undefined
  }

  async save(
    documentName: unknown,
    value: unknown
  ): Promise<SheetDefinition> {
    const normalized = normalizeSheetDocumentName(documentName)
    const sheet = parseSheetDefinition(value)
    let saved!: SheetDefinition
    const operation = this.pending.then(async () => {
      const preferences = await this.readSafe()
      if (
        !(normalized in preferences.sheets) &&
        Object.keys(preferences.sheets).length >= MAX_DOCUMENTS
      ) {
        throw new Error('The maximum number of persisted sheet documents was reached.')
      }
      preferences.sheets[normalized] = sheet
      await this.write(preferences)
      saved = structuredClone(sheet)
    })
    this.pending = operation.catch(() => {})
    await operation
    return saved
  }

  private async readSafe(): Promise<SheetPreferencesFile> {
    try {
      return parsePreferencesFile(
        JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      )
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code)
          : ''
      if (code !== 'ENOENT') {
        this.logger.warn(
          'Sheet preferences were invalid and safe per-document defaults were restored.'
        )
      }
      return emptyPreferences()
    }
  }

  private async write(preferences: SheetPreferencesFile): Promise<void> {
    const directory = path.dirname(this.filePath)
    await mkdir(directory, { recursive: true })
    const temporaryPath = path.join(
      directory,
      `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`
    )
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(preferences, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' }
      )
      await rename(temporaryPath, this.filePath)
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {})
    }
  }
}
