import { describe, expect, it } from 'vitest'
import {
  DurableTurnSession,
  type KeyValueStorage
} from '../runtime/DurableTurnSession'

class MemoryStorage implements KeyValueStorage {
  value: string | null = null
  getItem(): string | null {
    return this.value
  }
  setItem(_key: string, value: string): void {
    this.value = value
  }
}

const configuration = {
  provider: 'openai-codex' as const,
  model: 'gpt-test'
}
const revision = {
  documentRevision: 1,
  contentRevision: 2,
  sheetRevision: 0,
  viewRevision: 0,
  documentId: 'document-a'
}

describe('durable connection resume cursor', () => {
  it('restores the active turn, partial output, and last acknowledged sequence', () => {
    const storage = new MemoryStorage()
    const ids = ['session-a', 'turn-a', 'message-a']
    const first = new DurableTurnSession({
      storage,
      idFactory: () => ids.shift() ?? 'command-a',
      now: () => new Date('2026-07-29T10:00:00.000Z')
    })
    const { active } = first.beginTurn({
      text: 'Preserve me.',
      referenceInputIds: [],
      selectionSnapshot: {
        ids: [],
        count: 0,
        units: 'Unknown',
        revision: {
          documentRevision: revision.documentRevision,
          contentRevision: revision.contentRevision
        }
      },
      workspaceRevision: revision,
      sheet: {
        paper: 'A3',
        orientation: 'landscape',
        scaleDenominator: 500,
        drawingUnit: 'Meters'
      },
      configurationRevision: 1,
      configuration
    })
    expect(
      first.recordServerEvent(7, {
        accepted: true,
        streamingText: 'Partial response',
        projection: {
          phase: 'recovering',
          status: 'Reconnecting to the preserved turn.',
          activeSkills: [],
          operationReceipts: []
        }
      })
    ).toBe(true)

    const restored = new DurableTurnSession({ storage })
    expect(restored.sessionId).toBe('session-a')
    expect(restored.activeTurn).toMatchObject({
      turnId: active.turnId,
      messageId: active.messageId,
      lastServerSequence: 7,
      accepted: true,
      streamingText: 'Partial response',
      projection: {
        phase: 'recovering'
      }
    })
    expect(
      restored.command(
        {
          type: 'resume_turn',
          turnId: active.turnId,
          lastSequence: restored.activeTurn!.lastServerSequence
        },
        active.turnId
      ).payload
    ).toEqual({
      type: 'resume_turn',
      turnId: active.turnId,
      lastSequence: 7
    })
  })
})
