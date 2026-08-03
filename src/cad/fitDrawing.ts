import {
  AcGeBox2d,
  AcGePoint2d,
  type AcDbEntity
} from '@mlightcad/data-model'
import {
  activeCadLayoutHasEntity,
  isEntityVisible,
  markCadSessionViewEdited,
  regenerateCadSession,
  recordCadFit,
  requireEditableCadSession,
  type CadExtentsSnapshot,
  type CadFitStatus
} from './session'

const EXTENT_ABSOLUTE_LIMIT = 1e12
const EXTENT_MIN_SPAN = 1e-9
const EXTENT_MAX_ASPECT_RATIO = 1e9
const VIEW_WAIT_MS = 10_000
const SCREEN_TOLERANCE_PX = 2
const MIN_MAJOR_AXIS_COVERAGE = 0.75
const VIEW_STABILITY_MS = 700
const VIEW_STABILITY_TIMEOUT_MS = 2_500
const VIEW_STABILITY_SAMPLE_MS = 50
const VIEW_STABILITY_TOLERANCE_PX = 1

export async function fitDrawingToScreen(): Promise<CadFitStatus> {
  const attemptedAt = Date.now()
  try {
    await regenerateCadSession()
    const { database, view } = requireEditableCadSession()
    const modelSpaceId = database.tables.blockTable.modelSpace.objectId
    const activeLayoutBtrId = (
      view as typeof view & { activeLayoutBtrId?: string }
    ).activeLayoutBtrId
    if (activeLayoutBtrId !== modelSpaceId) {
      throw new Error('Fit Drawing requires the active Model layout.')
    }
    if (view.width <= 0 || view.height <= 0) {
      throw new Error('Fit Drawing requires a positive-size model viewport.')
    }

    const entities = Array.from(
      database.tables.blockTable.modelSpace.newIterator()
    ) as AcDbEntity[]
    const visible = entities.filter(
      (entity) =>
        isEntityVisible(database, entity) &&
        !entity.geometricExtents.isEmpty()
    )
    if (visible.length === 0) {
      throw new Error('Fit Drawing is unavailable because the drawing has no visible geometry.')
    }
    const extents = validateExtents(combineExtents(visible))

    await waitFor(
      () =>
        view.width > 0 &&
        view.height > 0 &&
        visible.every((entity) =>
          activeCadLayoutHasEntity(view, entity.objectId)
        ),
      VIEW_WAIT_MS,
      'Regeneration did not attach all visible entities to the Model view.'
    )

    view.markLayoutAsInitialized(modelSpaceId)
    view.zoomTo(
      new AcGeBox2d(
        new AcGePoint2d(extents.minX, extents.minY),
        new AcGePoint2d(extents.maxX, extents.maxY)
      ),
      1.1
    )
    await assertStableExtentsFit(view, extents)
    const completeExtentsFit = true

    const result: CadFitStatus = {
      attemptedAt,
      completeExtentsFit,
      extents,
      entityCount: visible.length,
      activeLayout: 'Model',
      viewportWidth: view.width,
      viewportHeight: view.height,
      regenerationCompleted: true
    }
    recordCadFit(result)
    markCadSessionViewEdited()
    return result
  } catch (error) {
    const result: CadFitStatus = {
      attemptedAt,
      completeExtentsFit: false,
      entityCount: 0,
      viewportWidth: 0,
      viewportHeight: 0,
      regenerationCompleted: false,
      error: error instanceof Error ? error.message : String(error)
    }
    recordCadFit(result)
    throw error
  }
}

function combineExtents(entities: AcDbEntity[]): CadExtentsSnapshot {
  const first = entities[0].geometricExtents
  const result: CadExtentsSnapshot = {
    minX: first.min.x,
    minY: first.min.y,
    maxX: first.max.x,
    maxY: first.max.y
  }
  for (const entity of entities.slice(1)) {
    const extents = entity.geometricExtents
    result.minX = Math.min(result.minX, extents.min.x)
    result.minY = Math.min(result.minY, extents.min.y)
    result.maxX = Math.max(result.maxX, extents.max.x)
    result.maxY = Math.max(result.maxY, extents.max.y)
  }
  return result
}

function validateExtents(extents: CadExtentsSnapshot): CadExtentsSnapshot {
  const values = [extents.minX, extents.minY, extents.maxX, extents.maxY]
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error('Fit Drawing rejected non-finite drawing extents.')
  }
  if (values.some((value) => Math.abs(value) > EXTENT_ABSOLUTE_LIMIT)) {
    throw new Error('Fit Drawing rejected absurd drawing coordinates.')
  }
  const width = extents.maxX - extents.minX
  const height = extents.maxY - extents.minY
  if (width <= EXTENT_MIN_SPAN || height <= EXTENT_MIN_SPAN) {
    throw new Error('Fit Drawing requires non-degenerate two-dimensional extents.')
  }
  const ratio = Math.max(width / height, height / width)
  if (!Number.isFinite(ratio) || ratio > EXTENT_MAX_ASPECT_RATIO) {
    throw new Error('Fit Drawing rejected an absurd drawing aspect ratio.')
  }
  return extents
}

