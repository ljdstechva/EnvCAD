import { describe, expect, it } from 'vitest'
import { SYSTEM_PROMPT } from '../systemPrompt'

describe('CAD agent discovery instructions', () => {
  it('allows drawing-wide work without a selection and requires automatic pagination', () => {
    expect(SYSTEM_PROMPT).toContain(
      'An empty selection does NOT block drawing, inspecting'
    )
    expect(SYSTEM_PROMPT).toContain(
      'A user selection is optional context, not an authorization boundary.'
    )
    expect(SYSTEM_PROMPT).toContain(
      'use get_drawing_context, list_entities, and'
    )
    expect(SYSTEM_PROMPT).toContain(
      'Continue until hasMore is false'
    )
    expect(SYSTEM_PROMPT).toContain(
      'Never ask the user to make'
    )
    expect(SYSTEM_PROMPT).not.toContain(
      'ask them to select the entities and send again'
    )
  })

  it('loads the pinned EnvCAD-native CAD Skills workflow for every AI agent', () => {
    expect(SYSTEM_PROMPT).toContain('## Pinned CAD workflow')
    expect(SYSTEM_PROMPT).not.toContain('<upstream-cad-skill>')
    expect(SYSTEM_PROMPT).not.toContain('<upstream-dxf-skill>')
    expect(SYSTEM_PROMPT).not.toContain(
      '# CAD generation, inspection, and validation'
    )
    expect(SYSTEM_PROMPT).not.toContain('# DXF generation and validation')
    expect(SYSTEM_PROMPT).toContain('earthtojake/text-to-cad CAD and DXF skills')
    expect(SYSTEM_PROMPT).toContain(
      'fdbb4b4fb62d95ae298cfe9a46fdc7092bdaf423'
    )
    expect(SYSTEM_PROMPT).toContain(
      "Use only EnvCAD's allowlisted native CAD"
    )
    expect(SYSTEM_PROMPT).toContain(
      'shell, filesystem, Python, plugin'
    )
  })
})
