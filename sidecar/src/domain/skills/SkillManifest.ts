import type { SkillManifest } from '../../../../shared/agent-contracts'

export type EnvCadSkillId =
  | 'cad-core'
  | 'dxf-core'
  | 'drawing-analysis'
  | 'geometry-editing'
  | 'layer-hygiene'
  | 'annotation'
  | 'sheet-layout'
  | 'import-validation'
  | 'environmental-siting'
  | 'visual-quality-assurance'

export interface RegisteredSkill {
  manifest: SkillManifest & { id: EnvCadSkillId }
  displayName: string
  sourceFiles?: Array<{
    path: string
    sha256: string
  }>
  mandatory: boolean
}
