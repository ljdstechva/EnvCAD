import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_PROTOCOL_VERSION,
  agentServerEnvelopeSchema,
  turnJournalResultSchema,
  type PersistedTurnEventEnvelope,
  type SkillActivation,
  type SubmitTurnEnvelope,
  type TurnEvent,
  type TurnJournalCommand,
  type TurnJournalPort,
  type TurnJournalResult,
  type WorkspaceRevision
} from '../../../shared/agent-contracts'
import { TurnOrchestrator } from '../application/turn/TurnOrchestrator'
import type {
  NeutralProviderEvent,
  ProviderTurnPort
} from '../application/turn/TurnExecution'

const revision: WorkspaceRevision = {
  documentId: 'drawing-recovery',
  documentRevision: 1,
  contentRevision: 2,
  sheetRevision: 3,
  viewRevision: 4
}

const mandatorySkills: SkillActivation[] = [
  {
    skillId: 'cad-core',
    name: 'CAD Core',
    version: '0.3.9',
    integrity: 'verified',
    activatedAt: '2026-07-29T08:00:00.000Z'
  },
  {
    skillId: 'dxf-core',
    name: 'DXF Core',
    version: '0.3.9',
    integrity: 'verified',
    activatedAt: '2026-07-29T08:00:00.000Z'
  }
]

class MemoryTurnJournal implements TurnJournalPort {
  readonly events: PersistedTurnEventEnvelope[] = []
  private readonly byEventId = new Map<string, PersistedTurnEventEnvelope>()
  private acceptedDraft: SubmitTurnEnvelope | undefined
  private sequence = 0

  async execute(command: TurnJournalCommand): Promise<TurnJournalResult> {
    if (command.type === 'accept-turn') {
      const existing = this.byEventId.get(command.eventId)
      if (existing) {
        return turnJournalResultSchema.parse({
          type: 'turn-accepted',
          envelope: existing,
          duplicate: true
        })
      }
      this.acceptedDraft = structuredClone(command.draft)
      const envelope = this.append(command.eventId, command.accepted)
      return turnJournalResultSchema.parse({
        type: 'turn-accepted',
        envelope,
        duplicate: false
      })
    }
    if (command.type === 'append-event') {
      const existing = this.byEventId.get(command.eventId)
      if (existing) {
        return turnJournalResultSchema.parse({
          type: 'event-appended',
          envelope: existing,
          duplicate: true
        })
      }
      return turnJournalResultSchema.parse({
        type: 'event-appended',
        envelope: this.append(command.eventId, command.event),
        duplicate: false
      })
    }
    if (command.type === 'read-turn') {
      const events = this.events.filter(
        (event) =>
          event.turnId === command.turnId &&
          event.sequence > command.afterSequence
      )
      return turnJournalResultSchema.parse({
        type: 'turn-read',
        ...(this.acceptedDraft
          ? {
              draft: this.acceptedDraft,
              lastSequence: this.sequence,
              terminal: this.events.at(-1)?.payload.type === 'turn_finished'
            }
          : {}),
        eventsAfterCursor: events
      })
    }
    return { type: 'open-turns-listed', turns: [] }
  }

  private append(eventId: string, payload: TurnEvent) {
    const envelope = agentServerEnvelopeSchema.parse({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      sessionId: 'session-recovery',
      messageId: eventId,
      turnId: 'turn-recovery',
      sequence: ++this.sequence,
      timestamp: '2026-07-29T08:00:01.000Z',
      payload
    }) as PersistedTurnEventEnvelope
    this.events.push(envelope)
    this.byEventId.set(eventId, envelope)
    return envelope
  }
}

class Conversation implements ProviderTurnPort {
  interrupted = false

  constructor(
    private readonly events: NeutralProviderEvent[] = [],
    private readonly failure?: Error
  ) {}

  async *runTurn(): AsyncIterable<NeutralProviderEvent> {
    if (this.failure) throw this.failure
    for (const event of this.events) yield event
  }

  async interrupt(): Promise<void> {
    this.interrupted = true
  }
}