interface ProjectionAssessment {
  complete: boolean
  corners: Array<{ x: number; y: number }>
}

export interface CurrentCadFitVerification {
  complete: boolean
  extents?: CadExtentsSnapshot
  viewportWidth: number
  viewportHeight: number
  error?: string
}

/**
 * Verifies the current camera against the current visible Model geometry.
 * Unlike `lastFit`, this is not historical: panning, zooming, resizing, layer
 * changes, or edits are reflected every time the status is requested.
 */
export function verifyCurrentCadExtentsFit(): CurrentCadFitVerification {
  try {
    const { database, view } = requireEditableCadSession()
    const modelSpaceId = database.tables.blockTable.modelSpace.objectId
    const activeLayoutBtrId = (
      view as typeof view & { activeLayoutBtrId?: string }
    ).activeLayoutBtrId
    if (activeLayoutBtrId !== modelSpaceId) {
      throw new Error('The current view is not the Model layout.')
    }
    if (view.width <= 0 || view.height <= 0) {
      throw new Error('The current model viewport has no drawable area.')
    }
    const entities = Array.from(
      database.tables.blockTable.modelSpace.newIterator()
    ) as AcDbEntity[]
    const visible = entities.filter(
      (entity) =>
        isEntityVisible(database, entity) &&
        !entity.geometricExtents.isEmpty()
    )
    if (visible.length === 0) {
      throw new Error('The drawing has no visible geometry to verify.')
    }
    if (
      visible.some(
        (entity) => !activeCadLayoutHasEntity(view, entity.objectId)
      )
    ) {
      throw new Error('Not every visible entity is attached to the Model view.')
    }
    const extents = validateExtents(combineExtents(visible))
    return {
      complete: assessExtentsProjection(
        view,
        extents,
        view.width,
        view.height
      ).complete,
      extents,
      viewportWidth: view.width,
      viewportHeight: view.height
    }
  } catch (error) {
    return {
      complete: false,
      viewportWidth: 0,
      viewportHeight: 0,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function assessExtentsProjection(
  view: {
    worldToScreen(point: { x: number; y: number }): { x: number; y: number }
  },
  extents: CadExtentsSnapshot,
  width: number,
  height: number
): ProjectionAssessment {
  const corners = [
    { x: extents.minX, y: extents.minY },
    { x: extents.minX, y: extents.maxY },
    { x: extents.maxX, y: extents.minY },
    { x: extents.maxX, y: extents.maxY }
  ].map((point) => view.worldToScreen(point))
  const contained = corners.every(
    (point) =>
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      point.x >= -SCREEN_TOLERANCE_PX &&
      point.x <= width + SCREEN_TOLERANCE_PX &&
      point.y >= -SCREEN_TOLERANCE_PX &&
      point.y <= height + SCREEN_TOLERANCE_PX
  )
  const projectedWidth =
    Math.max(...corners.map((point) => point.x)) -
    Math.min(...corners.map((point) => point.x))
  const projectedHeight =
    Math.max(...corners.map((point) => point.y)) -
    Math.min(...corners.map((point) => point.y))
  const majorAxisCoverage = Math.max(
    projectedWidth / Math.max(width, 1),
    projectedHeight / Math.max(height, 1)
  )
  return {
    complete:
      contained &&
      Number.isFinite(majorAxisCoverage) &&
      majorAxisCoverage >= MIN_MAJOR_AXIS_COVERAGE,
    corners
  }
}

async function assertStableExtentsFit(
  view: {
    width: number
    height: number
    worldToScreen(point: { x: number; y: number }): { x: number; y: number }
  },
  extents: CadExtentsSnapshot
): Promise<void> {
  const deadline = performance.now() + VIEW_STABILITY_TIMEOUT_MS
  let previous: ProjectionAssessment | undefined
  let stableSince: number | undefined
  while (performance.now() < deadline) {
    await projectionSample()
    const sampledAt = performance.now()
    const current = assessExtentsProjection(
      view,
      extents,
      view.width,
      view.height
    )
    if (!current.complete) {
      throw new Error(
        'The fitted camera does not stably contain and frame the complete drawing extents.'
      )
    }
    if (previous) {
      const maxDelta = Math.max(
        ...current.corners.flatMap((point, index) => [
          Math.abs(point.x - previous!.corners[index].x),
          Math.abs(point.y - previous!.corners[index].y)
        ])
      )
      stableSince =
        maxDelta <= VIEW_STABILITY_TOLERANCE_PX
          ? stableSince ?? sampledAt
          : undefined
      if (
        stableSince !== undefined &&
        sampledAt - stableSince >= VIEW_STABILITY_MS
      ) {
        return
      }
    }
    previous = current
  }
  throw new Error('The fitted camera did not settle to a stable viewport.')
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

async function projectionSample(): Promise<void> {
  await new Promise<void>((resolve) =>
    setTimeout(resolve, VIEW_STABILITY_SAMPLE_MS)
  )
}
