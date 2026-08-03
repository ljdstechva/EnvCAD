import { z } from 'zod'
import type { ToolResult } from '../../src/agent/protocol'
import type { CadToolBridge } from './cadToolSpecs'
import { MAX_INPUT_RANGE_BYTES } from './application/input/InputRetrievalService'

export const INPUT_TOOL_NAMES = [
  'get_input_metadata',
  'get_input_outline',
  'search_input',
  'read_input_chunk',
  'read_input_range'
] as const

export type InputToolName = (typeof INPUT_TOOL_NAMES)[number]

export interface InputToolSpec {
  name: InputToolName
  description: string
  inputSchema: z.ZodObject
  jsonSchema: Record<string, unknown>
  timeoutMs: number
  maximumOutputBytes: number
  execute(bridge: CadToolBridge, input: unknown): Promise<ToolResult>
}

function defineInputTool(
  name: InputToolName,
  description: string,
  inputSchema: z.ZodObject
): InputToolSpec {
  return Object.freeze({
    name,
    description,
    inputSchema,
    jsonSchema: z.toJSONSchema(inputSchema, {
      target: 'draft-07',
      io: 'input',
      reused: 'inline'
    }) as Record<string, unknown>,
    timeoutMs: 30_000,
    maximumOutputBytes: 96_000,
    async execute(
      bridge: CadToolBridge,
      input: unknown
    ): Promise<ToolResult> {
      const parsed = inputSchema.safeParse(input)
      if (!parsed.success) {
        return {
          error: `Invalid arguments for ${name}: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
            .join('; ')}`
        }
      }
      return bridge.callTool(name, parsed.data)
    }
  })
}

const inputId = z.string().min(1).max(200)

export const INPUT_TOOL_SPECS: readonly InputToolSpec[] = Object.freeze([
  defineInputTool(
    'get_input_metadata',
    'Return exact local metadata for one instruction or reference input. The content remains local until explicitly read with another input tool.',
    z.strictObject({ inputId })
  ),
  defineInputTool(
    'get_input_outline',
    'Return bounded chunk ranges and metadata for one local input. Use this before targeted search or range retrieval.',
    z.strictObject({ inputId })
  ),
  defineInputTool(
    'search_input',
    'Search exact UTF-8 bytes in one local input and return bounded previews with byte ranges. Use returned ranges to cite and retrieve source content.',
    z.strictObject({
      inputId,
      query: z.string().min(1).max(4_096),
      limit: z.number().int().min(1).max(20).default(10)
    })
  ),
  defineInputTool(
    'read_input_chunk',
    'Read one ingested chunk exactly. If the ingestion chunk is too large for a provider response, use read_input_range on its outline ranges.',
    z.strictObject({
      inputId,
      chunkIndex: z.number().int().nonnegative().max(4_095)
    })
  ),
  defineInputTool(
    'read_input_range',
    `Read an exact local byte range of at most ${MAX_INPUT_RANGE_BYTES} bytes. Repeat with adjacent ranges when more source content is required.`,
    z.strictObject({
      inputId,
      byteStart: z.number().int().nonnegative(),
      byteLength: z.number().int().min(1).max(MAX_INPUT_RANGE_BYTES)
    })
  )
])

const byName = new Map(INPUT_TOOL_SPECS.map((spec) => [spec.name, spec]))

export function getInputToolSpec(name: string): InputToolSpec | undefined {
  return byName.get(name as InputToolName)
}
