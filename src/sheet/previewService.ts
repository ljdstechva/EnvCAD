import { reactive, watch } from 'vue'
import {
  awaitCadSessionRegeneration,
  cadSessionState,
  getCadSessionRevision,
  recordSheetPreview,
  requireEditableCadSession
} from '../cad/session'
import {
  validateToolResultForTool,
  type ToolImagePayload,
  type ToolResult
} from '../agent/protocol'
import { sheetRenderer } from './renderSheet'
import {
  rasterizeSheetSvg,
  type SheetPreviewView
} from './rasterizeSheet'
import { sheetStore } from './sheetStore'
import {
  PAPER_SIZES,
  type SheetDefinition,
  type SheetRenderDiagnostics
} from './types'
import { captureWithRevisionRetry } from './captureRevision'

export interface SheetPreviewSnapshot {
  svg: string
  svgSha256: string
  warnings: string[]
  diagnostics: SheetRenderDiagnostics
  sheet: SheetDefinition
  pageWidthMm: number
  pageHeightMm: number
  renderedAt: string
  renderRevision: number
  documentRevision: number
  contentRevision: number
}

export interface SheetPreviewCaptureMetadata {
  entityIds: []
  kind: 'sheet-preview'
  view: SheetPreviewView
  paper: string
  orientation: 'portrait' | 'landscape'
  scale: string
  scaleDenominator: number
  drawingUnit: string
  databaseUnit: string
  warnings: string[]
  renderDiagnostics: SheetRenderDiagnostics
  page: {
    widthMm: number
    heightMm: number
    aspectRatio: number
  }
  image: {
    mimeType: ToolImagePayload['mimeType']
    width: number
    height: number
    byteLength: number
    sha256: string
    captureId: string
    usedWebpFallback: boolean
  }
  captureTime: string
  renderedAt: string
  svgSha256: string
  rasterSha256: string
  renderRevision: number
  documentRevision: number
  contentRevision: number
}

interface InternalSnapshot extends SheetPreviewSnapshot {
  document: unknown
  sourceKey: string
}

interface PreviewServiceState {
  svg: string
  svgSha256: string
  warnings: string[]
  rendering: boolean
  renderError: string | null
  diagnostics: SheetRenderDiagnostics | null
  renderRevision: number
}

class StaleSheetPreviewError extends Error {
  constructor() {
    super('The drawing or Sheet Preview changed during rendering.')
    this.name = 'StaleSheetPreviewError'
  }
}

class SheetPreviewService {
  readonly state = reactive<PreviewServiceState>({
    svg: '',
    svgSha256: '',
    warnings: [],
    rendering: false,
    renderError: null,
    diagnostics: null,
    renderRevision: 0
  })

  private cache: InternalSnapshot | undefined
  private pendingRender: Promise<InternalSnapshot> | undefined
  private nextRenderRevision = 0

  constructor() {
    watch(
      () => [cadSessionState.status, cadSessionState.documentName],
      () => {
        this.invalidate()
        if (
          cadSessionState.status !== 'active' ||
          !cadSessionState.editable ||
          !cadSessionState.viewReady
        ) {
          this.clearVisiblePreview()
        }
      }
    )
    watch(
      () => cadSessionState.lastRegeneration?.attemptedAt,
      () => this.invalidate()
    )
    watch(
      () => sheetStore.current,
      () => this.invalidate(),
      { deep: true }
    )
  }

  invalidate(): void {
    this.cache = undefined
  }

  clearVisiblePreview(): void {
    this.cache = undefined
    this.state.svg = ''
    this.state.svgSha256 = ''
    this.state.warnings = []
    this.state.renderError = null
    this.state.diagnostics = null
    this.state.renderRevision = 0
    recordSheetPreview({
      status: 'unavailable',
      entityCount: 0,
      visibleEntityCount: 0,
      drawableElementCount: 0,
      warnings: [],
      unitMismatch: false,
      clipping: false
    })
  }

