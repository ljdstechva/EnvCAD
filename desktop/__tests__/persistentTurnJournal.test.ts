import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENT_PROTOCOL_VERSION,
  type SubmitTurnEnvelope,
  type TurnAccepted,
  type TurnEvent,
  type WorkspaceRevision
} from '../../shared/agent-contracts'
import {
  appendTurnJournalRecord,
  PersistentTurnJournal,
  type TurnJournalRecord
} from '../agentJournal/PersistentTurnJournal'

const roots: string[] = []

const revision = (contentRevision = 0): WorkspaceRevision => ({
  documentId: 'drawing-1',
  documentRevision: 1,
  contentRevision,
  sheetRevision: 0,
  viewRevision: 0
})

const draft = (
  turnId = 'turn-1',
  messageId = 'client-message-1',
  sequence = 1,
  sessionId = 'session-1'
): SubmitTurnEnvelope => ({
  protocolVersion: AGENT_PROTOCOL_VERSION,
  sessionId,
  messageId,
  turnId,
  sequence,
  timestamp: '2026-07-29T08:00:00.000Z',
  payload: {
    type: 'submit_turn',
    text: 'Inspect the drawing.',
    referenceInputIds: [],
    configurationRevision: 1,
    selectionSnapshot: {
      count: 0,
      units: 'Meters',
      revision: revision()
    },
    sheet: {
      paper: 'A3',
      orientation: 'landscape',
      scaleDenominator: 500,
      drawingUnit: 'm'
    }
  }
})

const accepted = (
  turnId = 'turn-1',
  messageId = 'client-message-1'
): TurnAccepted => ({
  type: 'turn_accepted',
  turnId,
  messageId,
  phase: 'accepted',
  revision: revision(),
  revisionTransition: 'same-document',
  activeSkillIds: ['cad-core', 'dxf-core'],
  provider: 'openai-codex',
  elapsedMs: 1,
  status: 'Accepted.'
})

const progress = (
  turnId = 'turn-1'
): Extract<TurnEvent, { type: 'turn_progress' }> => ({
  type: 'turn_progress',
  turnId,
  phase: 'ingesting',
  revision: revision(),
  revisionTransition: 'same-document',
  activeSkillIds: ['cad-core', 'dxf-core'],
  provider: 'openai-codex',
  elapsedMs: 2,
  status: 'Preparing inputs.'
})

const failed = (turnId = 'turn-1'): TurnEvent => ({
  type: 'turn_finished',
  turnId,
  phase: 'failed',
  outcome: 'failed',
  revision: revision(),
  revisionTransition: 'same-document',
  finalRevision: revision(),
  activeSkillIds: ['cad-core', 'dxf-core'],
  provider: 'openai-codex',
  elapsedMs: 3,
  status: 'Provider connection failed.',
  error: {
    kind: 'transient-provider',
    code: 'provider-disconnected',
    userMessage: 'The provider connection ended.',
    retryable: true,
    recoveryActions: []
  },
  metrics: {
    totalMs: 3,
    toolCalls: 0
  }
})

