import type {
  StoredVisionEvidence,
  VisionEvidence
} from './VisionEvidence'
import type { ToolImagePayload } from '../../agent/protocol'

export class VisionEvidenceStore {
  private readonly evidence = new Map<string, StoredVisionEvidence>()

  constructor(private readonly maximumEntries = 20) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 2) {
      throw new Error('Vision evidence capacity must be at least two.')
    }
  }

  save(evidence: VisionEvidence, image: ToolImagePayload): void {
    if (evidence.imageDigest !== image.sha256) {
      throw new Error('Vision evidence digest does not match its image.')
    }
    this.evidence.delete(evidence.evidenceId)
    this.evidence.set(evidence.evidenceId, {
      evidence: structuredClone(evidence),
      image: structuredClone(image)
    })
    while (this.evidence.size > this.maximumEntries) {
      this.evidence.delete(this.evidence.keys().next().value!)
    }
  }

  require(evidenceId: string): StoredVisionEvidence {
    const stored = this.evidence.get(evidenceId)
    if (!stored) {
      throw new Error(
        `Vision evidence "${evidenceId}" is unavailable or was evicted.`
      )
    }
    return structuredClone(stored)
  }

  clear(): void {
    this.evidence.clear()
  }
}
