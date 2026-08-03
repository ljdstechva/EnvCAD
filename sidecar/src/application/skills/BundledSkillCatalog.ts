import { createHash } from 'node:crypto'
import {
  CAD_TOOL_MANIFEST,
  type SkillRetrySafety
} from '../../../../shared/agent-contracts'
import {
  TEXT_TO_CAD_SKILL,
  bundledTextToCadSourcePaths
} from '../../textToCadSkill'
import type {
  EnvCadSkillId,
  RegisteredSkill
} from '../../domain/skills/SkillManifest'

interface SkillDefinition {
  id: EnvCadSkillId
  name: string
  intents: string[]
  capabilities: string[]
  categories?: string[]
  prompt: string
  retrySafety?: SkillRetrySafety
}

const definitions: SkillDefinition[] = [
  {
    id: 'drawing-analysis',
    name: 'Drawing Analysis',
    intents: ['drawing-query', 'visual-analysis', 'all-cad-edits'],
    capabilities: ['cad.read'],
    prompt:
      'Hydrate revision-bound drawing context before acting. Read all required pages and distinguish database findings from visual evidence.'
  },
  {
    id: 'geometry-editing',
    name: 'Geometry Editing',
    intents: ['additive-edit', 'destructive-edit'],
    capabilities: ['cad.write'],
    categories: ['geometry', 'entities'],
    prompt:
      'Use exact geometry and revision checks. Keep each edit reviewable, validate postconditions inside its transaction, and preserve grouped undo evidence.',
    retrySafety: 'idempotent-required'
  },
  {
    id: 'layer-hygiene',
    name: 'Layer Hygiene',
    intents: ['layer-edit'],
    capabilities: ['cad.read', 'cad.write'],
    categories: ['layers'],
    prompt:
      'Read exact layer names and properties before changes. Never create a misspelled layer silently; verify entity color inheritance and plot state.',
    retrySafety: 'idempotent-required'
  },
  {
    id: 'annotation',
    name: 'Annotation',
    intents: ['annotation-edit'],
    capabilities: ['cad.read', 'cad.write'],
    categories: ['annotations'],
    prompt:
      'Use measured geometry for labels and dimensions, preserve exact returned values, and verify placement or disclose that visual QA did not run.',
    retrySafety: 'idempotent-required'
  },
  {
    id: 'sheet-layout',
    name: 'Sheet Layout',
    intents: ['sheet-layout'],
    capabilities: ['sheet.read', 'cad.write'],
    categories: ['sheet'],
    prompt:
      'Read the active sheet setup before changes. Keep model geometry at 1:1, disclose non-undoable page settings, and verify the resulting preview.'
  },
  {
    id: 'import-validation',
    name: 'Import Validation',
    intents: ['import'],
    capabilities: ['cad.write'],
    categories: ['imports'],
    prompt:
      'Validate source structure, units, closure, and coordinate assumptions before import. Preserve CRS and approximation warnings in the result.',
    retrySafety: 'idempotent-required'
  },
  {
    id: 'environmental-siting',
    name: 'Environmental Siting',
    intents: ['environmental-siting'],
    capabilities: ['cad.read', 'cad.write'],
    categories: ['environmental'],
    prompt:
      'Use authoritative CAD predicates for containment, overlap, and clearance. Never invent a regulatory distance; require the governing value and source.'
  },
  {
    id: 'visual-quality-assurance',
    name: 'Visual Quality Assurance',
    intents: ['visual-analysis', 'sheet-layout'],
    capabilities: ['cad.render'],
    categories: ['vision'],
    prompt:
      'Bind visual evidence to the current revision. Inspect the relevant region before making readability, clipping, overlap, visibility, or appearance claims.'
  }
]

export function bundledSkillCatalog(): RegisteredSkill[] {
  const sourcePaths = bundledTextToCadSourcePaths()
  const shared = {
    version: TEXT_TO_CAD_SKILL.version,
    sourceProvenance:
      `${TEXT_TO_CAD_SKILL.repository}@${TEXT_TO_CAD_SKILL.commit}`,
    preconditions: ['EnvCAD provider isolation is active.'],
    validationRules: ['Report only checks that actually ran.'],
    dataAccessScope: ['Revision-bound drawing and attached local inputs only.'],
    degradedBehavior:
      'Disable AI mutation and expose a specific integrity diagnostic; manual CAD remains available.'
  }
  const mandatory: RegisteredSkill[] = [
    {
      displayName: 'CAD Core',
      mandatory: true,
      sourceFiles: [
        {
          path: sourcePaths.cad,
          sha256: TEXT_TO_CAD_SKILL.sources.cad.sha256
        }
      ],
      manifest: {
        id: 'cad-core',
        ...shared,
        sha256: TEXT_TO_CAD_SKILL.sources.cad.sha256,
        supportedIntents: ['*'],
        requiredCapabilities: [],
        allowedTools: CAD_TOOL_MANIFEST.map((tool) => tool.name),
        retrySafety: 'idempotent-required',
        promptFragment:
          'Apply the integrity-verified pinned CAD workflow through EnvCAD native tools.'
      }
    },
    {
      displayName: 'DXF Core',
      mandatory: true,
      sourceFiles: [
        {
          path: sourcePaths.dxf,
          sha256: TEXT_TO_CAD_SKILL.sources.dxf.sha256
        }
      ],
      manifest: {
        id: 'dxf-core',
        ...shared,
        sha256: TEXT_TO_CAD_SKILL.sources.dxf.sha256,
        supportedIntents: ['*'],
        requiredCapabilities: [],
        allowedTools: CAD_TOOL_MANIFEST.map((tool) => tool.name),
        retrySafety: 'idempotent-required',
        promptFragment:
          'Apply the integrity-verified pinned DXF workflow and preserve exact units, entities, and validation results.'
      }
    }
  ]
  return [
    ...mandatory,
    ...definitions.map((definition) => registeredConditional(definition))
  ]
}

function registeredConditional(definition: SkillDefinition): RegisteredSkill {
  const allowedTools = definition.categories
    ? CAD_TOOL_MANIFEST.filter((tool) =>
        definition.categories!.includes(tool.category)
      ).map((tool) => tool.name)
    : []
  return {
    displayName: definition.name,
    mandatory: false,
    manifest: {
      id: definition.id,
      version: '1.0.0',
      sourceProvenance: 'EnvCAD bundled skill policy 0.2.4',
      sha256: createHash('sha256')
        .update(definition.prompt, 'utf8')
        .digest('hex'),
      supportedIntents: definition.intents,
      requiredCapabilities: definition.capabilities,
      allowedTools,
      preconditions: ['Required drawing capabilities must be available.'],
      validationRules: ['Use revision-bound postconditions and report evidence.'],
      dataAccessScope: ['Only the active drawing and attached turn inputs.'],
      retrySafety: definition.retrySafety ?? 'safe',
      promptFragment: definition.prompt,
      degradedBehavior:
        'Continue only with capabilities covered by verified active skills and disclose the omitted verification.'
    }
  }
}