  async render(force = false): Promise<SheetPreviewSnapshot> {
    if (this.pendingRender) {
      const pending = await this.pendingRender
      if (!force && this.sourceStillCurrent(pending)) return pending
    }

    const task = this.renderWithRetry(force)
    this.pendingRender = task
    try {
      return await task
    } finally {
      if (this.pendingRender === task) this.pendingRender = undefined
    }
  }

  async capture(view: SheetPreviewView): Promise<ToolResult> {
    const { preview, raster } = await captureWithRevisionRetry({
      render: (attempt) => this.render(attempt > 0),
      rasterize: (source) =>
        rasterizeSheetSvg({
          svg: source.svg,
          svgSha256: source.svgSha256,
          pageWidth: source.pageWidthMm,
          pageHeight: source.pageHeightMm,
          view,
          renderRevision: source.renderRevision
        }),
      isCurrent: (source) =>
        this.sourceStillCurrent(source as InternalSnapshot) &&
        this.cache?.renderRevision === source.renderRevision,
      onStale: () => this.invalidate()
    })

    const captureTime = new Date().toISOString()
    const metadata: SheetPreviewCaptureMetadata = {
      entityIds: [],
      kind: 'sheet-preview',
      view,
      paper: preview.sheet.paper,
      orientation: preview.sheet.orientation,
      scale: `1:${preview.sheet.scaleDenominator}`,
      scaleDenominator: preview.sheet.scaleDenominator,
      drawingUnit: preview.sheet.drawingUnit,
      databaseUnit: preview.diagnostics.databaseUnit,
      warnings: [...preview.warnings],
      renderDiagnostics: clone(preview.diagnostics),
      page: {
        widthMm: preview.pageWidthMm,
        heightMm: preview.pageHeightMm,
        aspectRatio: preview.pageWidthMm / preview.pageHeightMm
      },
      image: {
        mimeType: raster.image.mimeType,
        width: raster.image.width,
        height: raster.image.height,
        byteLength: raster.image.byteLength,
        sha256: raster.image.sha256,
        captureId: raster.image.captureId,
        usedWebpFallback: raster.usedWebpFallback
      },
      captureTime,
      renderedAt: preview.renderedAt,
      svgSha256: preview.svgSha256,
      rasterSha256: raster.image.sha256,
      renderRevision: preview.renderRevision,
      documentRevision: preview.documentRevision,
      contentRevision: preview.contentRevision
    }
    const result: ToolResult = { data: metadata, image: raster.image }
    const validation = validateToolResultForTool(
      'inspect_sheet_preview',
      result
    )
    if (!validation.ok) {
      throw new Error(`Sheet Preview result validation failed: ${validation.error}`)
    }
    return result
  }

