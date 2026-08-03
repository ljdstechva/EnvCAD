import { describe, expect, it } from 'vitest'
import {
  turnFinishedSchema,
  type SkillActivation,
  type StructuredFailure,
  type WorkspaceRevision
} from '../../../shared/agent-contracts'
import { TurnStateMachine } from '../domain/turn/TurnStateMachine'

const revision = (contentRevision = 0): WorkspaceRevision => ({
  documentId: 'drawing-1',
  documentRevision: 1,
  contentRevision,
  sheetRevision: 0,
  viewRevision: 0
})

const metrics = {
  totalMs: 25,
  toolCalls: 0
}

const verifiedSkills = (): SkillActivation[] => [
  {
    skillId: 'cad-core',
    name: 'CAD Core',
    version: '1.0.0',
    integrity: 'verified',
    activatedAt: '2026-07-29T00:00:00.000Z'
  },
  {
    skillId: 'dxf-core',
    name: 'DXF Core',
    version: '1.0.0',
    integrity: 'verified',
    activatedAt: '2026-07-29T00:00:00.000Z'
  }
]

const failure: StructuredFailure = {
  kind: 'transient-provider',
  code: 'provider-stream-failed',
  userMessage: 'The provider connection ended before the response completed.',
  retryable: true,
  recoveryActions: []
}

