import type { SelectionContext, ToolResult } from '../../src/agent/protocol'

/**
 * What a CAD tool handler needs from its owning BridgeSession. Kept as a
 * narrow interface (rather than importing BridgeSession directly) so
 * cadTools.ts has no circular dependency on bridgeSession.ts.
 */
export interface ToolBridge {
  /** Forward a tool call to the browser and await its result (or timeout). */
  callTool(name: string, input: unknown): Promise<ToolResult>
  /** Browser-local selection metadata attached to the current turn; exact IDs are not present. */
  getSelectionSnapshot(): SelectionContext | undefined
}
