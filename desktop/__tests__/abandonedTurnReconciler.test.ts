import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AGENT_PROTOCOL_VERSION,
  type SubmitTurnEnvelope,
  type TurnAccepted,
  type WorkspaceRevision
} from '../../shared/agent-contracts'
import { turnEventId } from '../../shared/node/TurnEventIdentity'
import { reconcileAbandonedTurns } from '../agentJournal/AbandonedTurnReconciler'
import { PersistentTurnJournal } from '../agentJournal/PersistentTurnJournal'

const roots: string[] = []

const revision = (): WorkspaceRevision => ({
  documentId: 'drawing-1',
  documentRevision: 1,
  contentRevision: 2,
  sheetRevision: 0,
  viewRevision: 1
})

const draft = (): SubmitTurnEnvelope => ({
  protocolVersion: AGENT_PROTOCOL_VERSION,
  sessionId: 'session-1',
  messageId: 'client-message-1',
  turnId: 'turn-1',
  sequence: 1,
  timestamp: '2026-07-29T08:00:00.000Z',
  payload: {
    type: 'submit_turn',
    text: 'Inspect the drainage drawing.',
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

const accepted = (): TurnAccepted => ({
  type: 'turn_accepted',
  turnId: 'turn-1',
  messageId: 'client-message-1',
  phase: 'accepted',
  revision: revision(),
  revisionTransition: 'same-document',
  activeSkillIds: ['cad-core', 'dxf-core'],
  provider: 'openai-codex',
  elapsedMs: 0,
  status: 'Accepted.'
})

async function journalRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'envcad-reconcile-turn-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('reconcileAbandonedTurns', () => {
  it('moves an abandoned accepted turn through visible recovery to needs-input without replay', async () => {
    const journal = new PersistentTurnJournal(await journalRoot())
    await journal.execute({
      type: 'accept-turn',
      eventId: turnEventId('turn-1', 'accepted'),
      draft: draft(),
      accepted: accepted()
    })

    await expect(reconcileAbandonedTurns(journal)).resolves.toEqual({
      inspected: 1,
      reconciled: 1
    })
    const read = await journal.execute({
      type: 'read-turn',
      turnId: 'turn-1',
      afterSequence: 0
    })
    expect(read).toMatchObject({
      type: 'turn-read',
      terminal: true,
      eventsAfterCursor: [
        { payload: { type: 'turn_accepted', phase: 'accepted' } },
        {
          payload: {
            type: 'turn_progress',
            phase: 'recovering',
            revisionTransition: 'same-document',
            status: expect.stringContaining('No provider or drawing action was replayed')
          }
        },
        {
          payload: {
            type: 'turn_finished',
            phase: 'needs-input',
            outcome: 'needs-input',
            metrics: { toolCalls: 0 }
          }
        }
      ]
    })
    await expect(
      journal.execute({ type: 'list-open-turns' })
    ).resolves.toEqual({ type: 'open-turns-listed', turns: [] })
    await journal.close()
  })

  it('finishes an already recovering turn once and is idempotent after completion', async () => {
    const journal = new PersistentTurnJournal(await journalRoot())
    await journal.execute({
      type: 'accept-turn',
      eventId: turnEventId('turn-1', 'accepted'),
      draft: draft(),
      accepted: accepted()
    })
    await journal.execute({
      type: 'append-event',
      eventId: turnEventId('turn-1', 'runtime-recovering'),
      turnId: 'turn-1',
      event: {
        type: 'turn_progress',
        turnId: 'turn-1',
        phase: 'recovering',
        revision: revision(),
        revisionTransition: 'same-document',
        activeSkillIds: ['cad-core', 'dxf-core'],
        provider: 'openai-codex',
        elapsedMs: 17,
        status: 'Runtime recovery started.'
      }
    })

    await expect(reconcileAbandonedTurns(journal)).resolves.toEqual({
      inspected: 1,
      reconciled: 1
    })
    await expect(reconcileAbandonedTurns(journal)).resolves.toEqual({
      inspected: 0,
      reconciled: 0
    })
    const read = await journal.execute({
      type: 'read-turn',
      turnId: 'turn-1',
      afterSequence: 0
    })
    if (read.type !== 'turn-read') throw new Error('Unexpected journal result.')
    expect(read.eventsAfterCursor.map((event) => event.payload.type)).toEqual([
      'turn_accepted',
      'turn_progress',
      'turn_finished'
    ])
    expect(read.eventsAfterCursor.at(-1)?.payload).toMatchObject({
      outcome: 'needs-input',
      elapsedMs: 17
    })
    await journal.close()
  })
})
