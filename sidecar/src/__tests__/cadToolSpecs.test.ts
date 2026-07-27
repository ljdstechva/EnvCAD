import { z } from 'zod'
import { describe, expect, it, vi } from 'vitest'
import { createCadMcpServer } from '../cadTools'
import {
  CAD_TOOL_NAMES,
  CAD_TOOL_SPECS,
  executeCadTool,
  type CadToolBridge
} from '../cadToolSpecs'

function bridge(): CadToolBridge {
  return {
    callTool: vi.fn(async (name, input) => ({
      data: { name, input }
    })),
    getSelectionSnapshot: () => ({
      ids: ['entity-1', 'entity-2'],
      count: 2,
      units: 'Meters'
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
    expect(Object.keys(tools)).toEqual([...CAD_TOOL_NAMES])
    expect(CAD_TOOL_NAMES).not.toContain('Bash')
    expect(CAD_TOOL_NAMES).not.toContain('shell')
    expect(CAD_TOOL_NAMES).not.toContain('WebSearch')

    for (const spec of CAD_TOOL_SPECS) {
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

  it('forwards one valid catalog invocation exactly once and freezes selection ids', async () => {
    const testBridge = bridge()
    await executeCadTool(testBridge, 'get_selected_entities', {})
    expect(testBridge.callTool).toHaveBeenCalledOnce()
    expect(testBridge.callTool).toHaveBeenCalledWith(
      'get_selected_entities',
      { ids: ['entity-1', 'entity-2'] }
    )
  })
})
