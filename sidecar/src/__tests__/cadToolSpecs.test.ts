import { z } from 'zod'
import { describe, expect, it, vi } from 'vitest'
import { getToolManifestEntry } from '../../../shared/agent-contracts'
import { createCadMcpServer } from '../cadTools'
import {
  CAD_TOOL_NAMES,
  CAD_TOOL_SPECS,
  executeCadTool,
  type CadToolBridge
} from '../cadToolSpecs'
import {
  PROVIDER_TOOL_NAMES,
  PROVIDER_TOOL_SPECS
} from '../providerToolSpecs'

function bridge(): CadToolBridge {
  return {
    callTool: vi.fn(async (name, input) => ({
      data: { name, input }
    })),
    getSelectionSnapshot: () => ({
      count: 2,
      units: 'Meters',
      revision: { documentRevision: 7, contentRevision: 3 }
    })
  }
}

function registeredClaudeTools(server: ReturnType<typeof createCadMcpServer>) {
  return (
    server.instance as unknown as {
      _registeredTools: Record<
        string,
        { inputSchema: z.ZodType; description: string }
      >
    }
  )._registeredTools
}

describe('canonical CAD tool catalog', () => {
  it('registers exactly the same names and JSON schemas for Claude as the canonical Codex catalog', () => {
    const tools = registeredClaudeTools(createCadMcpServer(bridge()))
    expect(Object.keys(tools)).toEqual([...PROVIDER_TOOL_NAMES])
    expect(PROVIDER_TOOL_NAMES).not.toContain('Bash')
    expect(PROVIDER_TOOL_NAMES).not.toContain('shell')
    expect(PROVIDER_TOOL_NAMES).not.toContain('WebSearch')

    for (const spec of PROVIDER_TOOL_SPECS) {
      expect(tools[spec.name].description).toBe(spec.description)
      expect(
        z.toJSONSchema(tools[spec.name].inputSchema, {
          target: 'draft-07',
          io: 'input',
          reused: 'inline'
        })
      ).toEqual(spec.jsonSchema)
    }
  })

  it('rejects unknown tools and invalid arguments before reaching the browser', async () => {
    const testBridge = bridge()
    await expect(
      executeCadTool(testBridge, 'run_shell', { command: 'whoami' })
    ).resolves.toEqual({ error: 'Unknown CAD tool: run_shell' })
    await expect(
      executeCadTool(testBridge, 'draw_line', {
        start: { x: 0, y: 0 },
        end: { x: 'invalid', y: 1 }
      })
    ).resolves.toMatchObject({
      error: expect.stringContaining('Invalid arguments for draw_line')
    })
    expect(testBridge.callTool).not.toHaveBeenCalled()
  })

  it('forwards one valid selected-entity page request without sidecar-held ids', async () => {
    const testBridge = bridge()
    await executeCadTool(testBridge, 'get_selected_entities', {})
    expect(testBridge.callTool).toHaveBeenCalledOnce()
    expect(testBridge.callTool).toHaveBeenCalledWith(
      'get_selected_entities',
      {
        cursor: 0,
        pageSize: 100,
        detail: 'geometry'
      }
    )
  })

  it('allows selection-free paginated drawing discovery', async () => {
    const testBridge = bridge()
    await executeCadTool(testBridge, 'list_entities', {
      layers: ['ANNOTATION'],
      kinds: ['text']
    })
    expect(testBridge.callTool).toHaveBeenCalledWith('list_entities', {
      layers: ['ANNOTATION'],
      kinds: ['text'],
      cursor: 0,
      pageSize: 100,
      detail: 'summary'
    })
  })

  it('rejects an oversized edit batch before the browser can mutate the drawing', async () => {
    const testBridge = bridge()
    const maximumInputBytes =
      getToolManifestEntry('draw_text')?.maximumInputBytes
    if (!maximumInputBytes) throw new Error('draw_text manifest is missing')
    const result = await executeCadTool(testBridge, 'draw_text', {
      position: { x: 0, y: 0 },
      text: 'x'.repeat(maximumInputBytes + 1)
    })

    expect(result.error).toContain('was not executed')
    expect(result.error).toContain('not a total drawing limit')
    expect(result.error).toContain('No CAD change was made')
    expect(testBridge.callTool).not.toHaveBeenCalled()
  })

  it('enforces the canonical UTF-8 input limit for read tools', async () => {
    const testBridge = bridge()
    const result = await executeCadTool(testBridge, 'list_entities', {
      textContains: '界'.repeat(9_000)
    })

    expect(result.error).toContain('provider-readable input envelope')
    expect(result.error).toContain('smaller bounded query')
    expect(testBridge.callTool).not.toHaveBeenCalled()
  })

  it('requires long entity id sets to continue as automatic operation batches', async () => {
    const testBridge = bridge()
    const result = await executeCadTool(testBridge, 'move_entities', {
      entityIds: Array.from(
        { length: 100 },
        (_, index) => `${index}-${'x'.repeat(180)}`
      ),
      dx: 1,
      dy: 0
    })

    expect(result.error).toContain('continue automatically in smaller batches')
    expect(result.error).toContain('not a total drawing limit')
    expect(testBridge.callTool).not.toHaveBeenCalled()
  })

  it('bounds title-block field batches before changing sheet state', async () => {
    const testBridge = bridge()
    const result = await executeCadTool(testBridge, 'set_title_block_fields', {
      fields: Object.fromEntries(
        Array.from({ length: 101 }, (_, index) => [`FIELD_${index}`, 'value'])
      )
    })

    expect(result.error).toContain('at most 100 fields')
    expect(testBridge.callTool).not.toHaveBeenCalled()
  })

  it('exposes view evidence and an explicit sheet drawing-unit selector', () => {
    expect(CAD_TOOL_NAMES).toContain('get_view_status')
    const sheetSpec = CAD_TOOL_SPECS.find(
      (spec) => spec.name === 'set_sheet_definition'
    )
    expect(sheetSpec?.jsonSchema).toMatchObject({
      type: 'object',
      properties: {
        drawingUnit: {
          type: 'string',
          enum: ['m', 'mm']
        }
      }
    })
  })
})