describe('TurnStateMachine', () => {
  it('emits one valid terminal outcome after the normal lifecycle', () => {
    let now = 100
    const machine = new TurnStateMachine({
      turnId: 'turn-1',
      messageId: 'message-1',
      revision: revision(),
      activeSkills: verifiedSkills(),
      provider: 'openai-codex',
      startedAtMs: now,
      monotonicNow: () => now
    })

    expect(machine.accept('Accepted.')).toMatchObject({
      phase: 'accepted',
      elapsedMs: 0
    })
    now += 1
    machine.transition('ingesting', 'Preparing inputs.', {
      activeSkills: verifiedSkills()
    })
    machine.transition('briefing', 'Breaking down the instruction.')
    machine.transition('planning', 'Planning.', { provider: 'openai-codex' })
    machine.transition('inspecting', 'Inspecting the drawing.')
    machine.transition('executing', 'Executing the plan.')
    machine.transition('verifying', 'Verifying the result.', {
      revision: revision(1)
    })

    const finished = machine.finish('completed', 'Completed.', { metrics })
    expect(turnFinishedSchema.safeParse(finished).success).toBe(true)
    expect(finished.finalRevision.contentRevision).toBe(1)
    expect(finished.activeSkillIds).toEqual(['cad-core', 'dxf-core'])
    expect(finished.provider).toBe('openai-codex')
    expect(() =>
      machine.finish('completed', 'Completed twice.', { metrics })
    ).toThrow('terminal outcome')
  })

  it('requires structured details for failed and recovered outcomes', () => {
    const failed = new TurnStateMachine({
      turnId: 'turn-failed',
      messageId: 'message-failed',
      revision: revision(),
      activeSkills: verifiedSkills(),
      provider: 'openai-codex'
    })
    failed.accept('Accepted.')
    expect(() =>
      failed.finish('failed', 'Failed.', { metrics })
    ).toThrow('structured failure')

    const recovered = new TurnStateMachine({
      turnId: 'turn-recovered',
      messageId: 'message-recovered',
      revision: revision(),
      activeSkills: verifiedSkills(),
      provider: 'openai-codex'
    })
    recovered.accept('Accepted.')
    recovered.transition('ingesting', 'Preparing inputs.')
    recovered.transition('briefing', 'Breaking down the instruction.')
    recovered.transition('planning', 'Planning.')
    recovered.transition('inspecting', 'Inspecting.')
    recovered.transition('executing', 'Executing.')
    recovered.transition('recovering', 'Recovering.')
    recovered.transition('retrying', 'Retrying.')
    recovered.transition('executing', 'Executing again.')
    recovered.transition('verifying', 'Verifying.')
    expect(() =>
      recovered.finish('recovered', 'Recovered.', { metrics })
    ).toThrow('recovery summary')
  })

  it('supports cancellation and failure from any active phase', () => {
    const cancelled = new TurnStateMachine({
      turnId: 'turn-cancelled',
      messageId: 'message-cancelled',
      revision: revision(),
      activeSkills: verifiedSkills(),
      provider: 'openai-codex'
    })
    cancelled.accept('Accepted.')
    cancelled.transition('ingesting', 'Preparing inputs.')
    expect(
      cancelled.finish('cancelled', 'Cancelled.', { metrics }).phase
    ).toBe('cancelled')

    const failed = new TurnStateMachine({
      turnId: 'turn-error',
      messageId: 'message-error',
      revision: revision(),
      activeSkills: verifiedSkills(),
      provider: 'openai-codex'
    })
    failed.accept('Accepted.')
    const terminal = failed.finish('failed', 'Provider failed.', {
      metrics,
      error: failure
    })
    expect(terminal.error?.code).toBe('provider-stream-failed')
    expect(turnFinishedSchema.safeParse(terminal).success).toBe(true)
  })

  it('rejects skipped normal phases and transitions before acceptance', () => {
    const machine = new TurnStateMachine({
      turnId: 'turn-invalid',
      messageId: 'message-invalid',
      revision: revision(),
      activeSkills: verifiedSkills(),
      provider: 'openai-codex'
    })
    expect(() => machine.transition('planning', 'Planning.')).toThrow(
      'not active'
    )
    machine.accept('Accepted.')
    expect(() => machine.transition('planning', 'Planning.')).toThrow(
      'Invalid turn transition'
    )
    expect(() =>
      machine.finish('completed', 'Completed.', { metrics })
    ).toThrow('verifying phase')
    expect(() => machine.transition('degraded', 'Degraded.')).toThrow(
      'Invalid turn transition'
    )
  })

  it('requires mandatory skills before acceptance and permits degraded only via recovery', () => {
    expect(
      () =>
        new TurnStateMachine({
          turnId: 'turn-unskilled',
          messageId: 'message-unskilled',
          revision: revision(),
          activeSkills: verifiedSkills().slice(0, 1),
          provider: 'openai-codex'
        })
    ).toThrow('cad-core and dxf-core')
    expect(
      () =>
        new TurnStateMachine({
          turnId: 'turn-unverified',
          messageId: 'message-unverified',
          revision: revision(),
          activeSkills: verifiedSkills().map((skill) =>
            skill.skillId === 'dxf-core'
              ? { ...skill, integrity: 'failed' as const }
              : skill
          ),
          provider: 'openai-codex'
        })
    ).toThrow('integrity-verified')

    const machine = new TurnStateMachine({
      turnId: 'turn-degraded',
      messageId: 'message-degraded',
      revision: revision(),
      activeSkills: verifiedSkills(),
      provider: 'openai-codex'
    })
    const accepted = machine.accept('Accepted.')
    expect(accepted.activeSkillIds).toEqual(['cad-core', 'dxf-core'])
    expect(() =>
      machine.transition('ingesting', 'Preparing inputs.', {
        activeSkills: verifiedSkills().slice(0, 1)
      })
    ).toThrow('cannot remove mandatory')
    machine.transition('recovering', 'Recovering.')
    expect(machine.transition('degraded', 'Using database-only analysis.').phase).toBe(
      'degraded'
    )
  })

  it('leaves acceptance and progress exception-atomic', () => {
    const machine = new TurnStateMachine({
      turnId: 'turn-atomic-progress',
      messageId: 'message-atomic-progress',
      revision: revision(),
      activeSkills: verifiedSkills(),
      provider: 'openai-codex'
    })

    expect(() => machine.accept('   ')).toThrow('must not be blank')
    expect(machine.currentPhase).toBe('draft')
    machine.accept('Accepted.')

    expect(() =>
      machine.transition('ingesting', 'Invalid update.', {
        revision: {
          ...revision(9),
          contentRevision: -1
        },
        activeSkills: verifiedSkills().slice(0, 1)
      })
    ).toThrow()
    expect(machine.currentPhase).toBe('accepted')

    expect(() =>
      machine.transition('ingesting', '   ', {
        revision: revision(9)
      })
    ).toThrow('must not be blank')
    expect(machine.currentPhase).toBe('accepted')

    const event = machine.transition('ingesting', 'Preparing inputs.')
    expect(event.revision.contentRevision).toBe(0)
  })

  it('enforces monotonic revisions and explicit document replacement', () => {
    const machine = new TurnStateMachine({
      turnId: 'turn-revision-policy',
      messageId: 'message-revision-policy',
      revision: revision(3),
      activeSkills: verifiedSkills(),
      provider: 'openai-codex'
    })
    machine.accept('Accepted.')

    expect(() =>
      machine.transition('ingesting', 'Regressed.', {
        revision: revision(2)
      })
    ).toThrow('contentRevision cannot regress')
    expect(machine.currentPhase).toBe('accepted')

    const replacement = {
      ...revision(0),
      documentId: 'drawing-2',
      documentRevision: 2
    }
    expect(() =>
      machine.transition('ingesting', 'Unannounced replacement.', {
        revision: replacement
      })
    ).toThrow('explicit document-replaced')
    expect(machine.currentPhase).toBe('accepted')

    const event = machine.transition('ingesting', 'Document replaced.', {
      revision: replacement,
      revisionTransition: 'document-replaced'
    })
    expect(event.revisionTransition).toBe('document-replaced')
    expect(event.revision).toEqual(replacement)
  })

  it('does not strand a turn when terminal event construction fails', () => {
    const machine = new TurnStateMachine({
      turnId: 'turn-atomic-finish',
      messageId: 'message-atomic-finish',
      revision: revision(),
      activeSkills: verifiedSkills(),
      provider: 'openai-codex'
    })
    machine.accept('Accepted.')

    expect(() =>
      machine.finish('failed', '   ', {
        metrics,
        error: failure,
        revision: revision(4)
      })
    ).toThrow('must not be blank')
    expect(machine.currentPhase).toBe('accepted')
    expect(machine.finished).toBeUndefined()

    const terminal = machine.finish('failed', 'Provider failed.', {
      metrics,
      error: failure
    })
    expect(terminal.phase).toBe('failed')
    expect(terminal.finalRevision.contentRevision).toBe(0)
  })
})
