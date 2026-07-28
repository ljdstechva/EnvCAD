import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CAD_TOOL_NAMES } from '../cadToolSpecs'
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
      ...CAD_TOOL_NAMES
    ])
    expect(registerTool.mock.calls.map(([name]) => name)).toContain(
      'inspect_sheet_preview'
    )
  })

  it('returns bounded metadata and a separate MCP image content block', () => {
    const result = visualResult()
    const forwarded = toClaudeCallToolResult(result)

    expect(forwarded).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(result.data, null, 2)
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
          text: JSON.stringify({ entityIds: ['line-1'] }, null, 2)
        }
      ]
    })
    expect(toClaudeCallToolResult({ error: 'render failed' })).toEqual({
      content: [{ type: 'text', text: 'render failed' }],
      isError: true
    })
  })
})
