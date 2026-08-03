import { describe, expect, it } from 'vitest'
import {
  MAX_TOOL_IMAGE_BYTES,
  modelImageInputSupport,
  parseClientMessage,
  parseServerMessage,
  type ModelCapability,
  type ProviderCapability,
  validateToolResultForTool
} from '../protocol'

const onePixelPng =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII='
const onePixelPngSha256 =
  '98884e721ec2f605f3788f2bc39a61de305ff4f4fcaf26b6f4eabeebcd6c0fb4'

function validImage() {
  return {
    mimeType: 'image/png',
    base64: onePixelPng,
    byteLength: Buffer.from(onePixelPng, 'base64').byteLength,
    width: 1,
    height: 1,
    aspectRatio: 1,
    sha256: onePixelPngSha256,
    captureId: 'sheet-1-full-0000000000000000',
    renderRevision: 1
  }
}

const validUserMessage = {
  type: 'user_message',
  text: 'draw a line',
  configurationRevision: 1,
  selectionSnapshot: {
    count: 1,
    units: 'Millimeters',
    revision: {
      documentRevision: 4,
      contentRevision: 2
    }
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

  it.each([4_000, 4_001, 16_000, 250_000])(
    'accepts an exact %i-character user prompt without rewriting it',
    (length) => {
      const prefix = 'BEGIN-'
      const suffix = '-END-🧪'
      const text = `${prefix}${'x'.repeat(
        length - prefix.length - suffix.length
      )}${suffix}`
      expect(text).toHaveLength(length)
      const parsed = parseClientMessage({ ...validUserMessage, text })

      expect(parsed).toEqual({
        ok: true,
        value: { ...validUserMessage, text }
      })
      if (parsed.ok && parsed.value.type === 'user_message') {
        expect(parsed.value.text).toBe(text)
      }
    }
  )

  it('preserves multiline Unicode and rejects empty or whitespace-only prompts', () => {
    const text = '  first line\r\nikalawang linya 🌏\nfinal line  '
    expect(parseClientMessage({ ...validUserMessage, text })).toEqual({
      ok: true,
      value: { ...validUserMessage, text }
    })
    for (const invalid of ['', ' \t\r\n ']) {
      expect(
        parseClientMessage({ ...validUserMessage, text: invalid })
      ).toEqual({
        ok: false,
        error:
          'user_message.text must contain at least one non-whitespace character'
      })
    }
  })

  it('keeps exact selection ids out of the WebSocket message', () => {
    const parsed = parseClientMessage({
      ...validUserMessage,
      selectionSnapshot: {
        ...validUserMessage.selectionSnapshot,
        ids: ['entity-1']
      }
    })

    expect(parsed).toEqual({
      ok: false,
      error: 'selectionSnapshot contains unsupported fields'
    })
  })

  it('requires a valid drawing revision on selection context', () => {
    const parsed = parseClientMessage({
      ...validUserMessage,
      selectionSnapshot: {
        count: 1,
        units: 'Millimeters',
        revision: {
          documentRevision: -1,
          contentRevision: 2
        }
      }
    })

    expect(parsed).toEqual({
      ok: false,
      error:
        'selectionSnapshot.revision.documentRevision must be a non-negative safe integer'
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

  it('accepts one validated image only for inspect_sheet_preview', () => {
    const result = { data: { view: 'full' }, image: validImage() }
    expect(
      parseClientMessage({
        type: 'tool_result',
        callId: 'visual-1',
        result
      })
    ).toEqual({
      ok: true,
      value: {
        type: 'tool_result',
        callId: 'visual-1',
        result
      }
    })
    expect(validateToolResultForTool('inspect_sheet_preview', result)).toEqual({
      ok: true,
      value: result
    })
    expect(validateToolResultForTool('get_view_status', result)).toEqual({
      ok: false,
      error: 'CAD tool "get_view_status" is not allowed to return an image'
    })
  })

  it.each([
    ['malformed Base64', { ...validImage(), base64: 'AB==' }],
    ['unsupported MIME', { ...validImage(), mimeType: 'image/jpeg' }],
    ['spoofed MIME', { ...validImage(), base64: Buffer.from('not a png').toString('base64') }],
    ['mismatched dimensions', { ...validImage(), width: 2, aspectRatio: 2 }],
    ['zero dimension', { ...validImage(), width: 0, aspectRatio: 0 }],
    ['arbitrary path', { ...validImage(), path: 'C:\\secret.png' }],
    ['arbitrary URL', { ...validImage(), url: 'https://example.com/preview.png' }]
  ])('rejects a %s image payload', (_label, image) => {
    expect(
      parseClientMessage({
        type: 'tool_result',
        callId: 'visual-invalid',
        result: { data: {}, image }
      }).ok
    ).toBe(false)
  })

  it('rejects oversized, multiple, missing, and error-conflicting images', () => {
    const oversizedBase64 = 'A'.repeat(
      Math.ceil((MAX_TOOL_IMAGE_BYTES + 1) / 3) * 4
    )
    expect(
      parseClientMessage({
        type: 'tool_result',
        callId: 'visual-oversized',
        result: {
          data: {},
          image: {
            ...validImage(),
            base64: oversizedBase64,
            byteLength: MAX_TOOL_IMAGE_BYTES + 1
          }
        }
      }).ok
    ).toBe(false)
    expect(
      parseClientMessage({
        type: 'tool_result',
        callId: 'visual-multiple',
        result: { data: {}, image: validImage(), images: [validImage()] }
      }).ok
    ).toBe(false)
    expect(
      validateToolResultForTool('inspect_sheet_preview', { data: {} })
    ).toEqual({
      ok: false,
      error: 'CAD tool "inspect_sheet_preview" returned no image'
    })
    expect(
      parseClientMessage({
        type: 'tool_result',
        callId: 'visual-conflict',
        result: { error: 'failed', image: validImage() }
      }).ok
    ).toBe(false)
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
    const capability: ProviderCapability = {
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
    const visualCapability: ModelCapability = {
      ...capability.models[0],
      inputModalities: ['text', 'image']
    }
    expect(modelImageInputSupport(visualCapability)).toBe('supported')
    expect(
      modelImageInputSupport({
        ...capability.models[0],
        inputModalities: ['text']
      })
    ).toBe('unsupported')
    expect(modelImageInputSupport(capability.models[0])).toBe('unknown')
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
