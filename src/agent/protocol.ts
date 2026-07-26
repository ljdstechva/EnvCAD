/**
 * Shared wire protocol between the browser (src/agent/bridge.ts) and the
 * Node sidecar (sidecar/src/*). Imported by both sides via relative path so
 * there is exactly one source of truth for the message shapes documented in
 * docs/agent-protocol.md. This file has no runtime dependencies of its own.
 */

export interface SelectionSnapshot {
  /** Entity object ids selected in the viewer at the moment the message was sent. */
  ids: string[]
  count: number
  /** Human-readable drawing unit name, e.g. "Millimeters". */
  units: string
}

export interface SheetSnapshot {
  paper: string
  orientation: 'portrait' | 'landscape'
  scaleDenominator: number
  drawingUnit: string
  templateId?: string
  fields?: Record<string, string>
}

/** Result a browser tool handler returns; forwarded back to the agent loop. */
export interface ToolResult {
  data?: unknown
  error?: string
}

export type ClientMessage =
  | {
      type: 'user_message'
      text: string
      selectionSnapshot: SelectionSnapshot
      sheet: SheetSnapshot
    }
  | { type: 'tool_result'; callId: string; result: ToolResult }
  | { type: 'interrupt' }
  | { type: 'reset' }

export type AgentStatusState = 'thinking' | 'idle'

export type ServerMessage =
  | { type: 'assistant_text_delta'; text: string }
  | { type: 'assistant_done' }
  | { type: 'tool_call'; callId: string; name: string; input: unknown }
  | { type: 'status'; state: AgentStatusState }
  | { type: 'error'; message: string }

/** Every CAD tool name the sidecar registers with the Agent SDK. */
export const CAD_TOOL_NAMES = [
  'get_selected_entities',
  'get_drawing_context',
  'move_entities',
  'copy_entities',
  'rotate_entities',
  'scale_entities',
  'delete_entities',
  'set_entity_layer',
  'change_text',
  'calculate_area',
  'calculate_length',
  'draw_line',
  'draw_polyline',
  'draw_rectangle',
  'draw_circle',
  'draw_arc',
  'draw_text',
  'add_linear_dimension',
  'add_radius_dimension',
  'add_leader',
  'add_mtext',
  'draw_hatch',
  'create_layer',
  'set_current_layer',
  'zoom_extents',
  'import_boundary_from_csv',
  'import_boundary_from_geojson',
  'check_inside_boundary',
  'check_entity_overlap',
  'measure_clearance',
  'place_monitoring_points',
  'insert_symbol',
  'get_sheet_setup',
  'set_sheet_definition',
  'set_title_block_fields'
] as const

export type CadToolName = (typeof CAD_TOOL_NAMES)[number]

/** Tool names with a real browser-side implementation. */
export const REAL_TOOL_NAMES = CAD_TOOL_NAMES

export type ProtocolParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

