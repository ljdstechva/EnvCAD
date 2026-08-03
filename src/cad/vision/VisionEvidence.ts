import type { WorkspaceRevision } from '../../../shared/agent-contracts'
import type { ToolImagePayload } from '../../agent/protocol'
import type { DrawingBounds } from '../read-model/DrawingReadRecord'

export type VisionEvidenceKind =
  | 'model-view'
  | 'sheet-preview'
  | 'region'
  | 'selection'
  | 'before-after'
  | 'analysis-overlay'

export interface PixelRegion {
  x: number
  y: number
  width: number
  height: number
}

export interface VisionEvidence {
  evidenceId: string
  kind: VisionEvidenceKind
  imageDigest: string
  workspaceRevision: WorkspaceRevision
  viewportBounds?: DrawingBounds
  regionBounds?: DrawingBounds
  pixelRegion: PixelRegion
  selectedEntityIds: string[]
  visibleLayers: string[]
  renderSettings: {
    source: 'model-canvas' | 'sheet-preview' | 'composite'
    width: number
    height: number
    mimeType: ToolImagePayload['mimeType']
  }
  capturedAt: string
}

export interface StoredVisionEvidence {
  evidence: VisionEvidence
  image: ToolImagePayload
}
