import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROTOCOL_VERSION,
  type AgentConfiguration,
  type PersistedTurnEventEnvelope,
  type TurnEvent,
  type WorkspaceRevision
} from '../../../shared/agent-contracts'
import {
  DurableTurnSession,
  type KeyValueStorage
} from '../runtime/DurableTurnSession'
import { TurnProjection } from '../runtime/TurnProjection'

class MemoryStorage implements KeyValueStorage {
  readonly values = new Map<string, string>()
  failWrites = false

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('Injected browser storage failure.')
    this.values.set(key, value)
  }
}

const revision = (contentRevision = 4): WorkspaceRevision => ({
  documentId: 'drawing-1',
  documentRevision: 2,
  contentRevision,
  sheetRevision: 1,
  viewRevision: 3
})

const configuration: AgentConfiguration = {
  provider: 'openai-codex',
  model: 'gpt-5.6-codex',
  effort: 'high'
}

const turnInput = () => ({
  text: 'Inspect the selected drainage alignment.',
  selectionSnapshot: {
    ids: ['entity-1', 'entity-2'],
    count: 2,
    units: 'Meters',
    revision: {
      documentRevision: 2,
      contentRevision: 4
    }
  },
  workspaceRevision: revision(),
  sheet: {
    paper: 'A3',
    orientation: 'landscape' as const,
    scaleDenominator: 500,
    drawingUnit: 'm',
    fields: { project: 'Drainage plan' }
  },
  configurationRevision: 7,
  configuration
})

function ids(...values: string[]): () => string {
  let index = 0
  return () => values[index++] ?? `generated-${index}`
}

function envelope(
  sequence: number,
  payload: TurnEvent,
  turnId = 'turn-1'
): PersistedTurnEventEnvelope {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    sessionId: 'session-1',
    messageId: `server-${sequence}`,
    turnId,
    sequence,
    timestamp: '2026-07-29T08:00:00.000Z',
    payload
  }
}

const transition = {
  turnId: 'turn-1',
  revision: revision(),
  revisionTransition: 'same-document' as const,
  activeSkillIds: ['cad-core', 'dxf-core'],
  provider: 'openai-codex',
  elapsedMs: 1,
  status: 'Accepted.'
}

describe('DurableTurnSession', () => {
  it('restores the exact frozen draft, cursor, partial output, and command sequence', () => {
    const storage = new MemoryStorage()
    const first = new DurableTurnSession({
      storage,
      idFactory: ids('session-1', 'turn-1', 'client-message-1'),
      now: () => new Date('2026-07-29T08:00:00.000Z')
    })
    const created = first.beginTurn(turnInput())
    const originalEnvelope = structuredClone(created.envelope)

    expect(
      first.recordServerEvent(4, {
        accepted: true,
        streamingText: 'Partial durable response.',
        projection: {
          phase: 'executing',
          status: 'Executing the provider turn.',
          activeSkills: [
            {
              skillId: 'cad-core',
              name: 'CAD core',
              version: '2.0.0',
              integrity: 'verified',
              activatedAt: '2026-07-29T08:00:00.000Z'
            }
          ],
          operationReceipts: []
        }
      })
    ).toBe(true)

    const restored = new DurableTurnSession({
      storage,
      idFactory: ids('client-command-2'),
      now: () => new Date('2026-07-29T08:01:00.000Z')
    })
    expect(restored.sessionId).toBe('session-1')
    expect(restored.activeTurn).toMatchObject({
      turnId: 'turn-1',
      messageId: 'client-message-1',
      accepted: true,
      lastServerSequence: 4,
      streamingText: 'Partial durable response.',
      projection: {
        phase: 'executing',
        status: 'Executing the provider turn.',
        activeSkills: [{ skillId: 'cad-core' }]
      },
      selectionSnapshot: { ids: ['entity-1', 'entity-2'] },
      workspaceRevision: revision()
    })
    expect(restored.submitEnvelope()).toEqual(originalEnvelope)

    const resume = restored.command(
      { type: 'resume_turn', turnId: 'turn-1', lastSequence: 4 },
      'turn-1'
    )
    expect(resume).toMatchObject({
      sessionId: 'session-1',
      messageId: 'client-command-2',
      sequence: 2
    })

    const reloadedAgain = new DurableTurnSession({ storage })
    expect(reloadedAgain.activeTurn?.clientSequence).toBe(1)
    expect(
      reloadedAgain.command(
        { type: 'cancel_turn', turnId: 'turn-1' },
        'turn-1'
      ).sequence
    ).toBe(3)
  })

  it('validates nested persisted state and reports corruption before starting a new session', () => {
    const storage = new MemoryStorage()
    const first = new DurableTurnSession({
      storage,
      idFactory: ids('session-1', 'turn-1', 'message-1')
    })
    first.beginTurn(turnInput())
    const [key, raw] = [...storage.values.entries()][0]
    const corrupted = JSON.parse(raw) as {
      activeTurn: { selectionSnapshot: { count: number } }
    }
    corrupted.activeTurn.selectionSnapshot.count = 99
    storage.values.set(key, JSON.stringify(corrupted))
    const onPersistenceError = vi.fn()

    const replacement = new DurableTurnSession({
      storage,
      idFactory: ids('replacement-session'),
      onPersistenceError
    })

    expect(replacement.sessionId).toBe('replacement-session')
    expect(replacement.activeTurn).toBeUndefined()
    expect(onPersistenceError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Stored durable turn state is invalid and cannot be restored.'
      })
    )
  })

  it('does not expose an unpersisted draft or consume its client sequence', () => {
    const storage = new MemoryStorage()
    const onPersistenceError = vi.fn()
    const session = new DurableTurnSession({
      storage,
      idFactory: ids(
        'session-1',
        'turn-failed',
        'message-failed',
        'command-after-failure'
      ),
      onPersistenceError
    })
    storage.failWrites = true

    expect(() => session.beginTurn(turnInput())).toThrow(
      'could not persist durable turn state'
    )
    expect(session.activeTurn).toBeUndefined()
    expect(onPersistenceError).toHaveBeenCalledOnce()

    storage.failWrites = false
    expect(session.command({ type: 'refresh_ai_capabilities' })).toMatchObject({
      messageId: 'command-after-failure',
      sequence: 1
    })
  })

  it('clears a completed turn durably without changing the session identity', () => {
    const storage = new MemoryStorage()
    const session = new DurableTurnSession({
      storage,
      idFactory: ids('session-1', 'turn-1', 'message-1')
    })
    session.beginTurn(turnInput())

    expect(session.finishTurn('turn-1')).toBe(true)
    const restored = new DurableTurnSession({ storage })
    expect(restored.sessionId).toBe('session-1')
    expect(restored.activeTurn).toBeUndefined()
  })
})

