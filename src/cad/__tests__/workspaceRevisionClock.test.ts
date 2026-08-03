import { describe, expect, it } from 'vitest'
import { WorkspaceRevisionClock } from '../revision/WorkspaceRevisionClock'

describe('WorkspaceRevisionClock', () => {
  it('changes opaque document identity and resets subordinate revisions', () => {
    let nextId = 0
    const clock = new WorkspaceRevisionClock(() => `test-${++nextId}`)

    expect(clock.snapshot()).toEqual({
      documentId: 'no-document',
      documentRevision: 0,
      contentRevision: 0,
      sheetRevision: 0,
      viewRevision: 0
    })

    clock.advanceDocument('document')
    clock.advanceContent()
    clock.advanceSheet()
    clock.advanceView()
    expect(clock.snapshot()).toEqual({
      documentId: 'document:test-1',
      documentRevision: 1,
      contentRevision: 1,
      sheetRevision: 1,
      viewRevision: 1
    })

    expect(clock.advanceDocument('no-document')).toEqual({
      documentId: 'no-document:test-2',
      documentRevision: 2,
      contentRevision: 0,
      sheetRevision: 0,
      viewRevision: 0
    })
  })

  it('returns snapshots that cannot mutate the clock', () => {
    const clock = new WorkspaceRevisionClock(() => 'stable-id')
    const snapshot = clock.advanceDocument('document')
    snapshot.contentRevision = 99

    expect(clock.snapshot().contentRevision).toBe(0)
  })

  it('advances content, sheet, and view revisions independently', () => {
    const clock = new WorkspaceRevisionClock(() => 'stable-id')
    clock.advanceDocument('document')

    clock.advanceContent()
    clock.advanceContent()
    clock.advanceSheet()
    clock.advanceView()
    clock.advanceView()
    clock.advanceView()

    expect(clock.snapshot()).toMatchObject({
      contentRevision: 2,
      sheetRevision: 1,
      viewRevision: 3
    })
  })
})