async function journalRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'envcad-turn-journal-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('PersistentTurnJournal', () => {
  it('persists acceptance before allocating ordered follow-up events and resumes by cursor', async () => {
    const root = await journalRoot()
    const journal = new PersistentTurnJournal(root, {
      now: () => new Date('2026-07-29T08:00:01.000Z')
    })

    const acceptance = await journal.execute({
      type: 'accept-turn',
      eventId: 'server-event-accepted',
      draft: draft(),
      accepted: accepted()
    })
    expect(acceptance).toMatchObject({
      type: 'turn-accepted',
      duplicate: false,
      envelope: { sequence: 1 }
    })
    await journal.execute({
      type: 'append-event',
      eventId: 'server-event-progress',
      turnId: 'turn-1',
      event: progress()
    })
    await journal.execute({
      type: 'append-event',
      eventId: 'server-event-terminal',
      turnId: 'turn-1',
      event: failed()
    })
    await journal.close()

    const reopened = new PersistentTurnJournal(root)
    const read = await reopened.execute({
      type: 'read-turn',
      turnId: 'turn-1',
      afterSequence: 1
    })
    expect(read).toMatchObject({
      type: 'turn-read',
      eventsAfterCursor: [
        { sequence: 2, payload: { type: 'turn_progress' } },
        { sequence: 3, payload: { type: 'turn_finished' } }
      ]
    })
    await expect(
      reopened.execute({ type: 'list-open-turns' })
    ).resolves.toEqual({
      type: 'open-turns-listed',
      turns: []
    })
    await reopened.close()
  })

  it('makes acceptance and event retries idempotent by stable eventId', async () => {
    const root = await journalRoot()
    const journal = new PersistentTurnJournal(root)
    const acceptCommand = {
      type: 'accept-turn' as const,
      eventId: 'server-event-accepted',
      draft: draft(),
      accepted: accepted()
    }
    await journal.execute(acceptCommand)
    await expect(journal.execute(acceptCommand)).resolves.toMatchObject({
      type: 'turn-accepted',
      duplicate: true,
      envelope: { sequence: 1 }
    })
    const progressCommand = {
      type: 'append-event' as const,
      eventId: 'server-event-progress',
      turnId: 'turn-1',
      event: progress()
    }
    await journal.execute(progressCommand)
    await expect(journal.execute(progressCommand)).resolves.toMatchObject({
      type: 'event-appended',
      duplicate: true,
      envelope: { sequence: 2 }
    })
    await journal.close()
  })

  it('rejects changed acceptance, client-message rebinding, and cross-turn eventId collisions', async () => {
    const root = await journalRoot()
    const journal = new PersistentTurnJournal(root)
    await journal.execute({
      type: 'accept-turn',
      eventId: 'server-event-accepted-1',
      draft: draft(),
      accepted: accepted()
    })
    await expect(
      journal.execute({
        type: 'accept-turn',
        eventId: 'server-event-accepted-1',
        draft: draft(),
        accepted: { ...accepted(), status: 'Changed retry.' }
      })
    ).rejects.toThrow('acceptance changed during retry')
    await expect(
      journal.execute({
        type: 'accept-turn',
        eventId: 'server-event-accepted-rebound',
        draft: draft('turn-2', 'client-message-1', 2),
        accepted: accepted('turn-2', 'client-message-1')
      })
    ).rejects.toThrow('Client messageId is bound to multiple turns')

    await journal.execute({
      type: 'accept-turn',
      eventId: 'server-event-accepted-2',
      draft: draft('turn-2', 'client-message-2', 2),
      accepted: accepted('turn-2', 'client-message-2')
    })
    await expect(
      journal.execute({
        type: 'append-event',
        eventId: 'server-event-accepted-1',
        turnId: 'turn-2',
        event: progress('turn-2')
      })
    ).rejects.toThrow('eventId is bound to a different turn event')
    await journal.close()
  })

  it('allocates one monotonic server sequence across interleaved turns in a session', async () => {
    const root = await journalRoot()
    const journal = new PersistentTurnJournal(root)
    const first = await journal.execute({
      type: 'accept-turn',
      eventId: 'server-event-accepted-1',
      draft: draft(),
      accepted: accepted()
    })
    const second = await journal.execute({
      type: 'accept-turn',
      eventId: 'server-event-accepted-2',
      draft: draft('turn-2', 'client-message-2', 2),
      accepted: accepted('turn-2', 'client-message-2')
    })
    const resumedFirst = await journal.execute({
      type: 'append-event',
      eventId: 'server-event-progress-1',
      turnId: 'turn-1',
      event: progress()
    })
    expect([
      first.type === 'turn-accepted' ? first.envelope.sequence : -1,
      second.type === 'turn-accepted' ? second.envelope.sequence : -1,
      resumedFirst.type === 'event-appended'
        ? resumedFirst.envelope.sequence
        : -1
    ]).toEqual([1, 2, 3])

    await expect(
      journal.execute({
        type: 'read-turn',
        turnId: 'turn-1',
        afterSequence: 0
      })
    ).resolves.toMatchObject({
      eventsAfterCursor: [{ sequence: 1 }, { sequence: 3 }]
    })
    await journal.close()
  })

  it('serializes concurrent event appends and accepts explicit document replacement', async () => {
    const root = await journalRoot()
    const journal = new PersistentTurnJournal(root)
    await journal.execute({
      type: 'accept-turn',
      eventId: 'server-event-accepted',
      draft: draft(),
      accepted: accepted()
    })
    const replacementRevision: WorkspaceRevision = {
      ...revision(),
      documentId: 'drawing-2',
      documentRevision: 2
    }
    const replacement: Extract<TurnEvent, { type: 'turn_progress' }> = {
      ...progress(),
      revision: replacementRevision,
      revisionTransition: 'document-replaced',
      status: 'Document replaced.'
    }
    await Promise.all([
      journal.execute({
        type: 'append-event',
        eventId: 'server-event-progress',
        turnId: 'turn-1',
        event: replacement
      }),
      journal.execute({
        type: 'append-event',
        eventId: 'server-event-text',
        turnId: 'turn-1',
        event: {
          type: 'assistant_text_delta',
          turnId: 'turn-1',
          text: 'Working.'
        }
      })
    ])
    await expect(
      journal.execute({
        type: 'read-turn',
        turnId: 'turn-1',
        afterSequence: 0
      })
    ).resolves.toMatchObject({
      eventsAfterCursor: [
        { sequence: 1 },
        {
          sequence: 2,
          payload: {
            revisionTransition: 'document-replaced',
            revision: { documentId: 'drawing-2' }
          }
        },
        { sequence: 3, payload: { type: 'assistant_text_delta' } }
      ]
    })
    await journal.close()
  })

  it('returns the existing terminal only for the same eventId and rejects later events', async () => {
    const root = await journalRoot()
    const journal = new PersistentTurnJournal(root)
    await journal.execute({
      type: 'accept-turn',
      eventId: 'server-event-accepted',
      draft: draft(),
      accepted: accepted()
    })
    const terminalCommand = {
      type: 'append-event' as const,
      eventId: 'server-event-terminal',
      turnId: 'turn-1',
      event: failed()
    }
    await journal.execute(terminalCommand)
    await expect(journal.execute(terminalCommand)).resolves.toMatchObject({
      type: 'event-appended',
      duplicate: true
    })
    await expect(
      journal.execute({
        ...terminalCommand,
        eventId: 'server-event-terminal-2'
      })
    ).rejects.toThrow('event appears after the terminal event')
    await journal.close()
  })

  it('rejects invalid transitions without consuming the next event sequence', async () => {
    const root = await journalRoot()
    const journal = new PersistentTurnJournal(root)
    await journal.execute({
      type: 'accept-turn',
      eventId: 'server-event-accepted',
      draft: draft(),
      accepted: accepted()
    })
    await expect(
      journal.execute({
        type: 'append-event',
        eventId: 'server-event-invalid',
        turnId: 'turn-1',
        event: {
          ...progress(),
          phase: 'planning'
        }
      })
    ).rejects.toThrow('invalid turn transition')
    await expect(
      journal.execute({
        type: 'append-event',
        eventId: 'server-event-progress',
        turnId: 'turn-1',
        event: progress()
      })
    ).resolves.toMatchObject({
      type: 'event-appended',
      envelope: { sequence: 2 }
    })
    await journal.close()
  })

  it('fails closed when replay finds an event after a terminal event', async () => {
    const root = await journalRoot()
    const journal = new PersistentTurnJournal(root)
    await journal.execute({
      type: 'accept-turn',
      eventId: 'server-event-accepted',
      draft: draft(),
      accepted: accepted()
    })
    await journal.execute({
      type: 'append-event',
      eventId: 'server-event-terminal',
      turnId: 'turn-1',
      event: failed()
    })
    await journal.close()

    const terminal = new PersistentTurnJournal(root)
    const read = await terminal.execute({
      type: 'read-turn',
      turnId: 'turn-1',
      afterSequence: 0
    })
    if (read.type !== 'turn-read' || read.eventsAfterCursor.length !== 2) {
      throw new Error('missing terminal snapshot')
    }
    const invalidRecord: TurnJournalRecord = {
      kind: 'event',
      event: {
        ...read.eventsAfterCursor[1],
        messageId: 'server-event-after-terminal',
        sequence: 3,
        payload: {
          type: 'assistant_text_delta',
          turnId: 'turn-1',
          text: 'Late text'
        }
      }
    }
    await terminal.close()
    await appendTurnJournalRecord(
      path.join(root, 'turn-events.jsonl'),
      3,
      invalidRecord
    )

    const reopened = new PersistentTurnJournal(root)
    await expect(
      reopened.execute({
        type: 'read-turn',
        turnId: 'turn-1',
        afterSequence: 0
      })
    ).rejects.toThrow('event appears after the terminal event')
    await reopened.close().catch(() => undefined)
  })

  it('fails closed when a checksum-valid record contains a non-turn server payload', async () => {
    const root = await journalRoot()
    const journal = new PersistentTurnJournal(root)
    const acceptance = await journal.execute({
      type: 'accept-turn',
      eventId: 'server-event-accepted',
      draft: draft(),
      accepted: accepted()
    })
    if (acceptance.type !== 'turn-accepted') {
      throw new Error('missing acceptance envelope')
    }
    await journal.close()
    await appendTurnJournalRecord(
      path.join(root, 'turn-events.jsonl'),
      2,
      {
        kind: 'event',
        event: {
          ...acceptance.envelope,
          messageId: 'server-event-protocol-error',
          sequence: 2,
          payload: {
            type: 'protocol_error',
            code: 'invalid-message',
            message: 'Invalid message.'
          }
        }
      } as unknown as TurnJournalRecord
    )

    const reopened = new PersistentTurnJournal(root)
    await expect(
      reopened.execute({ type: 'list-open-turns' })
    ).rejects.toThrow('Turn journal events must contain a turn event')
    await reopened.close().catch(() => undefined)
  })

  it('poisons the owner after a lost synced append acknowledgement', async () => {
    const root = await journalRoot()
    let appends = 0
    const journal = new PersistentTurnJournal(root, {
      async appendRecord(...arguments_) {
        appends += 1
        await appendTurnJournalRecord(...arguments_)
        throw new Error('Injected turn-journal acknowledgement loss.')
      }
    })
    await expect(
      journal.execute({
        type: 'accept-turn',
        eventId: 'server-event-accepted',
        draft: draft(),
        accepted: accepted()
      })
    ).rejects.toThrow('acknowledgement loss')
    await expect(
      journal.execute({ type: 'list-open-turns' })
    ).rejects.toThrow('acknowledgement loss')
    expect(appends).toBe(1)
    await journal.close().catch(() => undefined)

    const recovered = new PersistentTurnJournal(root)
    await expect(
      recovered.execute({ type: 'list-open-turns' })
    ).resolves.toMatchObject({
      type: 'open-turns-listed',
      turns: [{ turnId: 'turn-1', lastSequence: 1, phase: 'accepted' }]
    })
    await recovered.close()
  })

  it('drains an already-enqueued turn acceptance during graceful close', async () => {
    const root = await journalRoot()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const journal = new PersistentTurnJournal(root, {
      async appendRecord(...arguments_) {
        await gate
        await appendTurnJournalRecord(...arguments_)
      }
    })
    const accepting = journal.execute({
      type: 'accept-turn',
      eventId: 'server-event-accepted',
      draft: draft(),
      accepted: accepted()
    })
    const closing = journal.close()
    await expect(
      journal.execute({ type: 'list-open-turns' })
    ).rejects.toThrow('closing')
    release()
    await expect(accepting).resolves.toMatchObject({
      type: 'turn-accepted',
      duplicate: false
    })
    await expect(closing).resolves.toBeUndefined()

    const reopened = new PersistentTurnJournal(root)
    await expect(
      reopened.execute({ type: 'list-open-turns' })
    ).resolves.toMatchObject({
      turns: [{ turnId: 'turn-1', phase: 'accepted' }]
    })
    await reopened.close()
  })
})
