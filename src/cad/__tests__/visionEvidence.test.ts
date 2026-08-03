import { describe, expect, it } from 'vitest'
import type { ToolImagePayload } from '../../agent/protocol'
import { VisionEvidenceStore } from '../vision/VisionEvidenceStore'
import type { VisionEvidence } from '../vision/VisionEvidence'

function image(id: string, digest = id.padEnd(64, '0')): ToolImagePayload {
  return {
    mimeType: 'image/png',
    base64: 'AA==',
    byteLength: 1,
    width: 1,
    height: 1,
    aspectRatio: 1,
    sha256: digest,
    captureId: id,
    renderRevision: 1
  }
}

function evidence(id: string, digest = id.padEnd(64, '0')): VisionEvidence {
  return {
    evidenceId: id,
    kind: 'model-view',
    imageDigest: digest,
    workspaceRevision: {
      documentId: 'drawing-1',
      documentRevision: 1,
      contentRevision: 2,
      sheetRevision: 3,
      viewRevision: 4
    },
    viewportBounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    pixelRegion: { x: 0, y: 0, width: 1, height: 1 },
    selectedEntityIds: [],
    visibleLayers: ['0'],
    renderSettings: {
      source: 'model-canvas',
      width: 1,
      height: 1,
      mimeType: 'image/png'
    },
    capturedAt: '2026-07-29T08:00:00.000Z'
  }
}

describe('VisionEvidenceStore', () => {
  it('binds each artifact to an image digest and complete workspace revision', () => {
    const store = new VisionEvidenceStore()
    const storedEvidence = evidence('capture-a')
    store.save(storedEvidence, image('capture-a'))

    const stored = store.require('capture-a')
    expect(stored.evidence.workspaceRevision).toEqual({
      documentId: 'drawing-1',
      documentRevision: 1,
      contentRevision: 2,
      sheetRevision: 3,
      viewRevision: 4
    })
    expect(stored.evidence.imageDigest).toBe(stored.image.sha256)
  })

  it('fails closed on a digest mismatch', () => {
    const store = new VisionEvidenceStore()
    expect(() =>
      store.save(evidence('capture-a'), image('capture-a', 'f'.repeat(64)))
    ).toThrow('digest')
  })

  it('keeps a bounded evidence history for before/after comparison', () => {
    const store = new VisionEvidenceStore(2)
    for (const id of ['capture-a', 'capture-b', 'capture-c']) {
      store.save(evidence(id), image(id))
    }
    expect(() => store.require('capture-a')).toThrow('evicted')
    expect(store.require('capture-b').evidence.evidenceId).toBe('capture-b')
    expect(store.require('capture-c').evidence.evidenceId).toBe('capture-c')
  })
})
