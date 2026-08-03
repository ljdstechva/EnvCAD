import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { ToolResult } from '../../src/agent/protocol'
import {
  cadToolMayMutate,
  compactMutationResultText,
  maximumProviderToolOutputBytes,
  utf8ByteLength,
  type CadToolBridge
} from './cadToolSpecs'
import { PROVIDER_TOOL_SPECS } from './providerToolSpecs'

interface ForwardedCallToolResult {
  [key: string]: unknown
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: 'image/png' | 'image/webp' }
  >
  isError?: boolean
}

export function toClaudeCallToolResult(
  result: ToolResult,
  toolName?: string,
  input?: unknown
): ForwardedCallToolResult {
  if (result.error) {
    return { content: [{ type: 'text', text: result.error }], isError: true }
  }
  const text =
    typeof result.data === 'string'
      ? result.data
      : JSON.stringify(result.data ?? null)
  if (utf8ByteLength(text) > maximumProviderToolOutputBytes(toolName)) {
    if (toolName && cadToolMayMutate(toolName, input)) {
      return {
        content: [{ type: 'text', text: compactMutationResultText(result) }]
      }
    }
    return {
      content: [
        {
          type: 'text',
          text:
            'CAD tool metadata exceeded its bounded page size. Retry the read with its continuation cursor.'
        }
      ],
      isError: true
    }
  }
  if (!result.image) return { content: [{ type: 'text', text }] }
  if (
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
  onVisualResult?: (result: ToolResult) => void | Promise<void>
) {
  const permitted = bridge.permittedToolNames?.()
  const permittedNames = permitted ? new Set(permitted) : undefined
  const server = createSdkMcpServer({
    name: 'cad',
    version: '2.0.0',
    tools: []
  })
  for (const spec of PROVIDER_TOOL_SPECS) {
    if (permittedNames && !permittedNames.has(spec.name)) continue
    server.instance.registerTool(
      spec.name,
      {
        description: spec.description,
        inputSchema: spec.inputSchema
      },
      async (input) => {
        const result = await spec.execute(bridge, input)
        const forwarded = toClaudeCallToolResult(result, spec.name, input)
        if (result.image && !forwarded.isError) {
          await onVisualResult?.(result)
        }
        return forwarded
      }
    )
  }
  return server
}
