import { describe, expect, it } from 'vitest'
import type { PersistedTurnEventEnvelope } from '../../../shared/agent-contracts'
import { TurnProjection } from '../runtime/TurnProjection'

const revision = {
  documentRevision: 2,
  contentRevision: 4,
  sheetRevision: 1,
  viewRevision: 3,
  documentId: 'document-a'
}

function envelope(
  sequence: number,
  payload: PersistedTurnEventEnvelope['payload']
): PersistedTurnEventEnvelope {
  return {
    protocolVersion: 2,
    sessionId: 'session-a',
    messageId: `event-${sequence}`,
    turnId: 'turn-a',
    sequence,
    timestamp: '2026-07-29T10:00:00.000Z',
    payload
  }
}

describe('TurnProjection', () => {
  it('deduplicates replayed events and reconstructs structured turn state', () => {
    const projection = new TurnProjection('turn-a')
    const accepted = envelope(1, {
      type: 'turn_accepted',
      turnId: 'turn-a',
      messageId: 'message-a',
      phase: 'accepted',
      revision,
      revisionTransition: 'same-document',
      activeSkillIds: [],
      provider: 'openai-codex',
      elapsedMs: 4,
      status: 'Accepted locally.'
    })
    const progress = envelope(2, {
      type: 'turn_progress',
      turnId: 'turn-a',
      phase: 'planning',
      revision,
      revisionTransition: 'same-document',
      activeSkillIds: ['cad-core', 'dxf-core'],
      provider: 'openai-codex',
      elapsedMs: 8,
      status: 'Planning.'
    })

    expect(projection.apply(accepted)).toBe('applied')
    expect(projection.apply(accepted)).toBe('duplicate')
    expect(projection.apply(progress)).toBe('applied')
    expect(
      projection.apply(
        envelope(3, {
          type: 'assistant_text_delta',
          turnId: 'turn-a',
          text: 'Done'
        })
      )
    ).toBe('applied')

    expect(projection.value).toMatchObject({
      accepted: true,
      phase: 'planning',
      status: 'Planning.',
      assistantText: 'Done',
      lastSequence: 3
    })
  })

  it('rejects events after the one terminal outcome', () => {
    const projection = new TurnProjection('turn-a')
    projection.apply(
      envelope(1, {
        type: 'turn_finished',
        turnId: 'turn-a',
        phase: 'completed',
        outcome: 'completed',
        revision,
        finalRevision: revision,
        revisionTransition: 'same-document',
        activeSkillIds: ['cad-core', 'dxf-core'],
        provider: 'openai-codex',
        elapsedMs: 10,
        status: 'Completed.',
        metrics: { totalMs: 10, toolCalls: 0 }
      })
    )

    expect(() =>
      projection.apply(
        envelope(2, {
          type: 'assistant_text_delta',
          turnId: 'turn-a',
          text: 'late'
        })
      )
    ).toThrow('after the terminal')
  })
})
