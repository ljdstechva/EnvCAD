import type { ToolResult } from '../../src/agent/protocol'
import {
  CAD_TOOL_SPECS,
  executeCadTool,
  type CadToolBridge,
  type CadToolSpec
} from './cadToolSpecs'
import {
  INPUT_TOOL_NAMES,
  INPUT_TOOL_SPECS,
  getInputToolSpec,
  type InputToolSpec
} from './inputToolSpecs'

export type ProviderToolSpec = CadToolSpec | InputToolSpec

export const PROVIDER_TOOL_SPECS: readonly ProviderToolSpec[] = Object.freeze([
  ...CAD_TOOL_SPECS,
  ...INPUT_TOOL_SPECS
])

export const PROVIDER_TOOL_NAMES = Object.freeze([
  ...CAD_TOOL_SPECS.map((spec) => spec.name),
  ...INPUT_TOOL_NAMES
])

export async function executeProviderTool(
  bridge: CadToolBridge,
  name: string,
  input: unknown
): Promise<ToolResult> {
  const inputSpec = getInputToolSpec(name)
  return inputSpec
    ? inputSpec.execute(bridge, input)
    : executeCadTool(bridge, name, input)
}
