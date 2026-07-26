import { describe, expect, it } from 'vitest'
import { parseClientMessage, parseServerMessage } from '../protocol'

const validUserMessage = {
  type: 'user_message',
  text: 'draw a line',
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
      error: 'error.message must be a non-empty string'
    })
  })
})
