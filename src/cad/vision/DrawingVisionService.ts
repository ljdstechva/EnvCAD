import type { ToolResult } from '../../agent/protocol'
import {
  awaitCadSessionRegeneration,
  getWorkspaceRevision,
  requireEditableCadSession
} from '../session'
import type { DrawingBounds } from '../read-model/DrawingReadRecord'
import {
  captureCanvasRegion,
  composeEvidenceImages
} from './CanvasCapture'
import type {
  PixelRegion,
  VisionEvidence,
  VisionEvidenceKind
} from './VisionEvidence'
import { VisionEvidenceStore } from './VisionEvidenceStore'

export interface OverlayBox {
  x: number
  y: number
  width: number
  height: number
  label?: string
}

export class DrawingVisionService {
  constructor(private readonly store = new VisionEvidenceStore()) {}

  async captureModel(
    kind: Extract<VisionEvidenceKind, 'model-view' | 'region' | 'selection'>,
    regionBounds?: DrawingBounds,
    selectedEntityIds: readonly string[] = []
  ): Promise<ToolResult> {
    const regeneration = await awaitCadSessionRegeneration()
    if (regeneration && !regeneration.completed) {
      throw new Error('Model-view regeneration did not complete.')
    }
    const { database, view } = requireEditableCadSession()
    const revision = getWorkspaceRevision()
    const region = regionBounds
      ? pixelRegionFor(view, regionBounds)
      : fullCanvasRegion(view.canvas)
    const image = await captureCanvasRegion(
      view.canvas,
      region,
      `model-${revision.viewRevision}-${kind}`,
      revision.viewRevision + revision.contentRevision + 1
    )
    const evidence = makeEvidence({
      kind,
      image,
      pixelRegion: region,
      viewportBounds: viewportBounds(view),
      ...(regionBounds ? { regionBounds } : {}),
      selectedEntityIds: [...selectedEntityIds],
      visibleLayers: visibleLayerNames(database),
      source: 'model-canvas'
    })
    this.store.save(evidence, image)
    return {
      data: {
        evidence,
        revision: { ...evidence.workspaceRevision }
      },
      image
    }
  }

  recordSheet(result: ToolResult): ToolResult {
    if (!result.image) throw new Error('Sheet Preview returned no image evidence.')
    const revision = getWorkspaceRevision()
    const data = asRecord(result.data)
    const evidence = makeEvidence({
      kind: 'sheet-preview',
      image: result.image,
      pixelRegion: {
        x: 0,
        y: 0,
        width: result.image.width,
        height: result.image.height
      },
      selectedEntityIds: [],
      visibleLayers: visibleLayerNames(requireEditableCadSession().database),
      source: 'sheet-preview',
      revision
    })
    this.store.save(evidence, result.image)
    return {
      ...result,
      data: {
        ...data,
        evidence,
        revision: { ...evidence.workspaceRevision }
      }
    }
  }

  async compare(beforeEvidenceId: string, afterEvidenceId: string): Promise<ToolResult> {
    const before = this.store.require(beforeEvidenceId)
    const after = this.store.require(afterEvidenceId)
    if (
      before.evidence.workspaceRevision.documentId !==
      after.evidence.workspaceRevision.documentId
    ) {
      throw new Error('Before/after evidence belongs to different drawings.')
    }
    const revision = getWorkspaceRevision()
    const image = await composeEvidenceImages(
      [before.image, after.image],
      `compare-${revision.viewRevision}`,
      revision.viewRevision + revision.contentRevision + 1,
      (context, width, height) => {
        context.strokeStyle = '#f4c542'
        context.lineWidth = 3
        context.beginPath()
        context.moveTo(width / 2, 0)
        context.lineTo(width / 2, height)
        context.stroke()
      }
    )
    const evidence = makeEvidence({
      kind: 'before-after',
      image,
      pixelRegion: { x: 0, y: 0, width: image.width, height: image.height },
      selectedEntityIds: [
        ...new Set([
          ...before.evidence.selectedEntityIds,
          ...after.evidence.selectedEntityIds
        ])
      ],
      visibleLayers: after.evidence.visibleLayers,
      source: 'composite',
      revision
    })
    this.store.save(evidence, image)
    return {
      data: {
        beforeEvidenceId,
        afterEvidenceId,
        evidence,
        revision: { ...evidence.workspaceRevision }
      },
      image
    }
  }

