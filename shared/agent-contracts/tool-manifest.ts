export type ToolMutability = 'read' | 'write'
export type ToolRetrySafety = 'safe' | 'idempotent-required' | 'never'
export type ToolUndoBehavior = 'none' | 'single-step' | 'operation-group'
export type ToolImageBehavior = 'none' | 'input' | 'output'

export interface EffectiveToolPolicy {
  mutability: ToolMutability
  retrySafety: ToolRetrySafety
  requiredCapabilities: readonly string[]
  undoBehavior: ToolUndoBehavior
}

export interface ToolConditionalPolicy {
  kind: 'boolean-input'
  field: string
  writeWhen: boolean
  otherwise: EffectiveToolPolicy
}

export interface ToolManifestEntry<Name extends string = string> {
  name: Name
  category: string
  mutability: ToolMutability
  retrySafety: ToolRetrySafety
  timeoutMs: number
  maximumInputBytes: number
  maximumOutputBytes: number
  requiredSkills: readonly string[]
  requiredCapabilities: readonly string[]
  undoBehavior: ToolUndoBehavior
  imageBehavior: ToolImageBehavior
  conditionalPolicy?: ToolConditionalPolicy
}

const read = <Name extends string>(
  name: Name,
  category: string,
  capability = 'cad.read',
  imageBehavior: ToolImageBehavior = 'none',
  conditionalSkills: string[] = ['drawing-analysis']
): ToolManifestEntry<Name> => ({
  name,
  category,
  mutability: 'read',
  retrySafety: 'safe',
  timeoutMs: imageBehavior === 'output' ? 60_000 : 30_000,
  maximumInputBytes: 24_000,
  maximumOutputBytes: imageBehavior === 'output' ? 1_800_000 : 32_000,
  requiredSkills: ['cad-core', 'dxf-core', ...conditionalSkills],
  requiredCapabilities: [capability],
  undoBehavior: 'none',
  imageBehavior
})

const write = <Name extends string>(
  name: Name,
  category: string,
  skill: string,
  undoBehavior: ToolUndoBehavior = 'single-step'
): ToolManifestEntry<Name> => ({
  name,
  category,
  mutability: 'write',
  retrySafety: 'idempotent-required',
  timeoutMs: 30_000,
  maximumInputBytes: 24_000,
  maximumOutputBytes: 32_000,
  requiredSkills: ['cad-core', 'dxf-core', skill],
  requiredCapabilities: ['cad.write'],
  undoBehavior,
  imageBehavior: 'none'
})

