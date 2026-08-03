import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PROVIDER_TOOL_NAMES } from '../providerToolSpecs'
import {
  createCadMcpServer,
  toClaudeCallToolResult
} from '../cadTools'

const { registerTool } = vi.hoisted(() => ({ registerTool: vi.fn() }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn(() => ({
    instance: { registerTool }
  }))
}))

function visualResult() {
  return {
    data: {
      kind: 'sheet-preview',
      image: { width: 1_400, height: 990, sha256: 'a'.repeat(64) }
    },
    image: {
      mimeType: 'image/png' as const,
      base64: 'iVBORw0KGgo=',
      byteLength: 8,
      width: 1_400,
      height: 990,
      aspectRatio: 1_400 / 990,
      sha256: 'a'.repeat(64),
      captureId: 'sheet-1-full-aaaaaaaaaaaaaaaa',
      renderRevision: 1
    }
  }
}

describe('Claude CAD MCP tools', () => {
  beforeEach(() => registerTool.mockClear())

  it('registers the exact provider-neutral CAD catalog including visual inspection', () => {
    createCadMcpServer({
      callTool: vi.fn(),
      getSelectionSnapshot: vi.fn()
    })

    expect(registerTool.mock.calls.map(([name]) => name)).toEqual([
      ...PROVIDER_TOOL_NAMES
    ])
    expect(registerTool.mock.calls.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        'inspect_sheet_preview',
        'inspect_model_view',
        'inspect_region',
        'inspect_selection',
        'compare_before_after',
        'render_analysis_overlay'
      ])
    )
  })

  it('registers only the broker-permitted tools for an intent-scoped turn', () => {
    createCadMcpServer({
      callTool: vi.fn(),
      getSelectionSnapshot: vi.fn(),
      permittedToolNames: () => ['list_entities', 'inspect_sheet_preview']
    })

    expect(registerTool.mock.calls.map(([name]) => name)).toEqual([
      'list_entities',
      'inspect_sheet_preview'
    ])
  })

  it('returns bounded metadata and a separate MCP image content block', () => {
    const result = visualResult()
    const forwarded = toClaudeCallToolResult(result)

    expect(forwarded).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(result.data)
        },
        {
          type: 'image',
          data: result.image.base64,
          mimeType: 'image/png'
        }
      ]
    })
    expect((forwarded.content[0] as { text: string }).text).not.toContain(
      result.image.base64
    )
  })

  it('keeps ordinary CAD tools text-only and tool errors mutually exclusive', () => {
    expect(toClaudeCallToolResult({ data: { entityIds: ['line-1'] } })).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ entityIds: ['line-1'] })
        }
      ]
    })
    expect(toClaudeCallToolResult({ error: 'render failed' })).toEqual({
      content: [{ type: 'text', text: 'render failed' }],
      isError: true
    })
  })

  it('fails closed before forwarding oversized ordinary CAD metadata', () => {
    const forwarded = toClaudeCallToolResult({
      data: { content: 'x'.repeat(32_001) }
    })

    expect(forwarded).toEqual({
      content: [
        {
          type: 'text',
          text:
            'CAD tool metadata exceeded its bounded page size. Retry the read with its continuation cursor.'
        }
      ],
      isError: true
    })
    expect(JSON.stringify(forwarded)).not.toContain('x'.repeat(1_000))
  })

  it('enforces canonical output limits in UTF-8 bytes', () => {
    const content = 'é'.repeat(16_000)
    expect(JSON.stringify({ content }).length).toBeLessThan(32_000)

    const forwarded = toClaudeCallToolResult(
      { data: { content } },
      'list_entities'
    )
    expect(forwarded.isError).toBe(true)
    expect(JSON.stringify(forwarded)).not.toContain(content.slice(0, 1_000))
  })

  it('never converts an oversized successful mutation into a provider failure', () => {
    const forwarded = toClaudeCallToolResult(
      {
        data: {
          entityIds: ['line-1'],
          unexpectedMetadata: 'x'.repeat(32_001)
        }
      },
      'move_entities',
      { entityIds: ['line-1'], dx: 1, dy: 0 }
    )
    const metadata = JSON.parse(
      (forwarded.content[0] as { type: 'text'; text: string }).text
    )

    expect(forwarded.isError).toBeUndefined()
    expect(metadata).toMatchObject({
      mutationSucceeded: true,
      metadataCompacted: true,
      affectedEntityCount: 1,
      entityIdsPreview: ['line-1']
    })
    expect(JSON.stringify(forwarded)).not.toContain('x'.repeat(1_000))
  })
})
