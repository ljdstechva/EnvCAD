import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { ToolResult } from '../../src/agent/protocol'
import {
  CAD_TOOL_SPECS,
  type CadToolBridge
} from './cadToolSpecs'

interface ForwardedCallToolResult {
  [key: string]: unknown
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function toCallToolResult(result: ToolResult): ForwardedCallToolResult {
  if (result.error) {
    return { content: [{ type: 'text', text: result.error }], isError: true }
  }
  const text =
    typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? null, null, 2)
  return { content: [{ type: 'text', text }] }
}

/**
 * Claude registration generated from the same provider-neutral catalog used
 * by Codex dynamic tools and wire-protocol validation.
 */
export function createCadMcpServer(
  bridge: CadToolBridge,
  onToolFailure?: (error: Error) => void
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
        return toCallToolResult(result)
      }
    )
  }
  return server
}
