import { describe, expect, it } from 'vitest'
import {
  invokeTextToCadSkillForTurn,
  loadBundledTextToCadSkillSources,
  TEXT_TO_CAD_SKILL,
  TEXT_TO_CAD_SKILL_INSTRUCTIONS
} from '../textToCadSkill'

describe('bundled text-to-cad workflow', () => {
  it('pins the attributed MIT source and invokes the native profile', () => {
    expect(TEXT_TO_CAD_SKILL).toMatchObject({
      name: 'CAD Skills',
      repository: 'earthtojake/text-to-cad',
      version: '0.3.9',
      commit: 'fdbb4b4fb62d95ae298cfe9a46fdc7092bdaf423',
      license: 'MIT',
      profile: 'envcad-native-cad-dxf'
    })
    const sources = loadBundledTextToCadSkillSources()
    expect(sources.cad).toContain(
      '# CAD generation, inspection, and validation'
    )
    expect(sources.dxf).toContain('# DXF generation and validation')
    expect(invokeTextToCadSkillForTurn()).toContain(
      'verified CAD f6ba5a9a2042d1a955f511a929f3061677871c2cd3674b09cf70b0c4c6690ecd and DXF ' +
        '12f88bb9d93b42c22b60e6ce4dad7ff3dacfe1cc4eab66afca6787cf243ee453'
    )
    expect(TEXT_TO_CAD_SKILL_INSTRUCTIONS).toContain(
      "Use only EnvCAD's allowlisted native CAD"
    )
  })
})