  async overlay(evidenceId: string, boxes: readonly OverlayBox[]): Promise<ToolResult> {
    const source = this.store.require(evidenceId)
    const revision = getWorkspaceRevision()
    const image = await composeEvidenceImages(
      [source.image],
      `overlay-${revision.viewRevision}`,
      revision.viewRevision + revision.contentRevision + 1,
      (context, width, height) => drawOverlay(context, width, height, boxes)
    )
    const evidence = makeEvidence({
      kind: 'analysis-overlay',
      image,
      pixelRegion: { x: 0, y: 0, width: image.width, height: image.height },
      selectedEntityIds: source.evidence.selectedEntityIds,
      visibleLayers: source.evidence.visibleLayers,
      source: 'composite',
      revision
    })
    this.store.save(evidence, image)
    return {
      data: {
        sourceEvidenceId: evidenceId,
        evidence,
        revision: { ...evidence.workspaceRevision }
      },
      image
    }
  }
}

function makeEvidence(input: {
  kind: VisionEvidenceKind
  image: NonNullable<ToolResult['image']>
  pixelRegion: PixelRegion
  viewportBounds?: DrawingBounds
  regionBounds?: DrawingBounds
  selectedEntityIds: string[]
  visibleLayers: string[]
  source: VisionEvidence['renderSettings']['source']
  revision?: ReturnType<typeof getWorkspaceRevision>
}): VisionEvidence {
  return {
    evidenceId: `evidence-${input.image.captureId}`,
    kind: input.kind,
    imageDigest: input.image.sha256,
    workspaceRevision: input.revision ?? getWorkspaceRevision(),
    ...(input.viewportBounds ? { viewportBounds: input.viewportBounds } : {}),
    ...(input.regionBounds ? { regionBounds: input.regionBounds } : {}),
    pixelRegion: { ...input.pixelRegion },
    selectedEntityIds: [...input.selectedEntityIds],
    visibleLayers: [...input.visibleLayers],
    renderSettings: {
      source: input.source,
      width: input.image.width,
      height: input.image.height,
      mimeType: input.image.mimeType
    },
    capturedAt: new Date().toISOString()
  }
}

function fullCanvasRegion(canvas: HTMLCanvasElement): PixelRegion {
  return { x: 0, y: 0, width: canvas.width, height: canvas.height }
}

function pixelRegionFor(
  view: ReturnType<typeof requireEditableCadSession>['view'],
  bounds: DrawingBounds
): PixelRegion {
  const first = view.worldToScreen({ x: bounds.minX, y: bounds.minY })
  const second = view.worldToScreen({ x: bounds.maxX, y: bounds.maxY })
  const scaleX = view.canvas.width / view.width
  const scaleY = view.canvas.height / view.height
  const x = Math.max(0, Math.min(first.x, second.x) * scaleX)
  const y = Math.max(0, Math.min(first.y, second.y) * scaleY)
  const right = Math.min(view.canvas.width, Math.max(first.x, second.x) * scaleX)
  const bottom = Math.min(view.canvas.height, Math.max(first.y, second.y) * scaleY)
  if (right <= x || bottom <= y) {
    throw new Error('The requested drawing region is outside the current viewport.')
  }
  return { x, y, width: right - x, height: bottom - y }
}

function viewportBounds(
  view: ReturnType<typeof requireEditableCadSession>['view']
): DrawingBounds {
  const first = view.screenToWorld({ x: 0, y: 0 })
  const second = view.screenToWorld({ x: view.width, y: view.height })
  return {
    minX: Math.min(first.x, second.x),
    minY: Math.min(first.y, second.y),
    maxX: Math.max(first.x, second.x),
    maxY: Math.max(first.y, second.y)
  }
}

function visibleLayerNames(
  database: ReturnType<typeof requireEditableCadSession>['database']
): string[] {
  return Array.from(database.tables.layerTable.newIterator())
    .filter((layer) => !layer.isOff && !layer.isFrozen)
    .map((layer) => layer.name)
    .sort((left, right) => left.localeCompare(right))
}

function drawOverlay(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  boxes: readonly OverlayBox[]
): void {
  context.strokeStyle = '#ffcc00'
  context.fillStyle = '#ffcc00'
  context.font = '14px sans-serif'
  context.lineWidth = 3
  for (const box of boxes) {
    const x = box.x * width
    const y = box.y * height
    const boxWidth = box.width * width
    const boxHeight = box.height * height
    context.strokeRect(x, y, boxWidth, boxHeight)
    if (box.label) context.fillText(box.label, x + 4, Math.max(14, y - 4))
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export const drawingVisionService = new DrawingVisionService()