const entries = [
  read('get_selected_entities', 'inspection'),
  read('list_entities', 'inspection'),
  read('list_layers', 'layers', 'cad.read', 'none', ['layer-hygiene']),
  read('find_text_overlaps', 'annotations', 'cad.read', 'none', ['annotation']),
  read('get_entity_text', 'inspection'),
  read('get_polyline_vertices', 'geometry'),
  read('get_drawing_context', 'inspection'),
  read('get_view_status', 'vision', 'cad.render', 'none', ['visual-quality-assurance']),
  read(
    'inspect_sheet_preview',
    'vision',
    'cad.render',
    'output',
    ['drawing-analysis', 'visual-quality-assurance']
  ),
  read(
    'inspect_model_view',
    'vision',
    'cad.render',
    'output',
    ['drawing-analysis', 'visual-quality-assurance']
  ),
  read(
    'inspect_region',
    'vision',
    'cad.render',
    'output',
    ['drawing-analysis', 'visual-quality-assurance']
  ),
  read(
    'inspect_selection',
    'vision',
    'cad.render',
    'output',
    ['drawing-analysis', 'visual-quality-assurance']
  ),
  read(
    'compare_before_after',
    'vision',
    'cad.render',
    'output',
    ['drawing-analysis', 'visual-quality-assurance']
  ),
  read(
    'render_analysis_overlay',
    'vision',
    'cad.render',
    'output',
    ['drawing-analysis', 'visual-quality-assurance']
  ),
  write('move_entities', 'geometry', 'geometry-editing'),
  write('copy_entities', 'geometry', 'geometry-editing'),
  write('rotate_entities', 'geometry', 'geometry-editing'),
  write('scale_entities', 'geometry', 'geometry-editing'),
  write('delete_entities', 'entities', 'geometry-editing'),
  write('set_entity_layer', 'layers', 'layer-hygiene'),
  write('set_entity_color', 'layers', 'layer-hygiene'),
  write('change_text', 'annotations', 'annotation'),
  read('calculate_area', 'geometry'),
  read('calculate_length', 'geometry'),
  write('draw_line', 'geometry', 'geometry-editing'),
  write('draw_polyline', 'geometry', 'geometry-editing'),
  write('draw_rectangle', 'geometry', 'geometry-editing'),
  write('draw_circle', 'geometry', 'geometry-editing'),
  write('draw_arc', 'geometry', 'geometry-editing'),
  write('draw_text', 'annotations', 'annotation'),
  write('add_linear_dimension', 'annotations', 'annotation'),
  write('add_radius_dimension', 'annotations', 'annotation'),
  write('add_leader', 'annotations', 'annotation'),
  write('add_mtext', 'annotations', 'annotation'),
  write('draw_hatch', 'geometry', 'geometry-editing'),
  write('create_layer', 'layers', 'layer-hygiene'),
  write('set_layer_properties', 'layers', 'layer-hygiene'),
  write('set_current_layer', 'layers', 'layer-hygiene'),
  write('zoom_extents', 'vision', 'visual-quality-assurance', 'none'),
  write('import_boundary_from_csv', 'imports', 'import-validation', 'operation-group'),
  write('import_boundary_from_geojson', 'imports', 'import-validation', 'operation-group'),
  read('check_inside_boundary', 'environmental', 'cad.read', 'none', ['environmental-siting']),
  read('check_entity_overlap', 'environmental', 'cad.read', 'none', ['environmental-siting']),
  {
    ...write('measure_clearance', 'environmental', 'environmental-siting'),
    conditionalPolicy: {
      kind: 'boolean-input',
      field: 'draw',
      writeWhen: true,
      otherwise: {
        mutability: 'read',
        retrySafety: 'safe',
        requiredCapabilities: ['cad.read'],
        undoBehavior: 'none'
      }
    }
  },
  write('place_monitoring_points', 'environmental', 'environmental-siting', 'operation-group'),
  write('insert_symbol', 'entities', 'geometry-editing'),
  read('get_sheet_setup', 'sheet', 'sheet.read', 'none', ['sheet-layout']),
  write('set_sheet_definition', 'sheet', 'sheet-layout', 'none'),
  write('set_title_block_fields', 'sheet', 'sheet-layout', 'none')
] as const

export type CadToolName = (typeof entries)[number]['name']
export const CAD_TOOL_MANIFEST: readonly ToolManifestEntry<CadToolName>[] =
  Object.freeze(
    entries.map((entry) =>
      Object.freeze({
        ...entry,
        requiredSkills: Object.freeze([...entry.requiredSkills]),
        requiredCapabilities: Object.freeze([...entry.requiredCapabilities]),
        ...('conditionalPolicy' in entry && entry.conditionalPolicy
          ? {
              conditionalPolicy: Object.freeze({
                ...entry.conditionalPolicy,
                otherwise: Object.freeze({
                  ...entry.conditionalPolicy.otherwise,
                  requiredCapabilities: Object.freeze([
                    ...entry.conditionalPolicy.otherwise.requiredCapabilities
                  ])
                })
              })
            }
          : {})
      })
    )
  )
export const CAD_TOOL_NAMES: readonly CadToolName[] = Object.freeze(
  CAD_TOOL_MANIFEST.map((entry) => entry.name)
)

const manifestByName = new Map<string, ToolManifestEntry<CadToolName>>(
  CAD_TOOL_MANIFEST.map((entry) => [entry.name, entry])
)

export const getToolManifestEntry = (
  name: string
): ToolManifestEntry<CadToolName> | undefined => manifestByName.get(name)

export const getEffectiveToolPolicy = (
  name: string,
  input: unknown
): EffectiveToolPolicy | undefined => {
  const entry = getToolManifestEntry(name)
  if (!entry) return undefined
  const basePolicy: EffectiveToolPolicy = {
    mutability: entry.mutability,
    retrySafety: entry.retrySafety,
    requiredCapabilities: entry.requiredCapabilities,
    undoBehavior: entry.undoBehavior
  }
  const rule = entry.conditionalPolicy
  if (!rule) return basePolicy
  const record =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined
  return record?.[rule.field] === rule.writeWhen
    ? basePolicy
    : rule.otherwise
}

export const getEffectiveToolMutability = (
  name: string,
  input: unknown
): ToolMutability | undefined => getEffectiveToolPolicy(name, input)?.mutability

export const toolCallMayMutate = (name: string, input: unknown): boolean =>
  getEffectiveToolMutability(name, input) === 'write'
