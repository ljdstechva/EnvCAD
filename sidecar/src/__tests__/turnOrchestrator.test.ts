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
  documentId: 'drawing-1',
  documentRevision: 1,
  contentRevision: 2,
  sheetRevision: 3,
  viewRevision: 4
}

const draft = (): SubmitTurnEnvelope => ({
  protocolVersion: AGENT_PROTOCOL_VERSION,
  sessionId: 'session-1',
  messageId: 'message-1',
  turnId: 'turn-1',
  sequence: 1,
  timestamp: '2026-07-29T08:00:00.000Z',
  payload: {
    type: 'submit_turn',
    text: 'Inspect the active drawing and report its layers.',
    referenceInputIds: [],
    configurationRevision: 1,
    selectionSnapshot: {
      count: 0,
      units: 'Meters',
      revision
    },
    sheet: {
      paper: 'A3',
      orientation: 'landscape',
      scaleDenominator: 500,
      drawingUnit: 'm'
    }
  }
})

const skills = (): SkillActivation[] => [
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

class FakeTurnJournal implements TurnJournalPort {
  readonly events: PersistedTurnEventEnvelope[] = []
  private acceptedDraft: SubmitTurnEnvelope | undefined
  private readonly byId = new Map<string, PersistedTurnEventEnvelope>()
  private sequence = 0

  async execute(command: TurnJournalCommand): Promise<TurnJournalResult> {
    if (command.type === 'accept-turn') {
      const existing = this.byId.get(command.eventId)
      if (existing) {
        return turnJournalResultSchema.parse({
          type: 'turn-accepted',
          envelope: existing,
          duplicate: true
        })
      }
      this.acceptedDraft = structuredClone(command.draft)
      const envelope = this.envelope(command.eventId, command.accepted)
      this.record(command.eventId, envelope)
      return turnJournalResultSchema.parse({
        type: 'turn-accepted',
        envelope,
        duplicate: false
      })
    }
    if (command.type === 'append-event') {
      const existing = this.byId.get(command.eventId)
      if (existing) {
        return turnJournalResultSchema.parse({
          type: 'event-appended',
          envelope: existing,
          duplicate: true
        })
      }
      const envelope = this.envelope(command.eventId, command.event)
      this.record(command.eventId, envelope)
      return turnJournalResultSchema.parse({
        type: 'event-appended',
        envelope,
        duplicate: false
      })
    }
    if (command.type === 'read-turn') {
      const events = this.events.filter(
        (event) =>
          event.turnId === command.turnId &&
          event.sequence > command.afterSequence
      )
      const last = this.events
        .filter((event) => event.turnId === command.turnId)
        .at(-1)
      return turnJournalResultSchema.parse({
        type: 'turn-read',
        ...(this.acceptedDraft && last
          ? {
              draft: this.acceptedDraft,
              lastSequence: last.sequence,
              terminal: last.payload.type === 'turn_finished'
            }
          : {}),
        eventsAfterCursor: events
      })
    }
    return { type: 'open-turns-listed', turns: [] }
  }

  private envelope(
    messageId: string,
    payload: TurnEvent
  ): PersistedTurnEventEnvelope {
    return agentServerEnvelopeSchema.parse({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      sessionId: 'session-1',
      messageId,
      turnId: 'turn-1',
      sequence: ++this.sequence,
      timestamp: '2026-07-29T08:00:01.000Z',
      payload
    }) as PersistedTurnEventEnvelope
  }

  private record(
    messageId: string,
    envelope: PersistedTurnEventEnvelope
  ): void {
    this.byId.set(messageId, envelope)
    this.events.push(envelope)
  }
}

class FakeConversation implements ProviderTurnPort {
  interrupted = false

  constructor(
    private readonly events: NeutralProviderEvent[] = [],
    private readonly failure?: Error,
    private readonly gate?: Promise<void>
  ) {}

  async *runTurn(): AsyncIterable<NeutralProviderEvent> {
    if (this.gate) await this.gate
    if (this.failure) throw this.failure
    for (const event of this.events) yield event
  }

  async interrupt(): Promise<void> {
    this.interrupted = true
  }
}

function runtime(conversation: ProviderTurnPort) {
  return {
    provider: 'openai-codex',
    prompt: 'complete provider prompt',
    activeSkills: skills(),
    conversation,
    currentRevision: () => revision,
    toolMetrics: () => ({ toolCalls: 0 }),
    providerReadyMs: 5,
    conversationStartupMs: 7
  }
}

describe('TurnOrchestrator', () => {
  it('durably acknowledges, reports local work, and emits exactly one terminal event', async () => {
    const journal = new FakeTurnJournal()
    const emitted: PersistedTurnEventEnvelope[] = []
    let clock = 0
    const orchestrator = new TurnOrchestrator({
      journal,
      emit: (event) => emitted.push(event),
      monotonicNow: () => ++clock
    })
    const conversation = new FakeConversation([
      { type: 'text_delta', text: 'Layer ' },
      { type: 'text_delta', text: 'inspection complete.' },
      { type: 'token_usage', inputTokens: 10, outputTokens: 3 }
    ])

    await expect(
      orchestrator.submit(draft(), runtime(conversation))
    ).resolves.toEqual({ duplicate: false, outcome: 'completed' })

    expect(emitted).toEqual(journal.events)
    expect(emitted.map(({ payload }) => payload.type)).toEqual([
      'turn_accepted',
      'skill_activated',
      'skill_activated',
      'turn_progress',
      'turn_progress',
      'instruction_breakdown',
      'turn_progress',
      'turn_progress',
      'turn_progress',
      'assistant_text_delta',
      'assistant_text_delta',
      'turn_progress',
      'turn_finished'
    ])
    const transitions = emitted
      .map(({ payload }) => payload)
      .filter(
        (event) =>
          event.type === 'turn_accepted' ||
          event.type === 'turn_progress' ||
          event.type === 'turn_finished'
      )
    expect(
      transitions.every((event) => event.provider === 'openai-codex')
    ).toBe(true)
    expect(
      emitted.filter(({ payload }) => payload.type === 'turn_finished')
    ).toHaveLength(1)
    expect(emitted.at(-1)?.payload).toMatchObject({
      type: 'turn_finished',
      outcome: 'completed',
      metrics: { inputTokens: 10, outputTokens: 3 }
    })
  })

  it('captures relevant local visual evidence before provider planning starts', async () => {
    const order: string[] = []
    const journal = new FakeTurnJournal()
    const orchestrator = new TurnOrchestrator({
      journal,
      emit: () => {}
    })
    const conversation: ProviderTurnPort = {
      async *runTurn() {
        order.push('provider')
        yield { type: 'text_delta', text: 'done' }
      },
      async interrupt() {}
    }

    await orchestrator.submit(draft(), {
      ...runtime(conversation),
      classificationText: 'Improve the visual readability of the sheet.',
      async performPrePlanningInspection() {
        order.push('capture')
      }
    })

    expect(order).toEqual(['capture', 'provider'])
  })

  it('cancels promptly while pre-planning inspection is still pending', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const journal = new FakeTurnJournal()
    const emitted: PersistedTurnEventEnvelope[] = []
    const orchestrator = new TurnOrchestrator({
      journal,
      emit: (event) => emitted.push(event)
    })
    const running = orchestrator.submit(
      draft(),
      {
        ...runtime(new FakeConversation()),
        classificationText: 'Inspect the visual layout.',
        performPrePlanningInspection: () => gate
      }
    )
    await vi.waitFor(() => {
      expect(
        emitted.some(
          ({ payload }) => payload.type === 'instruction_breakdown'
        )
      ).toBe(true)
    })

    expect(orchestrator.cancel('turn-1', 'session-1')).toBe(true)
    await expect(running).resolves.toEqual({
      duplicate: false,
      outcome: 'cancelled'
    })
    expect(
      emitted.filter(({ payload }) => payload.type === 'turn_finished')
    ).toHaveLength(1)
    release()
  })

  it('turns provider failure into recovery plus one safe structured terminal', async () => {
    const journal = new FakeTurnJournal()
    const emitted: PersistedTurnEventEnvelope[] = []
    const orchestrator = new TurnOrchestrator({
      journal,
      emit: (event) => emitted.push(event)
    })

    await expect(
      orchestrator.submit(
        draft(),
        runtime(
          new FakeConversation(
            [{ type: 'text_delta', text: 'partial' }],
            new Error('private SDK transport detail')
          )
        )
      )
    ).resolves.toEqual({ duplicate: false, outcome: 'failed' })

    expect(
      emitted.filter(({ payload }) => payload.type === 'turn_finished')
    ).toHaveLength(1)
    expect(emitted.at(-1)?.payload).toMatchObject({
      type: 'turn_finished',
      outcome: 'failed',
      error: {
        kind: 'transient-provider',
        code: 'provider-turn-interrupted',
        retryable: true
      }
    })
    expect(JSON.stringify(emitted)).not.toContain('private SDK transport detail')
    expect(
      emitted.some(
        ({ payload }) =>
          payload.type === 'turn_progress' &&
          payload.phase === 'recovering'
      )
    ).toBe(true)
  })

  it('blocks a successful terminal while any CAD mutation status remains unresolved', async () => {
    const journal = new FakeTurnJournal()
    const emitted: PersistedTurnEventEnvelope[] = []
    const orchestrator = new TurnOrchestrator({
      journal,
      emit: (event) => emitted.push(event)
    })

    await expect(
      orchestrator.submit(draft(), {
        ...runtime(
          new FakeConversation([{ type: 'text_delta', text: 'Mutation sent.' }])
        ),
        unresolvedMutation: () => 'operation-uncertain-1'
      })
    ).resolves.toEqual({ duplicate: false, outcome: 'failed' })

    expect(emitted.at(-1)?.payload).toMatchObject({
      type: 'turn_finished',
      outcome: 'failed',
      error: {
        kind: 'unknown-operation',
        code: 'mutation-status-unresolved',
        retryable: false
      }
    })
    expect(
      emitted.filter(({ payload }) => payload.type === 'turn_finished')
    ).toHaveLength(1)
  })

  it('cancels a blocked provider turn without producing a second terminal', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const journal = new FakeTurnJournal()
    const emitted: PersistedTurnEventEnvelope[] = []
    const conversation = new FakeConversation([], undefined, gate)
    const orchestrator = new TurnOrchestrator({
      journal,
      emit: (event) => emitted.push(event)
    })
    const running = orchestrator.submit(draft(), runtime(conversation))
    await vi.waitFor(() => {
      expect(
        emitted.some(
          ({ payload }) =>
            payload.type === 'turn_progress' &&
            payload.phase === 'executing'
        )
      ).toBe(true)
    })

    expect(orchestrator.cancel('turn-1', 'session-1')).toBe(true)
    await expect(running).resolves.toEqual({
      duplicate: false,
      outcome: 'cancelled'
    })
    expect(conversation.interrupted).toBe(true)
    expect(emitted.at(-1)?.payload).toMatchObject({
      type: 'turn_finished',
      outcome: 'cancelled'
    })
    expect(
      emitted.filter(({ payload }) => payload.type === 'turn_finished')
    ).toHaveLength(1)
    release()
  })

  it('replays but never re-executes a duplicate durable submission', async () => {
    const journal = new FakeTurnJournal()
    const emitted: PersistedTurnEventEnvelope[] = []
    const orchestrator = new TurnOrchestrator({
      journal,
      emit: (event) => emitted.push(event)
    })
    await orchestrator.submit(
      draft(),
      runtime(new FakeConversation([{ type: 'text_delta', text: 'done' }]))
    )
    emitted.length = 0
    const duplicateConversation = new FakeConversation()
    const run = vi.spyOn(duplicateConversation, 'runTurn')

    await expect(
      orchestrator.submit(draft(), runtime(duplicateConversation))
    ).resolves.toEqual({ duplicate: true })

    expect(run).not.toHaveBeenCalled()
    expect(emitted).toEqual(journal.events)
  })
})