function draft(): SubmitTurnEnvelope {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    sessionId: 'session-recovery',
    messageId: 'message-recovery',
    turnId: 'turn-recovery',
    sequence: 1,
    timestamp: '2026-07-29T08:00:00.000Z',
    payload: {
      type: 'submit_turn',
      text: 'Inspect the drawing.',
      referenceInputIds: [],
      configurationRevision: 1,
      selectionSnapshot: { count: 0, units: 'Meters', revision },
      sheet: {
        paper: 'A3',
        orientation: 'landscape',
        scaleDenominator: 500,
        drawingUnit: 'm'
      }
    }
  }
}

function runtime(
  conversation: ProviderTurnPort,
  recoverProvider: (
    failure: unknown,
    signal: AbortSignal
  ) => Promise<ProviderTurnPort>,
  toolCalls = 0,
  mutationCalls?: number
) {
  return {
    provider: 'openai-codex',
    prompt: 'provider prompt',
    activeSkills: mandatorySkills,
    conversation,
    recoverProvider,
    currentRevision: () => revision,
    toolMetrics: () => ({
      toolCalls,
      ...(mutationCalls !== undefined ? { mutationCalls } : {})
    })
  }
}

describe('RecoveryController', () => {
  it('recreates the same provider once before mutation and finishes as recovered', async () => {
    const journal = new MemoryTurnJournal()
    const replacement = new Conversation([
      { type: 'text_delta', text: 'Recovered result.' }
    ])
    const recover = vi.fn(async () => replacement)
    const orchestrator = new TurnOrchestrator({
      journal,
      emit: () => undefined
    })

    await expect(
      orchestrator.submit(
        draft(),
        runtime(
          new Conversation([], new Error('provider transport disconnected')),
          recover
        )
      )
    ).resolves.toEqual({ duplicate: false, outcome: 'recovered' })

    expect(recover).toHaveBeenCalledTimes(1)
    expect(
      journal.events
        .map(({ payload }) =>
          payload.type === 'turn_progress' ? payload.phase : undefined
        )
        .filter(Boolean)
    ).toEqual([
      'ingesting',
      'briefing',
      'planning',
      'inspecting',
      'executing',
      'recovering',
      'retrying',
      'executing',
      'verifying'
    ])
    expect(journal.events.at(-1)?.payload).toMatchObject({
      type: 'turn_finished',
      outcome: 'recovered',
      recovery: {
        attempts: [
          {
            strategy: 'recreate-same-provider-conversation',
            attempt: 1,
            succeeded: true
          }
        ],
        drawingChanged: false,
        resumedFromJournal: false
      },
      metrics: { retries: 1, toolCalls: 0 }
    })
  })

  it('does not retry a provider failure after any tool call', async () => {
    const journal = new MemoryTurnJournal()
    const recover = vi.fn(async () => new Conversation())
    const orchestrator = new TurnOrchestrator({
      journal,
      emit: () => undefined
    })

    await expect(
      orchestrator.submit(
        draft(),
        runtime(
          new Conversation([], new Error('provider transport disconnected')),
          recover,
          1,
          1
        )
      )
    ).resolves.toEqual({ duplicate: false, outcome: 'failed' })

    expect(recover).not.toHaveBeenCalled()
    expect(journal.events.at(-1)?.payload).toMatchObject({
      type: 'turn_finished',
      outcome: 'failed',
      error: { kind: 'transient-provider' },
      metrics: { toolCalls: 1 }
    })
  })

  it('may recover after read-only retrieval because no mutation was issued', async () => {
    const journal = new MemoryTurnJournal()
    const recover = vi.fn(
      async () =>
        new Conversation([{ type: 'text_delta', text: 'Recovered after read.' }])
    )
    const orchestrator = new TurnOrchestrator({
      journal,
      emit: () => undefined
    })

    await expect(
      orchestrator.submit(
        draft(),
        runtime(
          new Conversation([], new Error('provider transport disconnected')),
          recover,
          1,
          0
        )
      )
    ).resolves.toEqual({ duplicate: false, outcome: 'recovered' })
    expect(recover).toHaveBeenCalledOnce()
  })
})
