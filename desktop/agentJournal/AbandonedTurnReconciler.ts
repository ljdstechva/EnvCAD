import {
  type PersistedTurnEventEnvelope,
  type TurnJournalPort,
  type TurnTransition
} from '../../shared/agent-contracts'
import { turnEventId } from '../../shared/node/TurnEventIdentity'

export interface AbandonedTurnReconciliationSummary {
  inspected: number
  reconciled: number
}

export async function reconcileAbandonedTurns(
  journal: TurnJournalPort
): Promise<AbandonedTurnReconciliationSummary> {
  const listed = await journal.execute({ type: 'list-open-turns' })
  if (listed.type !== 'open-turns-listed') {
    throw new Error('Turn journal returned the wrong open-turn result.')
  }
  let reconciled = 0
  for (const open of listed.turns) {
    const read = await journal.execute({
      type: 'read-turn',
      turnId: open.turnId,
      afterSequence: 0
    })
    if (
      read.type !== 'turn-read' ||
      !read.draft ||
      read.terminal ||
      read.eventsAfterCursor.length === 0
    ) {
      throw new Error(
        `Open turn "${open.turnId}" has no complete non-terminal journal snapshot.`
      )
    }
    const transition = latestTransition(read.eventsAfterCursor)
    let recoveryTransition = transition
    if (open.phase !== 'recovering') {
      const recovering = {
        type: 'turn_progress' as const,
        turnId: open.turnId,
        phase: 'recovering' as const,
        revision: structuredClone(transition.revision),
        revisionTransition: 'same-document' as const,
        activeSkillIds: [...transition.activeSkillIds],
        provider: transition.provider,
        elapsedMs: transition.elapsedMs,
        status:
          'EnvCAD restarted before this turn reached a terminal outcome. No provider or drawing action was replayed.'
      }
      const appended = await journal.execute({
        type: 'append-event',
        eventId: turnEventId(open.turnId, 'startup-recovering'),
        turnId: open.turnId,
        event: recovering
      })
      if (appended.type !== 'event-appended') {
        throw new Error('Turn journal returned the wrong recovery result.')
      }
      recoveryTransition = recovering
    }
    const terminal = await journal.execute({
      type: 'append-event',
      eventId: turnEventId(open.turnId, 'startup-needs-input'),
      turnId: open.turnId,
      event: {
        type: 'turn_finished',
        turnId: open.turnId,
        phase: 'needs-input',
        outcome: 'needs-input',
        revision: structuredClone(recoveryTransition.revision),
        revisionTransition: 'same-document',
        finalRevision: structuredClone(recoveryTransition.revision),
        activeSkillIds: [...recoveryTransition.activeSkillIds],
        provider: recoveryTransition.provider,
        elapsedMs: recoveryTransition.elapsedMs,
        status:
          'The interrupted turn needs review before a replacement turn is started.',
        metrics: {
          totalMs: recoveryTransition.elapsedMs,
          toolCalls: countOperationReceipts(read.eventsAfterCursor)
        }
      }
    })
    if (terminal.type !== 'event-appended') {
      throw new Error('Turn journal returned the wrong terminal recovery result.')
    }
    reconciled += 1
  }
  return { inspected: listed.turns.length, reconciled }
}

function latestTransition(
  events: readonly PersistedTurnEventEnvelope[]
): TurnTransition {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = events[index].payload
    if (
      payload.type === 'turn_accepted' ||
      payload.type === 'turn_progress' ||
      payload.type === 'turn_finished'
    ) {
      return payload
    }
  }
  throw new Error('Open turn has no transition event.')
}

function countOperationReceipts(
  events: readonly PersistedTurnEventEnvelope[]
): number {
  return events.filter((event) => event.payload.type === 'operation_receipt')
    .length
}
