import type { TurnIntent } from '../turn/InstructionBreakdown'
import type { EnvCadSkillId } from './SkillManifest'

export const MANDATORY_ENV_CAD_SKILLS: readonly EnvCadSkillId[] = [
  'cad-core',
  'dxf-core'
]

const INTENT_SKILLS: Record<TurnIntent, readonly EnvCadSkillId[]> = {
  'conversation-help': [],
  'drawing-query': ['drawing-analysis'],
  'visual-analysis': [
    'drawing-analysis',
    'visual-quality-assurance'
  ],
  'additive-edit': ['drawing-analysis', 'geometry-editing'],
  'destructive-edit': ['drawing-analysis', 'geometry-editing'],
  import: ['drawing-analysis', 'import-validation'],
  'sheet-layout': [
    'drawing-analysis',
    'sheet-layout',
    'visual-quality-assurance'
  ],
  'environmental-siting': [
    'drawing-analysis',
    'environmental-siting'
  ]
}

const KEYWORD_SKILLS: ReadonlyArray<{
  pattern: RegExp
  skillId: EnvCadSkillId
}> = [
  { pattern: /\b(layer|linetype|color|plot|freeze|lock)\b/i, skillId: 'layer-hygiene' },
  {
    pattern:
      /\b(text|mtext|note|label|dimension|leader|annotat(?:e|ed|ing|ion|ions)?)\b/i,
    skillId: 'annotation'
  },
  {
    pattern: /\b(sheet|layout|title block|paper|viewport|plot)\b/i,
    skillId: 'sheet-layout'
  },
  {
    pattern: /\b(preview|visual|readab|clipp|overlap|visibility)\b/i,
    skillId: 'visual-quality-assurance'
  }
]

export function skillsForInstruction(
  intent: TurnIntent,
  text: string,
  hasStoredInstruction: boolean
): EnvCadSkillId[] {
  const selected = new Set<EnvCadSkillId>(MANDATORY_ENV_CAD_SKILLS)
  for (const skillId of INTENT_SKILLS[intent]) selected.add(skillId)
  for (const route of KEYWORD_SKILLS) {
    if (route.pattern.test(text)) selected.add(route.skillId)
  }
  if (
    [
      'additive-edit',
      'destructive-edit',
      'sheet-layout'
    ].includes(intent) &&
    (selected.has('annotation') ||
      selected.has('layer-hygiene') ||
      selected.has('sheet-layout'))
  ) {
    selected.add('visual-quality-assurance')
  }
  if (hasStoredInstruction) selected.add('drawing-analysis')
  return [...selected]
}
