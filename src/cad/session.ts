import { reactive, readonly } from 'vue'
import { AcApDocManager } from '@mlightcad/cad-simple-viewer'
import {
  AcDbLayout,
  AcDbUnitsValue,
  acdbHostApplicationServices,
  type AcDbDatabase,
  type AcDbEntity
} from '@mlightcad/data-model'

export type CadSessionStatus =
  | 'no-document'
  | 'opening'
  | 'active'
  | 'failed'
  | 'closing'

export type CadDrawingUnit = 'm' | 'mm' | 'unknown'

export interface CadExtentsSnapshot {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface CadRegenerationStatus {
  attemptedAt: number
  completed: boolean
  completedAt?: number
  error?: string
}

export interface CadFitStatus {
  attemptedAt: number
  completeExtentsFit: boolean
  extents?: CadExtentsSnapshot
  entityCount: number
  activeLayout?: string
  viewportWidth: number
  viewportHeight: number
  regenerationCompleted: boolean
  error?: string
}

export interface SheetPreviewStatus {
  status: 'unavailable' | 'rendering' | 'ready' | 'warning' | 'error'
  entityCount: number
  visibleEntityCount: number
  drawableElementCount: number
  warnings: string[]
  unitMismatch: boolean
  clipping: boolean
  updatedAt: number
  error?: string
}

export interface CadSessionState {
  status: CadSessionStatus
  documentName?: string
  editable: boolean
  viewReady: boolean
  activeLayout?: string
  entityCount: number
  visibleEntityCount: number
  renderableGeometryCount: number
  renderedEntityCount: number
  databaseUnit: CadDrawingUnit
  databaseUnitName: string
  drawingExtents?: CadExtentsSnapshot
  dirty: boolean
  error?: string
  lastRegeneration?: CadRegenerationStatus
  lastFit?: CadFitStatus
  sheetPreview: SheetPreviewStatus
}

interface CadSessionHooks {
  markDirty(): void
  refreshUi(): void
}

interface ActiveCadSession {
  manager: AcApDocManager
  database: AcDbDatabase
  view: AcApDocManager['curView']
}

const EMPTY_PREVIEW: SheetPreviewStatus = {
  status: 'unavailable',
  entityCount: 0,
  visibleEntityCount: 0,
  drawableElementCount: 0,
  warnings: [],
  unitMismatch: false,
  clipping: false,
  updatedAt: 0
}

const mutableState = reactive<CadSessionState>({
  status: 'no-document',
  editable: false,
  viewReady: false,
  entityCount: 0,
  visibleEntityCount: 0,
  renderableGeometryCount: 0,
  renderedEntityCount: 0,
  databaseUnit: 'unknown',
  databaseUnitName: 'Unknown',
  dirty: false,
  sheetPreview: { ...EMPTY_PREVIEW }
})

export const cadSessionState = readonly(mutableState)

let manager: AcApDocManager | null = null
let container: HTMLElement | null = null
let hooks: CadSessionHooks | null = null
let pendingRegenerationCheck: Promise<void> = Promise.resolve()

export function bindCadSession(
  nextManager: AcApDocManager,
  nextContainer: HTMLElement,
  nextHooks: CadSessionHooks
): void {
  manager = nextManager
  container = nextContainer
  hooks = nextHooks
  setNoCadDocument()
}

export function setNoCadDocument(): void {
  Object.assign(mutableState, {
    status: 'no-document' satisfies CadSessionStatus,
    documentName: undefined,
    editable: false,
    viewReady: false,
    activeLayout: undefined,
    entityCount: 0,
    visibleEntityCount: 0,
    renderableGeometryCount: 0,
    renderedEntityCount: 0,
    databaseUnit: 'unknown' satisfies CadDrawingUnit,
    databaseUnitName: 'Unknown',
    drawingExtents: undefined,
    dirty: false,
    error: undefined,
    lastRegeneration: undefined,
    lastFit: undefined,
    sheetPreview: { ...EMPTY_PREVIEW }
  })
}

export function beginCadDocumentReplacement(): void {
  Object.assign(mutableState, {
    status: 'closing' satisfies CadSessionStatus,
    editable: false,
    viewReady: false,
    activeLayout: undefined,
    entityCount: 0,
    visibleEntityCount: 0,
    renderableGeometryCount: 0,
    renderedEntityCount: 0,
    drawingExtents: undefined
  })
}

export function beginCadDocumentOpen(documentName: string): void {
  Object.assign(mutableState, {
    status: 'opening' satisfies CadSessionStatus,
    documentName,
    editable: false,
    viewReady: false,
    activeLayout: undefined,
    entityCount: 0,
    visibleEntityCount: 0,
    renderableGeometryCount: 0,
    renderedEntityCount: 0,
    databaseUnit: 'unknown' satisfies CadDrawingUnit,
    databaseUnitName: 'Unknown',
    drawingExtents: undefined,
    error: undefined,
    lastRegeneration: undefined,
    lastFit: undefined,
    sheetPreview: { ...EMPTY_PREVIEW }
  })
}

export function failCadDocumentOpen(documentName: string, error: string): void {
  Object.assign(mutableState, {
    status: 'failed' satisfies CadSessionStatus,
    documentName,
    editable: false,
    viewReady: false,
    activeLayout: undefined,
    entityCount: 0,
    visibleEntityCount: 0,
    renderableGeometryCount: 0,
    renderedEntityCount: 0,
    databaseUnit: 'unknown' satisfies CadDrawingUnit,
    databaseUnitName: 'Unknown',
    drawingExtents: undefined,
    dirty: false,
    error,
    lastRegeneration: undefined,
    lastFit: undefined,
    sheetPreview: { ...EMPTY_PREVIEW }
  })
}

export async function activateCadDocument(
  documentName: string,
  dirty: boolean
): Promise<void> {
  if (!manager || !container) {
    throw new Error('The CAD document manager is not initialized.')
  }

  const database = manager.curDocument.database
  const modelSpaceId = database.tables.blockTable.modelSpace.objectId
  const modelLayout = prepareCadDocumentView(manager)

  acdbHostApplicationServices().layoutManager.setCurrentLayoutBtrId(
    modelSpaceId,
    database
  )
  manager.setActiveLayout()

  await waitFor(
    () =>
      container !== null &&
      container.clientWidth > 0 &&
      container.clientHeight > 0 &&
      activeLayoutBtrId(manager!.curView) === modelSpaceId &&
      visibleModelEntities(database).every((entity) =>
        activeCadLayoutHasEntity(manager!.curView, entity.objectId)
      ),
    10_000,
    'The Model layout and its visible entities did not attach to a positive-size viewport.'
  )

  const unitName =
    AcDbUnitsValue[database.insunits as AcDbUnitsValue] ?? 'Unknown'
  Object.assign(mutableState, {
    status: 'active' satisfies CadSessionStatus,
    documentName,
    editable: true,
    viewReady: true,
    activeLayout: modelLayout.layoutName || 'Model',
    databaseUnit: normalizeDrawingUnit(unitName),
    databaseUnitName: unitName,
    dirty,
    error: undefined,
    lastRegeneration: {
      attemptedAt: Date.now(),
      completed: true,
      completedAt: Date.now()
    }
  })
  refreshCadSessionMetrics()
  hooks?.refreshUi()
}

/**
 * Attaches scene layouts synchronously during the viewer library's
 * `documentActivated` event. The library calls `setActiveLayout()` immediately
 * after that event and throws for minimal DXFs that omit a Model LAYOUT object,
 * so waiting until `openDocument()` resolves is too late.
 *
 * This function prepares view objects only. It deliberately does not mark the
 * EnvCAD session active; `activateCadDocument()` remains the sole activation
 * gate after the open/new operation has completed.
 */
export function prepareCadDocumentView(
  activeManager: AcApDocManager
): AcDbLayout {
  const database = activeManager.curDocument.database
  const modelSpaceId = database.tables.blockTable.modelSpace.objectId
  let modelLayout: AcDbLayout | undefined
  let currentLayoutAttached = false

  for (const layout of database.objects.layout.newIterator()) {
    activeManager.curView.addLayout(layout)
    if (layout.blockTableRecordId === modelSpaceId) modelLayout = layout
    if (layout.blockTableRecordId === database.currentSpaceId) {
      currentLayoutAttached = true
    }
  }

  if (!currentLayoutAttached) {
    const currentLayout = new AcDbLayout()
    currentLayout.layoutName =
      database.currentSpaceId === modelSpaceId ? 'Model' : 'Active Layout'
    currentLayout.blockTableRecordId = database.currentSpaceId
    activeManager.curView.addLayout(currentLayout)
    if (database.currentSpaceId === modelSpaceId) modelLayout = currentLayout
  }

  if (!modelLayout) {
    modelLayout = new AcDbLayout()
    modelLayout.layoutName = 'Model'
    modelLayout.blockTableRecordId = modelSpaceId
    activeManager.curView.addLayout(modelLayout)
  }
  return modelLayout
}

export function requireEditableCadSession(): ActiveCadSession {
  if (
    !manager ||
    mutableState.status !== 'active' ||
    !mutableState.editable ||
    !mutableState.viewReady
  ) {
    throw new Error(
      'No active editable drawing is open. Choose New Drawing or Open before using CAD tools.'
    )
  }
  const database = manager.curDocument.database
  const modelSpaceId = database.tables.blockTable.modelSpace.objectId
  if (activeLayoutBtrId(manager.curView) !== modelSpaceId) {
    throw new Error('The active drawing does not have an attached Model layout.')
  }
  return { manager, database, view: manager.curView }
}

export function markCadSessionDatabaseEdited(): void {
  requireEditableCadSession()
  mutableState.dirty = true
  hooks?.markDirty()
  hooks?.refreshUi()
  scheduleCadSessionRegeneration()
}

export function scheduleCadSessionRegeneration(): void {
  const active = requireEditableCadSession()
  const attemptedAt = Date.now()
  invalidateRenderedEvidence()
  mutableState.lastRegeneration = {
    attemptedAt,
    completed: false
  }
  pendingRegenerationCheck = nextPaint()
    .then(() => {
      const visible = visibleModelEntities(active.database)
      const missing = visible.filter(
        (entity) => !activeCadLayoutHasEntity(active.view, entity.objectId)
      )
      if (missing.length > 0) {
        throw new Error(
          `${missing.length} visible drawing entities are not attached to the active Model view.`
        )
      }
      if (mutableState.lastRegeneration?.attemptedAt === attemptedAt) {
        mutableState.lastRegeneration = {
          attemptedAt,
          completed: true,
          completedAt: Date.now()
        }
      }
      refreshCadSessionMetrics()
    })
    .catch((error: unknown) => {
      if (mutableState.lastRegeneration?.attemptedAt === attemptedAt) {
        mutableState.lastRegeneration = {
          attemptedAt,
          completed: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    })
}

export async function awaitCadSessionRegeneration(): Promise<
  CadRegenerationStatus | undefined
> {
  await pendingRegenerationCheck
  return mutableState.lastRegeneration
}

/**
 * Rebuilds the live Model scene in a deterministic order and awaits entity
 * attachment. `AcApDocManager.regen()` cannot be used here: it clears scene
 * layers and immediately starts database regeneration, whose entity events may
 * arrive before layer events and leave non-zero database entities unpainted.
 */
export async function regenerateCadSession(): Promise<CadRegenerationStatus> {
  const active = requireEditableCadSession()
  const attemptedAt = Date.now()
  invalidateRenderedEvidence()
  mutableState.lastRegeneration = { attemptedAt, completed: false }
  try {
    const modelSpaceId = active.database.tables.blockTable.modelSpace.objectId
    active.view.clear()
    for (const layer of active.database.tables.layerTable.newIterator()) {
      active.view.addLayer(layer)
    }
    prepareCadDocumentView(active.manager)
    active.view.activeLayoutBtrId = modelSpaceId
    active.view.modelSpaceBtrId = modelSpaceId
    active.view.markLayoutAsInitialized(modelSpaceId)
    await active.database.regen()

    const visible = visibleModelEntities(active.database)
    await waitFor(
      () =>
        visible.every((entity) =>
          activeCadLayoutHasEntity(active.view, entity.objectId)
        ),
      10_000,
      'Regeneration did not attach all visible entities to the active Model view.'
    )
    await nextPaint()
    const result: CadRegenerationStatus = {
      attemptedAt,
      completed: true,
      completedAt: Date.now()
    }
    mutableState.lastRegeneration = result
    refreshCadSessionMetrics()
    return result
  } catch (error) {
    const result: CadRegenerationStatus = {
      attemptedAt,
      completed: false,
      error: error instanceof Error ? error.message : String(error)
    }
    mutableState.lastRegeneration = result
    throw error
  }
}

export function setCadSessionDirty(dirty: boolean): void {
  mutableState.dirty = dirty
}

export function refreshCadSessionMetrics(): CadSessionState {
  if (!manager || mutableState.status !== 'active') return mutableState
  const database = manager.curDocument.database
  const entities = Array.from(
    database.tables.blockTable.modelSpace.newIterator()
  ) as AcDbEntity[]
  const visibleEntities = entities.filter((entity) =>
    isEntityVisible(database, entity)
  )
  const renderable = visibleEntities.filter(
    (entity) => !entity.geometricExtents.isEmpty()
  )
  mutableState.entityCount = entities.length
  mutableState.visibleEntityCount = visibleEntities.length
  mutableState.renderableGeometryCount = renderable.length
  mutableState.renderedEntityCount = renderable.filter((entity) =>
    activeCadLayoutHasEntity(manager!.curView, entity.objectId)
  ).length
  mutableState.drawingExtents = combineEntityExtents(renderable)
  return mutableState
}

export function activeCadLayoutHasEntity(
  view: AcApDocManager['curView'],
  objectId: string
): boolean {
  return view.cadScene.activeLayout?.hasEntity(objectId) ?? false
}

function visibleModelEntities(database: AcDbDatabase): AcDbEntity[] {
  return (
    Array.from(
      database.tables.blockTable.modelSpace.newIterator()
    ) as AcDbEntity[]
  ).filter((entity) => isEntityVisible(database, entity))
}

export function recordCadFit(result: CadFitStatus): void {
  mutableState.lastFit = { ...result }
  refreshCadSessionMetrics()
}

export function recordSheetPreview(
  preview: Omit<SheetPreviewStatus, 'updatedAt'>
): void {
  mutableState.sheetPreview = {
    ...preview,
    warnings: [...preview.warnings],
    updatedAt: Date.now()
  }
}

function invalidateRenderedEvidence(): void {
  mutableState.lastFit = undefined
  mutableState.sheetPreview = { ...EMPTY_PREVIEW }
}

export function getCadSessionSnapshot(): CadSessionState {
  refreshCadSessionMetrics()
  return JSON.parse(JSON.stringify(mutableState)) as CadSessionState
}

export function normalizeDrawingUnit(unitName: string): CadDrawingUnit {
  const normalized = unitName.trim().toLowerCase()
  if (normalized === 'meters' || normalized === 'meter' || normalized === 'm') {
    return 'm'
  }
  if (
    normalized === 'millimeters' ||
    normalized === 'millimeter' ||
    normalized === 'mm'
  ) {
    return 'mm'
  }
  return 'unknown'
}

export function isEntityVisible(
  database: AcDbDatabase,
  entity: AcDbEntity
): boolean {
  if (!entity.visibility) return false
  const layer = database.tables.layerTable.getAt(entity.layer)
  return !layer?.isOff && !layer?.isFrozen
}

function combineEntityExtents(
  entities: AcDbEntity[]
): CadExtentsSnapshot | undefined {
  let result: CadExtentsSnapshot | undefined
  for (const entity of entities) {
    const extents = entity.geometricExtents
    if (extents.isEmpty()) continue
    const values = [extents.min.x, extents.min.y, extents.max.x, extents.max.y]
    if (values.some((value) => !Number.isFinite(value))) continue
    result = result
      ? {
          minX: Math.min(result.minX, extents.min.x),
          minY: Math.min(result.minY, extents.min.y),
          maxX: Math.max(result.maxX, extents.max.x),
          maxY: Math.max(result.maxY, extents.max.y)
        }
      : {
          minX: extents.min.x,
          minY: extents.min.y,
          maxX: extents.max.x,
          maxY: extents.max.y
        }
  }
  return result
}

function activeLayoutBtrId(view: AcApDocManager['curView']): string | undefined {
  return (view as AcApDocManager['curView'] & { activeLayoutBtrId?: string })
    .activeLayoutBtrId
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  timeoutMessage: string
): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (predicate()) return
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve())
    )
  }
  throw new Error(timeoutMessage)
}

async function nextPaint(): Promise<void> {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => resolve())
    )
  )
}
