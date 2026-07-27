import { describe, expect, it } from 'vitest'
import { parseClientMessage, parseServerMessage } from '../protocol'

const validUserMessage = {
  type: 'user_message',
  text: 'draw a line',
  configurationRevision: 1,
  selectionSnapshot: {
    ids: ['entity-1'],
    count: 1,
    units: 'Millimeters'
  },
  sheet: {
    paper: 'A3',
    orientation: 'landscape',
    scaleDenominator: 500,
    drawingUnit: 'm',
    templateId: 'site-plan',
    fields: { PROJECT: 'Protocol test' }
  }
}

describe('agent protocol validation', () => {
  it('accepts a complete user_message', () => {
    expect(parseClientMessage(validUserMessage)).toEqual({
      ok: true,
      value: validUserMessage
    })
  })

  it('rejects a selection count that does not match its ids', () => {
    const parsed = parseClientMessage({
      ...validUserMessage,
      selectionSnapshot: { ...validUserMessage.selectionSnapshot, count: 2 }
    })

    expect(parsed).toEqual({
      ok: false,
      error: 'selectionSnapshot.count must equal selectionSnapshot.ids.length'
    })
  })

  it('requires a tool result to contain exactly one outcome', () => {
    expect(
      parseClientMessage({
        type: 'tool_result',
        callId: 'call-1',
        result: { data: { entityId: 'line-1' }, error: 'conflicting result' }
      })
    ).toEqual({
      ok: false,
      error: 'tool_result.result must contain exactly one of data or error'
    })
  })

  it('rejects unknown client message types', () => {
    expect(parseClientMessage({ type: 'run_shell', command: 'whoami' })).toEqual({
      ok: false,
      error: 'unsupported client message type: run_shell'
    })
  })

  it('accepts only registered CAD tool calls from the sidecar', () => {
    expect(
      parseServerMessage({
        type: 'tool_call',
        callId: 'call-1',
        name: 'draw_line',
        input: { start: { x: 0, y: 0 }, end: { x: 20, y: 0 } }
      }).ok
    ).toBe(true)

    expect(
      parseServerMessage({
        type: 'tool_call',
        callId: 'call-2',
        name: 'execute_code',
        input: {}
      })
    ).toEqual({
      ok: false,
      error: 'tool_call.name is not a registered CAD tool: execute_code'
    })
  })

  it('rejects invalid sidecar status and error messages', () => {
    expect(parseServerMessage({ type: 'status', state: 'busy' })).toEqual({
      ok: false,
      error: 'status.state must be "thinking" or "idle"'
    })
    expect(parseServerMessage({ type: 'error', message: '' })).toEqual({
      ok: false,
      error: 'error.message must be a bounded non-empty string'
    })
  })

  it('validates configuration revisions and supported provider ids', () => {
    expect(parseClientMessage({ type: 'reset' })).toEqual({
      ok: false,
      error: 'reset.revision must be a positive safe integer'
    })
    expect(parseClientMessage({ type: 'reset', revision: 0 })).toEqual({
      ok: false,
      error: 'reset.revision must be a positive safe integer'
    })
    expect(parseClientMessage({ type: 'reset', revision: 3 })).toEqual({
      ok: true,
      value: { type: 'reset', revision: 3 }
    })
    expect(
      parseClientMessage({
        type: 'set_ai_configuration',
        revision: 0,
        configuration: {
          provider: 'claude-code',
          model: 'default'
        }
      })
    ).toEqual({
      ok: false,
      error:
        'set_ai_configuration.revision must be a positive safe integer'
    })
    expect(
      parseClientMessage({
        type: 'set_ai_configuration',
        revision: 2,
        configuration: {
          provider: 'other-provider',
          model: 'default'
        }
      })
    ).toEqual({
      ok: false,
      error:
        'configuration.provider is unsupported: other-provider'
    })
  })

  it('validates capability defaults and completion metrics', () => {
    const capability = {
      id: 'openai-codex',
      displayName: 'OpenAI Codex',
      status: 'ready',
      statusMessage: 'Ready',
      models: [
        {
          id: 'gpt-test',
          invocationName: 'gpt-test',
          displayName: 'GPT Test',
          description: 'Test model',
          supportedEfforts: [
            {
              value: 'low',
              displayName: 'Low',
              isDefault: true
            }
          ],
          defaultEffort: 'low',
          isDefault: true
        }
      ]
    }
    expect(
      parseServerMessage({
        type: 'ai_capabilities',
        providers: [capability],
        refreshing: false
      }).ok
    ).toBe(true)
    expect(
      parseServerMessage({
        type: 'ai_capabilities',
        providers: [capability]
      })
    ).toEqual({
      ok: false,
      error: 'ai_capabilities.refreshing must be a boolean'
    })
    expect(
      parseServerMessage({
        type: 'assistant_done',
        provider: 'openai-codex',
        model: 'gpt-test',
        effort: 'low',
        metrics: { totalMs: -1, toolCalls: 1 }
      })
    ).toEqual({
      ok: false,
      error:
        'assistant_done.metrics.totalMs must be a non-negative finite number'
    })
    expect(
      parseServerMessage({
        type: 'ai_capabilities',
        providers: [
          {
            ...capability,
            models: [
              {
                ...capability.models[0],
                supportedEfforts: [
                  {
                    value: 'ultra',
                    displayName: 'Ultra',
                    isDefault: true
                  }
                ],
                defaultEffort: 'ultra'
              }
            ]
          }
        ],
        refreshing: false
      })
    ).toEqual({
      ok: false,
      error:
        'effort capability "ultra" is disabled because EnvCAD does not permit subagents'
    })
  })

  it('rejects unexpected fields instead of silently widening the IPC surface', () => {
    expect(
      parseClientMessage({
        ...validUserMessage,
        command: 'whoami'
      })
    ).toEqual({
      ok: false,
      error: 'user_message contains unsupported fields'
    })
  })
})
