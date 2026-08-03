import { describe, expect, it, vi } from 'vitest'
import { CapabilityBroker } from '../application/capabilities/CapabilityBroker'
import { ContextBudgetManager } from '../application/input/ContextBudgetManager'
import { SkillRegistry } from '../application/skills/SkillRegistry'

function command(text: string) {
  return {
    type: 'submit_turn' as const,
    text,
    referenceInputIds: [],
    configurationRevision: 1,
    selectionSnapshot: {
      count: 1,
      units: 'Meters',
      revision: {
        documentId: 'drawing-1',
        documentRevision: 1,
        contentRevision: 1,
        sheetRevision: 1,
        viewRevision: 1
      }
    },
    sheet: {
      paper: 'A3',
      orientation: 'landscape' as const,
      scaleDenominator: 500,
      drawingUnit: 'm'
    }
  }
}

function fixture(text: string) {
  const registry = new SkillRegistry()
  const callTool = vi.fn(async () => ({ data: { ok: true } }))
  const audit = vi.fn()
  const broker = new CapabilityBroker({
    delegate: {
      callTool,
      getSelectionSnapshot: () => undefined
    },
    skillRegistry: registry,
    audit
  })
  broker.activate(registry.activate(command(text)))
  return { broker, registry, callTool, audit }
}

describe('CapabilityBroker', () => {
  it('denies arbitrary and intent-incompatible provider capabilities', async () => {
    const { broker, callTool, audit } = fixture('How do I use EnvCAD?')

    await expect(broker.callTool('shell', {})).resolves.toMatchObject({
      error: expect.stringContaining('allowlist')
    })
    await expect(
      broker.callTool('move_entities', {
        entityIds: ['entity-1'],
        dx: 1,
        dy: 0
      })
    ).resolves.toMatchObject({
      error: expect.stringContaining('geometry-editing')
    })
    expect(callTool).not.toHaveBeenCalled()
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'denied' })
    )
  })

  it('allows a schema-valid intent-scoped mutation after forced skill checks', async () => {
    const { broker, registry, callTool } = fixture(
      'Move the selected entity 1 meter east.'
    )
    const verify = vi.spyOn(registry, 'verifyBeforeMutation')

    await expect(
      broker.callTool('move_entities', {
        entityIds: ['entity-1'],
        dx: 1,
        dy: 0
      })
    ).resolves.toEqual({ data: { ok: true } })
    expect(verify).toHaveBeenCalledWith([
      'cad-core',
      'dxf-core',
      'geometry-editing'
    ])
    expect(callTool).toHaveBeenCalledOnce()
  })

  it('returns bounded field guidance without forwarding invalid arguments', async () => {
    const { broker, callTool } = fixture('Move the selected entity.')

    await expect(
      broker.callTool('move_entities', { dx: 'east' })
    ).resolves.toMatchObject({
      error: expect.stringContaining('correct:')
    })
    expect(callTool).not.toHaveBeenCalled()
  })

  it('blocks a mutation when the forced integrity check fails', async () => {
    const { broker, registry, callTool } = fixture('Draw a line.')
    vi.spyOn(registry, 'verifyBeforeMutation').mockReturnValue({
      allowed: false,
      reason: 'cad-core source integrity failed.'
    })

    await expect(
      broker.callTool('draw_line', {
        start: { x: 0, y: 0 },
        end: { x: 1, y: 1 }
      })
    ).resolves.toMatchObject({
      error: expect.stringContaining('manual CAD is still available')
    })
    expect(callTool).not.toHaveBeenCalled()
  })

  it('permits only bounded local retrieval and no arbitrary input id access', async () => {
    const { broker, callTool } = fixture('Review the attached instructions.')
    await broker.callTool('read_input_range', {
      inputId: 'attached-1',
      byteStart: 0,
      byteLength: 10
    })
    expect(callTool).toHaveBeenCalledWith('read_input_range', {
      inputId: 'attached-1',
      byteStart: 0,
      byteLength: 10
    })
  })

  it('denies a mutation before execution when its result cannot fit safely', async () => {
    const registry = new SkillRegistry()
    const callTool = vi.fn(async () => ({ data: { ok: true } }))
    const budget = new ContextBudgetManager({
      staticContextBytes: 0,
      contextWindowTokens: 100,
      outputReserveTokens: 1,
      bytesPerToken: 1
    })
    budget.beginTurn()
    const broker = new CapabilityBroker({
      delegate: { callTool, getSelectionSnapshot: () => undefined },
      skillRegistry: registry,
      contextBudget: budget
    })
    broker.activate(registry.activate(command('Move the selected entity.')))

    await expect(
      broker.callTool('move_entities', {
        entityIds: ['entity-1'],
        dx: 1,
        dy: 0
      })
    ).resolves.toMatchObject({
      error: expect.stringContaining('context window')
    })
    expect(callTool).not.toHaveBeenCalled()
  })

  it('preserves local read data while returning narrowing guidance on overflow', async () => {
    const registry = new SkillRegistry()
    const callTool = vi.fn(async () => ({
      data: { text: 'x'.repeat(200) }
    }))
    const budget = new ContextBudgetManager({
      staticContextBytes: 0,
      contextWindowTokens: 100,
      outputReserveTokens: 1,
      bytesPerToken: 1
    })
    budget.beginTurn()
    const broker = new CapabilityBroker({
      delegate: { callTool, getSelectionSnapshot: () => undefined },
      skillRegistry: registry,
      contextBudget: budget
    })
    broker.activate(registry.activate(command('Review the attached instructions.')))

    await expect(
      broker.callTool('read_input_range', {
        inputId: 'attached-1',
        byteStart: 0,
        byteLength: 10
      })
    ).resolves.toMatchObject({
      error: expect.stringContaining('Narrow the query')
    })
    expect(callTool).toHaveBeenCalledOnce()
  })
})
