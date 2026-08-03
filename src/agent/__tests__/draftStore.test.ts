import { describe, expect, it, vi } from 'vitest'
import {
  ASSISTANT_DRAFT_STORAGE_KEY,
  DraftStore
} from '../runtime/DraftStore'
import type { KeyValueStorage } from '../runtime/DurableTurnSession'

class MemoryStorage implements KeyValueStorage {
  values = new Map<string, string>()
  failWrites = false

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('Injected storage failure')
    this.values.set(key, value)
  }
}

const turn = {
  text: 'Inspect the queued follow-up.',
  referenceInputIds: ['input-reference'],
  selectionSnapshot: {
    ids: ['entity-a'],
    count: 1,
    units: 'Meters',
    revision: { documentRevision: 3, contentRevision: 7 }
  },
  sheet: {
    paper: 'A3',
    orientation: 'landscape' as const,
    scaleDenominator: 500,
    drawingUnit: 'Meters'
  }
}

describe('DraftStore', () => {
  it('restores the exact composer draft and queued follow-ups after reload', () => {
    const storage = new MemoryStorage()
    const first = new DraftStore({
      storage,
      idFactory: () => 'queue-1',
      now: () => new Date('2026-07-29T10:00:00.000Z')
    })

    expect(first.setComposerText('  exact\r\nUnicode 🌏 draft  ')).toBe(true)
    first.enqueue(turn)

    const restored = new DraftStore({ storage })
    expect(restored.composerText).toBe('  exact\r\nUnicode 🌏 draft  ')
    expect(restored.queuedTurns).toEqual([
      expect.objectContaining({
        queueId: 'queue-1',
        queuedAt: '2026-07-29T10:00:00.000Z',
        text: turn.text,
        status: 'queued',
        selectionSnapshot: turn.selectionSnapshot
      })
    ])
  })

  it('rolls back in-memory changes when durable persistence fails', () => {
    const storage = new MemoryStorage()
    const onPersistenceError = vi.fn()
    const drafts = new DraftStore({
      storage,
      idFactory: () => 'queue-1',
      onPersistenceError
    })
    expect(drafts.setComposerText('safe draft')).toBe(true)
    storage.failWrites = true

    expect(drafts.setComposerText('not durable')).toBe(false)
    expect(drafts.composerText).toBe('safe draft')
    expect(() => drafts.enqueue(turn)).toThrow('could not preserve')
    expect(drafts.queuedTurns).toEqual([])
    expect(onPersistenceError).toHaveBeenCalled()
  })

  it('quarantines malformed storage rather than executing queued content', () => {
    const storage = new MemoryStorage()
    storage.values.set(
      ASSISTANT_DRAFT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        composerText: 'draft',
        queuedTurns: [{ queueId: 'malformed' }]
      })
    )
    const onPersistenceError = vi.fn()
    const drafts = new DraftStore({ storage, onPersistenceError })

    expect(drafts.composerText).toBe('')
    expect(drafts.queuedTurns).toEqual([])
    expect(onPersistenceError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('quarantined')
      })
    )
  })

  it('marks stale selections for review and removes only the chosen item', () => {
    const drafts = new DraftStore({
      storage: new MemoryStorage(),
      idFactory: (() => {
        let id = 0
        return () => `queue-${++id}`
      })()
    })
    const first = drafts.enqueue(turn)
    const second = drafts.enqueue({ ...turn, text: 'Second message' })

    expect(
      drafts.update(first.queueId, {
        status: 'needs-review',
        reason: 'Drawing changed.'
      })
    ).toBe(true)
    expect(drafts.remove(second.queueId)).toBe(true)
    expect(drafts.queuedTurns).toEqual([
      expect.objectContaining({
        queueId: first.queueId,
        status: 'needs-review',
        reason: 'Drawing changed.'
      })
    ])
  })
})