const CAD_TOOL_NAME_SET = new Set<string>(CAD_TOOL_NAMES)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function failure<T>(error: string): ProtocolParseResult<T> {
  return { ok: false, error }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function parseSelectionSnapshot(value: unknown): ProtocolParseResult<SelectionSnapshot> {
  if (!isRecord(value)) return failure('selectionSnapshot must be an object')
  if (!Array.isArray(value.ids) || !value.ids.every((id) => typeof id === 'string')) {
    return failure('selectionSnapshot.ids must be an array of strings')
  }
  if (!Number.isInteger(value.count) || (value.count as number) < 0) {
    return failure('selectionSnapshot.count must be a non-negative integer')
  }
  if (value.count !== value.ids.length) {
    return failure('selectionSnapshot.count must equal selectionSnapshot.ids.length')
  }
  if (!isNonEmptyString(value.units)) {
    return failure('selectionSnapshot.units must be a non-empty string')
  }
  return { ok: true, value: value as unknown as SelectionSnapshot }
}

function parseSheetSnapshot(value: unknown): ProtocolParseResult<SheetSnapshot> {
  if (!isRecord(value)) return failure('sheet must be an object')
  if (!isNonEmptyString(value.paper)) return failure('sheet.paper must be a non-empty string')
  if (value.orientation !== 'portrait' && value.orientation !== 'landscape') {
    return failure('sheet.orientation must be "portrait" or "landscape"')
  }
  if (
    typeof value.scaleDenominator !== 'number' ||
    !Number.isFinite(value.scaleDenominator) ||
    value.scaleDenominator <= 0
  ) {
    return failure('sheet.scaleDenominator must be a positive finite number')
  }
  if (!isNonEmptyString(value.drawingUnit)) {
    return failure('sheet.drawingUnit must be a non-empty string')
  }
  if (value.templateId !== undefined && typeof value.templateId !== 'string') {
    return failure('sheet.templateId must be a string when provided')
  }
  if (value.fields !== undefined) {
    if (
      !isRecord(value.fields) ||
      !Object.values(value.fields).every((fieldValue) => typeof fieldValue === 'string')
    ) {
      return failure('sheet.fields must be a record of string values when provided')
    }
  }
  return { ok: true, value: value as unknown as SheetSnapshot }
}

function parseToolResult(value: unknown): ProtocolParseResult<ToolResult> {
  if (!isRecord(value)) return failure('tool_result.result must be an object')
  const hasData = hasOwn(value, 'data')
  const hasError = hasOwn(value, 'error')
  if (hasData === hasError) {
    return failure('tool_result.result must contain exactly one of data or error')
  }
  if (hasError && !isNonEmptyString(value.error)) {
    return failure('tool_result.result.error must be a non-empty string')
  }
  return { ok: true, value: value as ToolResult }
}

/** Validates one decoded browser-to-sidecar message before it is processed. */
export function parseClientMessage(value: unknown): ProtocolParseResult<ClientMessage> {
  if (!isRecord(value)) return failure('message must be a JSON object')

  switch (value.type) {
    case 'user_message': {
      if (!isNonEmptyString(value.text)) {
        return failure('user_message.text must be a non-empty string')
      }
      const selection = parseSelectionSnapshot(value.selectionSnapshot)
      if (!selection.ok) return failure(selection.error)
      const sheet = parseSheetSnapshot(value.sheet)
      if (!sheet.ok) return failure(sheet.error)
      return { ok: true, value: value as unknown as ClientMessage }
    }
    case 'tool_result': {
      if (!isNonEmptyString(value.callId)) {
        return failure('tool_result.callId must be a non-empty string')
      }
      const result = parseToolResult(value.result)
      if (!result.ok) return failure(result.error)
      return { ok: true, value: value as unknown as ClientMessage }
    }
    case 'interrupt':
    case 'reset':
      return { ok: true, value: value as unknown as ClientMessage }
    default:
      return failure(`unsupported client message type: ${String(value.type)}`)
  }
}

/** Validates one decoded sidecar-to-browser message before it is processed. */
export function parseServerMessage(value: unknown): ProtocolParseResult<ServerMessage> {
  if (!isRecord(value)) return failure('message must be a JSON object')

  switch (value.type) {
    case 'assistant_text_delta':
      return typeof value.text === 'string'
        ? { ok: true, value: value as unknown as ServerMessage }
        : failure('assistant_text_delta.text must be a string')
    case 'assistant_done':
      return { ok: true, value: value as unknown as ServerMessage }
    case 'tool_call':
      if (!isNonEmptyString(value.callId)) {
        return failure('tool_call.callId must be a non-empty string')
      }
      if (!isNonEmptyString(value.name) || !CAD_TOOL_NAME_SET.has(value.name)) {
        return failure(`tool_call.name is not a registered CAD tool: ${String(value.name)}`)
      }
      return { ok: true, value: value as unknown as ServerMessage }
    case 'status':
      return value.state === 'thinking' || value.state === 'idle'
        ? { ok: true, value: value as unknown as ServerMessage }
        : failure('status.state must be "thinking" or "idle"')
    case 'error':
      return isNonEmptyString(value.message)
        ? { ok: true, value: value as unknown as ServerMessage }
        : failure('error.message must be a non-empty string')
    default:
      return failure(`unsupported server message type: ${String(value.type)}`)
  }
}
