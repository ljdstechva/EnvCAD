import type {
  InstructionBreakdown,
  SubmitTurnCommand
} from '../../../../shared/agent-contracts'

export type TurnIntent =
  | 'conversation-help'
  | 'drawing-query'
  | 'visual-analysis'
  | 'additive-edit'
  | 'destructive-edit'
  | 'import'
  | 'sheet-layout'
  | 'environmental-siting'

export interface ClassifiedInstruction {
  intent: TurnIntent
  breakdown: InstructionBreakdown
}

const patterns: ReadonlyArray<{
  intent: TurnIntent
  pattern: RegExp
}> = [
  {
    intent: 'environmental-siting',
    pattern:
      /\b(buffer|easement|setback|monitoring point|discharge|outfall|siting|environmental)\b/i
  },
  {
    intent: 'destructive-edit',
    pattern: /\b(delete|erase|remove|purge|replace|clear all|trim away)\b/i
  },
  {
    intent: 'import',
    pattern: /\b(import|geojson|csv|coordinates?|boundary file)\b/i
  },
  {
    intent: 'sheet-layout',
    pattern: /\b(sheet|layout|title block|viewport|paper size|print|plot)\b/i
  },
  {
    intent: 'additive-edit',
    pattern:
      /\b(draw|create|add|insert|move|copy|rotate|scale|annotate|dimension|hatch)\b/i
  },
  {
    intent: 'visual-analysis',
    pattern: /\b(visual|preview|clipp|overlap|readability|appearance|look)\b/i
  },
  {
    intent: 'drawing-query',
    pattern: /\b(inspect|list|measure|find|show|count|check|what is|which)\b/i
  }
]

export function classifyInstruction(
  command: SubmitTurnCommand,
  resolvedInstruction?: string
): ClassifiedInstruction {
  const source = command.text?.trim() ?? resolvedInstruction?.trim() ?? ''
  const intent =
    patterns.find(({ pattern }) => pattern.test(source))?.intent ??
    'conversation-help'
  const context = contextFor(intent)
  const referenceCount = command.referenceInputIds.length

  return {
    intent,
    breakdown: {
      objective: objective(source, command.instructionInputId),
      inputs: [
        source ? 'Inline user instruction' : 'Stored instruction reference',
        ...(referenceCount > 0
          ? [`${referenceCount} stored reference input${referenceCount === 1 ? '' : 's'}`]
          : []),
        ...(command.selectionSnapshot.count > 0
          ? [`Frozen selection of ${command.selectionSnapshot.count} entities`]
          : [])
      ],
      constraints: [
        `Drawing units: ${command.selectionSnapshot.units}`,
        `Active sheet: ${command.sheet.paper} ${command.sheet.orientation}`,
        `Model geometry remains at 1:${command.sheet.scaleDenominator} sheet scale`,
        'Use only revision-bound EnvCAD capabilities'
      ],
      requiredDrawingContext: context.requiredDrawingContext,
      plannedToolCategories: context.plannedToolCategories,
      expectedOutput: context.expectedOutput,
      riskLevel: riskFor(intent)
    }
  }
}

function objective(text: string, inputId: string | undefined): string {
  if (!text) return `Process stored instruction ${inputId ?? 'reference'}.`
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length <= 500 ? compact : `${compact.slice(0, 497)}...`
}

function riskFor(intent: TurnIntent): 'low' | 'medium' | 'high' {
  if (intent === 'destructive-edit' || intent === 'import') return 'high'
  if (
    intent === 'additive-edit' ||
    intent === 'sheet-layout' ||
    intent === 'environmental-siting'
  ) {
    return 'medium'
  }
  return 'low'
}

function contextFor(intent: TurnIntent): Pick<
  InstructionBreakdown,
  'requiredDrawingContext' | 'plannedToolCategories' | 'expectedOutput'
> {
  if (intent === 'conversation-help') {
    return {
      requiredDrawingContext: ['Cheap local DXF preflight only'],
      plannedToolCategories: ['help'],
      expectedOutput: 'A concise drawing-aware answer with explicit limitations.'
    }
  }
  const requiredDrawingContext = [
    'Current workspace revision',
    'Relevant entities and layers'
  ]
  const plannedToolCategories = ['inspection']
  if (intent === 'visual-analysis' || intent === 'sheet-layout') {
    requiredDrawingContext.push('Validated Sheet Preview evidence')
    plannedToolCategories.push('vision')
  }
  if (
    intent === 'additive-edit' ||
    intent === 'destructive-edit' ||
    intent === 'import' ||
    intent === 'sheet-layout' ||
    intent === 'environmental-siting'
  ) {
    plannedToolCategories.push('mutation', 'verification')
  }
  if (intent === 'import') plannedToolCategories.push('import')
  if (intent === 'environmental-siting') {
    plannedToolCategories.push('environmental')
  }
  return {
    requiredDrawingContext,
    plannedToolCategories: [...new Set(plannedToolCategories)],
    expectedOutput:
      plannedToolCategories.includes('mutation')
        ? 'A revision-bound result naming changes, checks performed, and remaining warnings.'
        : 'A revision-bound finding with the inspected scope and supporting evidence.'
  }
}
