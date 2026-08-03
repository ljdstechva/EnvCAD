import { describe, expect, it } from 'vitest'
import {
  AGENT_PROTOCOL_VERSION,
  CAD_TOOL_MANIFEST,
  MAX_INPUT_CHUNK_BASE64_CHARACTERS,
  getEffectiveToolPolicy,
  parseAgentClientEnvelope,
  parseAgentServerEnvelope,
  turnFinishedSchema,
  workspaceRevisionSchema
} from '../../../shared/agent-contracts'

const revision = {
  documentId: 'drawing-1',
  documentRevision: 1,
  contentRevision: 2,
  sheetRevision: 3,
  viewRevision: 4
}

const envelope = (payload: unknown, turnId?: string) => ({
  protocolVersion: AGENT_PROTOCOL_VERSION,
  sessionId: 'session-1',
  messageId: 'message-1',
  ...(turnId ? { turnId } : {}),
  sequence: 1,
  timestamp: '2026-07-29T07:00:00.000Z',
  payload
})

describe('protocol v2 contracts', () => {
  it('strictly parses a complete submit-turn envelope', () => {
    const parsed = parseAgentClientEnvelope(
      envelope(
        {
          type: 'submit_turn',
          text: 'Move the selected entities east.',
          referenceInputIds: [],
          configurationRevision: 1,
          selectionSnapshot: {
            count: 2,
            units: 'Meters',
            revision
          },
          sheet: {
            paper: 'A3',
            orientation: 'landscape',
            scaleDenominator: 500,
            drawingUnit: 'm'
          }
        },
        'turn-client-1'
      )
    )

    expect(parsed.ok).toBe(true)
  })

  it('rejects unknown fields and incomplete workspace revisions', () => {
    expect(
      parseAgentClientEnvelope({
        ...envelope({
          type: 'cancel_turn',
          turnId: 'turn-1',
          unexpected: true
        })
      }).ok
    ).toBe(false)
    expect(
      workspaceRevisionSchema.safeParse({
        documentId: 'drawing-1',
        documentRevision: 1,
        contentRevision: 2
      }).success
    ).toBe(false)
    expect(
      workspaceRevisionSchema.safeParse({ ...revision, unexpected: true }).success
    ).toBe(false)
  })

  it('enforces terminal outcome invariants', () => {
    const base = {
      type: 'turn_finished' as const,
      turnId: 'turn-1',
      phase: 'failed' as const,
      outcome: 'failed' as const,
      revision,
      revisionTransition: 'same-document' as const,
      finalRevision: revision,
      activeSkillIds: ['cad-core', 'dxf-core'],
      provider: 'openai-codex',
      elapsedMs: 25,
      status: 'Failed.',
      metrics: { totalMs: 25, toolCalls: 0 }
    }
    expect(turnFinishedSchema.safeParse(base).success).toBe(false)
    expect(
      turnFinishedSchema.safeParse({
        ...base,
        error: {
          kind: 'transient-provider',
          code: 'provider-failed',
          userMessage: 'The provider failed.',
          retryable: true,
          recoveryActions: []
        }
      }).success
    ).toBe(true)
    expect(
      turnFinishedSchema.safeParse({
        ...base,
        phase: 'completed',
        outcome: 'recovered',
        error: undefined
      }).success
    ).toBe(false)
    expect(
      turnFinishedSchema.safeParse({
        ...base,
        phase: 'completed',
        outcome: 'completed',
        error: {
          kind: 'transient-provider',
          code: 'provider-failed',
          userMessage: 'The provider failed.',
          retryable: true,
          recoveryActions: []
        }
      }).success
    ).toBe(false)
  })

  it('strictly parses server envelopes and deep-freezes tool policy arrays', () => {
    const parsed = parseAgentServerEnvelope(
      envelope({
        type: 'turn_accepted',
        turnId: 'turn-1',
        messageId: 'message-1',
        phase: 'accepted',
        revision,
        revisionTransition: 'same-document',
        activeSkillIds: ['cad-core', 'dxf-core'],
        provider: 'openai-codex',
        elapsedMs: 2,
        status: 'Accepted.'
      }, 'turn-1')
    )
    expect(parsed.ok).toBe(true)

    const first = CAD_TOOL_MANIFEST[0]
    expect(Object.isFrozen(CAD_TOOL_MANIFEST)).toBe(true)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.requiredSkills)).toBe(true)
    expect(Object.isFrozen(first.requiredCapabilities)).toBe(true)
    const conditional = CAD_TOOL_MANIFEST.find(
      (entry) => entry.name === 'measure_clearance'
    )
    expect(Object.isFrozen(conditional?.conditionalPolicy)).toBe(true)
    expect(Object.isFrozen(conditional?.conditionalPolicy?.otherwise)).toBe(true)
    expect(
      Object.isFrozen(
        conditional?.conditionalPolicy?.otherwise.requiredCapabilities
      )
    ).toBe(true)
    expect(
      getEffectiveToolPolicy('measure_clearance', { draw: false })
    ).toMatchObject({
      mutability: 'read',
      retrySafety: 'safe',
      requiredCapabilities: ['cad.read'],
      undoBehavior: 'none'
    })
    expect(
      getEffectiveToolPolicy('measure_clearance', { draw: true })
    ).toMatchObject({
      mutability: 'write',
      retrySafety: 'idempotent-required',
      requiredCapabilities: ['cad.write'],
      undoBehavior: 'single-step'
    })
  })

  it('rejects envelope and payload turn IDs that do not match', () => {
    expect(
      parseAgentClientEnvelope(
        envelope(
          {
            type: 'cancel_turn',
            turnId: 'turn-payload'
          },
          'turn-envelope'
        )
      ).ok
    ).toBe(false)
  })

  it('requires idempotency metadata for mutating tool calls only', () => {
    const writeCall = {
      type: 'tool_call',
      turnId: 'turn-1',
      callId: 'call-1',
      name: 'draw_line',
      input: {
        start: { x: 0, y: 0 },
        end: { x: 10, y: 0 }
      }
    }
    expect(parseAgentServerEnvelope(envelope(writeCall, 'turn-1')).ok).toBe(
      false
    )
    expect(
      parseAgentServerEnvelope(
        envelope(
          {
            ...writeCall,
            operation: {
              turnId: 'turn-1',
              operationId: 'operation-1',
              operationGroupId: 'group-1',
              idempotencyKey: 'idempotency-1',
              toolName: 'draw_line',
              argumentsHash: 'a'.repeat(64),
              expectedRevision: revision,
              deadline: '2026-07-29T07:01:00.000Z'
            }
          },
          'turn-1'
        )
      ).ok
    ).toBe(true)

    expect(
      parseAgentServerEnvelope(
        envelope(
          {
            ...writeCall,
            name: 'get_drawing_context',
            input: {},
            operation: {
              turnId: 'turn-1',
              operationId: 'operation-1',
              operationGroupId: 'group-1',
              idempotencyKey: 'idempotency-1',
              toolName: 'get_drawing_context',
              argumentsHash: 'a'.repeat(64),
              expectedRevision: revision,
              deadline: '2026-07-29T07:01:00.000Z'
            }
          },
          'turn-1'
        )
      ).ok
    ).toBe(false)

    expect(
      parseAgentServerEnvelope(
        envelope(
          {
            ...writeCall,
            name: 'measure_clearance',
            input: {
              sourceEntityIds: ['line-1'],
              targetEntityIds: ['line-2'],
              draw: false
            }
          },
          'turn-1'
        )
      ).ok
    ).toBe(true)
    expect(
      parseAgentServerEnvelope(
        envelope(
          {
            ...writeCall,
            name: 'measure_clearance',
            input: {
              sourceEntityIds: ['line-1'],
              targetEntityIds: ['line-2'],
              draw: true
            }
          },
          'turn-1'
        )
      ).ok
    ).toBe(false)
  })

  it('enforces each tool manifest UTF-8 input limit', () => {
    const parsed = parseAgentServerEnvelope(
      envelope(
        {
          type: 'tool_call',
          turnId: 'turn-1',
          callId: 'call-oversized-read',
          name: 'list_entities',
          input: { textContains: '界'.repeat(9_000) }
        },
        'turn-1'
      )
    )

    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.developerMessage).toContain('24000 UTF-8 byte limit')
    }
  })

  it('bounds long-input declarations and canonical decoded chunks', () => {
    const begin = {
      type: 'input_begin',
      inputId: 'input-1',
      mediaType: 'text/plain',
      declaredByteLength: 100 * 1024 * 1024
    }
    expect(parseAgentClientEnvelope(envelope(begin)).ok).toBe(true)
    expect(
      parseAgentClientEnvelope(
        envelope({
          ...begin,
          declaredByteLength: 257 * 1024 * 1024
        })
      ).ok
    ).toBe(false)
    expect(
      parseAgentClientEnvelope(
        envelope({
          type: 'input_chunk',
          inputId: 'input-1',
          chunkIndex: 0,
          bytesBase64: 'SGVsbG8=',
          sha256: 'a'.repeat(64)
        })
      ).ok
    ).toBe(true)
    expect(
      parseAgentClientEnvelope(
        envelope({
          type: 'input_chunk',
          inputId: 'input-1',
          chunkIndex: 0,
          bytesBase64: 'not-base64',
          sha256: 'a'.repeat(64)
        })
      ).ok
    ).toBe(false)
    expect(
      parseAgentClientEnvelope(
        envelope({
          type: 'input_chunk',
          inputId: 'input-1',
          chunkIndex: 0,
          bytesBase64: 'A'.repeat(MAX_INPUT_CHUNK_BASE64_CHARACTERS),
          sha256: 'a'.repeat(64)
        })
      ).ok
    ).toBe(false)
  })

  it('models operation reconciliation as a sidecar request and strict renderer response', () => {
    expect(
      parseAgentServerEnvelope(
        envelope(
          {
            type: 'get_operation_status',
            turnId: 'turn-1',
            requestId: 'status-1',
            operationId: 'operation-1'
          },
          'turn-1'
        )
      ).ok
    ).toBe(true)

    expect(
      parseAgentClientEnvelope(
        envelope(
          {
            type: 'operation_status',
            turnId: 'turn-1',
            requestId: 'status-1',
            result: { operationId: 'operation-1' }
          },
          'turn-1'
        )
      ).ok
    ).toBe(true)
    expect(
      parseAgentClientEnvelope(
        envelope(
          {
            type: 'tool_result',
            turnId: 'turn-1',
            callId: 'call-1',
            result: { error: 'raw legacy error' }
          },
          'turn-1'
        )
      ).ok
    ).toBe(false)
  })
})