describe('TurnProjection', () => {
  it('projects increasing journal events and ignores stale or duplicate cursors', () => {
    const projection = new TurnProjection('turn-1')
    expect(
      projection.apply(
        envelope(1, {
          type: 'turn_accepted',
          ...transition,
          messageId: 'client-message-1',
          phase: 'accepted'
        })
      )
    ).toBe('applied')
    expect(
      projection.apply(
        envelope(3, {
          type: 'assistant_text_delta',
          turnId: 'turn-1',
          text: 'First'
        })
      )
    ).toBe('applied')
    expect(
      projection.apply(
        envelope(2, {
          type: 'assistant_text_delta',
          turnId: 'turn-1',
          text: 'stale'
        })
      )
    ).toBe('duplicate')
    projection.apply(
      envelope(4, {
        type: 'skill_activated',
        turnId: 'turn-1',
        skill: {
          skillId: 'cad-core',
          name: 'CAD core',
          version: '2.0.0',
          integrity: 'verified',
          activatedAt: '2026-07-29T08:00:00.000Z'
        }
      })
    )
    projection.apply(
      envelope(5, {
        type: 'skill_activated',
        turnId: 'turn-1',
        skill: {
          skillId: 'cad-core',
          name: 'CAD core',
          version: '2.0.1',
          integrity: 'verified',
          activatedAt: '2026-07-29T08:00:01.000Z'
        }
      })
    )

    expect(projection.value).toMatchObject({
      accepted: true,
      lastSequence: 5,
      assistantText: 'First',
      activeSkills: [{ skillId: 'cad-core', version: '2.0.1' }]
    })
  })

  it('restores a partial projection and rejects events after one terminal outcome', () => {
    const projection = new TurnProjection('turn-1', {
      lastSequence: 8,
      assistantText: 'Restored ',
      accepted: true
    })
    expect(
      projection.apply(
        envelope(8, {
          type: 'assistant_text_delta',
          turnId: 'turn-1',
          text: 'duplicate'
        })
      )
    ).toBe('duplicate')
    projection.apply(
      envelope(10, {
        type: 'assistant_text_delta',
        turnId: 'turn-1',
        text: 'output'
      })
    )
    projection.apply(
      envelope(12, {
        type: 'turn_finished',
        ...transition,
        phase: 'completed',
        outcome: 'completed',
        status: 'Completed.',
        finalRevision: revision(),
        metrics: { totalMs: 12, toolCalls: 0 }
      })
    )

    expect(projection.value).toMatchObject({
      lastSequence: 12,
      assistantText: 'Restored output',
      terminal: { outcome: 'completed' }
    })
    expect(() =>
      projection.apply(
        envelope(13, {
          type: 'assistant_text_delta',
          turnId: 'turn-1',
          text: 'late'
        })
      )
    ).toThrow('after the terminal outcome')
    expect(() =>
      projection.apply(
        envelope(
          14,
          {
            type: 'assistant_text_delta',
            turnId: 'another-turn',
            text: 'wrong turn'
          },
          'another-turn'
        )
      )
    ).toThrow('different turn')
  })
})