  private async renderWithRetry(force: boolean): Promise<InternalSnapshot> {
    this.state.renderError = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.renderOnce(force || attempt > 0)
      } catch (error) {
        if (error instanceof StaleSheetPreviewError && attempt === 0) {
          this.invalidate()
          continue
        }
        const message = error instanceof Error ? error.message : String(error)
        this.state.renderError = message
        this.state.diagnostics = null
        recordSheetPreview({
          status: 'error',
          entityCount: cadSessionState.entityCount,
          visibleEntityCount: cadSessionState.visibleEntityCount,
          drawableElementCount: 0,
          warnings: [],
          unitMismatch:
            cadSessionState.databaseUnit !== 'unknown' &&
            cadSessionState.databaseUnit !== sheetStore.current.drawingUnit,
          clipping: false,
          error: message
        })
        throw error
      }
    }
    throw new Error('Sheet Preview rendering failed.')
  }

  private async renderOnce(force: boolean): Promise<InternalSnapshot> {
    const regeneration = await awaitCadSessionRegeneration()
    if (regeneration && !regeneration.completed) {
      throw new Error(
        regeneration.error
          ? `CAD regeneration failed: ${regeneration.error}`
          : 'CAD regeneration is incomplete.'
      )
    }
    const source = this.captureSource()
    if (
      !force &&
      this.cache?.sourceKey === source.sourceKey &&
      this.cache.document === source.document
    ) {
      this.applySnapshot(this.cache)
      return this.cache
    }

    this.state.rendering = true
    recordSheetPreview({
      status: 'rendering',
      entityCount: cadSessionState.entityCount,
      visibleEntityCount: cadSessionState.visibleEntityCount,
      drawableElementCount: 0,
      warnings: [],
      unitMismatch: false,
      clipping: false
    })
    try {
      const result = await sheetRenderer.render(source.document, source.sheet)
      const svgSha256 = await sha256Text(result.svg)
      if (!this.sourceStillCurrent(source)) throw new StaleSheetPreviewError()

      const dimensions = paperDimensions(source.sheet)
      const snapshot: InternalSnapshot = {
        svg: result.svg,
        svgSha256,
        warnings: [...result.warnings],
        diagnostics: clone(result.diagnostics),
        sheet: clone(source.sheet),
        pageWidthMm: dimensions.pageWidthMm,
        pageHeightMm: dimensions.pageHeightMm,
        renderedAt: new Date().toISOString(),
        renderRevision: ++this.nextRenderRevision,
        documentRevision: source.documentRevision,
        contentRevision: source.contentRevision,
        document: source.document,
        sourceKey: source.sourceKey
      }
      if (!this.sourceStillCurrent(snapshot)) throw new StaleSheetPreviewError()
      this.cache = snapshot
      this.applySnapshot(snapshot)
      recordSheetPreview({
        status: snapshot.warnings.length > 0 ? 'warning' : 'ready',
        entityCount: snapshot.diagnostics.entityCount,
        visibleEntityCount: snapshot.diagnostics.visibleEntityCount,
        drawableElementCount: snapshot.diagnostics.drawableElementCount,
        warnings: snapshot.warnings,
        unitMismatch: snapshot.diagnostics.unitMismatch,
        clipping: snapshot.diagnostics.clipping
      })
      return snapshot
    } finally {
      this.state.rendering = false
    }
  }

  private captureSource(): InternalSnapshot {
    const active = requireEditableCadSession()
    const sheet = clone(sheetStore.current)
    const revision = getCadSessionRevision()
    return {
      svg: '',
      svgSha256: '',
      warnings: [],
      diagnostics: {} as SheetRenderDiagnostics,
      sheet,
      ...paperDimensions(sheet),
      renderedAt: '',
      renderRevision: 0,
      documentRevision: revision.documentRevision,
      contentRevision: revision.contentRevision,
      document: active.manager.curDocument,
      sourceKey: sourceKey(revision, sheet)
    }
  }

  private sourceStillCurrent(source: InternalSnapshot): boolean {
    try {
      const active = requireEditableCadSession()
      const revision = getCadSessionRevision()
      return (
        active.manager.curDocument === source.document &&
        source.sourceKey === sourceKey(revision, sheetStore.current)
      )
    } catch {
      return false
    }
  }

  private applySnapshot(snapshot: InternalSnapshot): void {
    this.state.svg = snapshot.svg
    this.state.svgSha256 = snapshot.svgSha256
    this.state.warnings = [...snapshot.warnings]
    this.state.renderError = null
    this.state.diagnostics = clone(snapshot.diagnostics)
    this.state.renderRevision = snapshot.renderRevision
  }
}

function sourceKey(
  revision: ReturnType<typeof getCadSessionRevision>,
  sheet: SheetDefinition
): string {
  return `${revision.documentRevision}:${revision.contentRevision}:${JSON.stringify(
    sheet
  )}`
}

function paperDimensions(sheet: SheetDefinition): {
  pageWidthMm: number
  pageHeightMm: number
} {
  const base = PAPER_SIZES[sheet.paper]
  return sheet.orientation === 'landscape'
    ? { pageWidthMm: base.heightMm, pageHeightMm: base.widthMm }
    : { pageWidthMm: base.widthMm, pageHeightMm: base.heightMm }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

async function sha256Text(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((item) => item.toString(16).padStart(2, '0'))
    .join('')
}

export const sheetPreviewService = new SheetPreviewService()
