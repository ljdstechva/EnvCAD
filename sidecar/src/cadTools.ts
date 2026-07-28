import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { ToolResult } from '../../src/agent/protocol'
import {
  CAD_TOOL_SPECS,
  type CadToolBridge
} from './cadToolSpecs'

interface ForwardedCallToolResult {
  [key: string]: unknown
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: 'image/png' | 'image/webp' }
  >
  isError?: boolean
}

const MAX_VISUAL_METADATA_CHARACTERS = 32_000

export function toClaudeCallToolResult(
  result: ToolResult
): ForwardedCallToolResult {
  if (result.error) {
    return { content: [{ type: 'text', text: result.error }], isError: true }
  }
  const text =
    typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? null, null, 2)
  if (!result.image) return { content: [{ type: 'text', text }] }
  if (
    text.length > MAX_VISUAL_METADATA_CHARACTERS ||
    text.includes(result.image.base64)
  ) {
    return {
      content: [
        {
          type: 'text',
          text: 'Sheet Preview metadata was unsafe or too large to send.'
        }
      ],
      isError: true
    }
  }
  return {
    content: [
      { type: 'text', text },
      {
        type: 'image',
        data: result.image.base64,
        mimeType: result.image.mimeType
      }
    ]
  }
}

/**
 * Claude registration generated from the same provider-neutral catalog used
 * by Codex dynamic tools and wire-protocol validation.
 */
export function createCadMcpServer(
  bridge: CadToolBridge,
  onToolFailure?: (error: Error) => void,
  onVisualResult?: (result: ToolResult) => void | Promise<void>
) {
  const server = createSdkMcpServer({
    name: 'cad',
    version: '2.0.0',
    tools: []
  })
  for (const spec of CAD_TOOL_SPECS) {
    server.instance.registerTool(
      spec.name,
      {
        description: spec.description,
        inputSchema: spec.inputSchema
      },
      async (input) => {
        const result = await spec.execute(bridge, input)
        if (result.error) {
          onToolFailure?.(
            new Error(`Claude CAD tool ${spec.name} failed: ${result.error}`)
          )
        }
        const forwarded = toClaudeCallToolResult(result)
        if (result.image && !forwarded.isError) {
          await onVisualResult?.(result)
        }
        return forwarded
      }
    )
  }
  return server
}
