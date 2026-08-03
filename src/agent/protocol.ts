/**
 * Shared wire protocol between the renderer and the provider-neutral AI
 * sidecar. This module deliberately has no Node-only dependencies.
 */
import {
  CAD_TOOL_NAMES,
  toolCallMayMutate,
  type CadToolName
} from '../../shared/agent-contracts/tool-manifest'
import {
  cadOperationRequestSchema,
  operationReceiptSchema,
  operationStatusResultSchema,
  type CadOperationRequest,
  type OperationStatusResult,
  type OperationReceipt
} from '../../shared/agent-contracts/operation'

export { CAD_TOOL_NAMES, type CadToolName }

export const PROVIDER_IDS = ['claude-code', 'openai-codex'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

export type ProviderStatus =
  | 'checking'
  | 'ready'
  | 'missing'
  | 'authentication-required'
  | 'incompatible'
  | 'failed'

export interface EffortCapability {
  value: string
  displayName: string
  description?: string
  isDefault: boolean
}

export type InputModality = 'text' | 'image' | 'audio'

export interface ModelCapability {
  /** Stable row id from the provider catalog. */
  id: string
  /** Exact value passed back to the provider runtime. */
  invocationName: string
  /** Canonical model resolved by an alias, when the provider reports one. */
  resolvedModel?: string
  displayName: string
  description: string
  supportedEfforts: EffortCapability[]
  defaultEffort?: string
  /**
   * Provider-advertised input modalities. Absence means the runtime did not
   * report modality metadata and image support must be verified by a real call.
   */
  inputModalities?: InputModality[]
  isDefault: boolean
}

export interface ProviderCapability {
  id: ProviderId
  displayName: string
  status: ProviderStatus
  statusMessage: string
  executableVersion?: string
  models: ModelCapability[]
  discoveryMs?: number
}

export interface AgentConfiguration {
  provider: ProviderId
  model: string
  effort?: string
}

export interface CadSessionRevisionSnapshot {
  documentRevision: number
  contentRevision: number
}

export interface TurnMetrics {
  providerReadyMs?: number
  conversationStartupMs?: number
  firstTextMs?: number
  firstToolCallMs?: number
  totalMs: number
  toolCalls: number
  retries?: number
  inputTokens?: number
  outputTokens?: number
}

export interface SelectionSnapshot {
  ids: string[]
  count: number
  units: string
  revision: CadSessionRevisionSnapshot
}

/**
 * Selection metadata carried over the WebSocket. Exact entity IDs remain
 * frozen in the renderer and are injected only when get_selected_entities is
 * executed, so selection size does not consume prompt transport capacity.
 */
export interface SelectionContext {
  count: number
  units: string
  revision: CadSessionRevisionSnapshot
}

export interface SheetSnapshot {
  paper: string
  orientation: 'portrait' | 'landscape'
  scaleDenominator: number
  drawingUnit: string
  templateId?: string
  fields?: Record<string, string>
}

export const TOOL_IMAGE_MIME_TYPES = ['image/png', 'image/webp'] as const
export type ToolImageMimeType = (typeof TOOL_IMAGE_MIME_TYPES)[number]

/**
 * Keeps Base64-expanded tool results comfortably below both EnvCAD's 2 MiB
 * WebSocket limit and Codex app-server's 2 MiB JSONL line limit.
 */
export const MAX_TOOL_IMAGE_BYTES = 1_179_648
export const MAX_TOOL_IMAGE_DIMENSION = 4_096
export const MAX_TOOL_IMAGE_PIXELS = 16_777_216
export const ENVCAD_TURN_REVISION_FIELD = '__envcadTurnRevision'
export const IMAGE_CAPABLE_CAD_TOOL_NAMES = [
  'inspect_sheet_preview',
  'inspect_model_view',
  'inspect_region',
  'inspect_selection',
  'compare_before_after',
  'render_analysis_overlay'
] as const satisfies readonly CadToolName[]

export interface ToolImagePayload {
  mimeType: ToolImageMimeType
  base64: string
  byteLength: number
  width: number
  height: number
  aspectRatio: number
  sha256: string
  captureId: string
  renderRevision: number
}

export interface ToolResult {
  data?: unknown
  image?: ToolImagePayload
  error?: string
}

export type ClientMessage =
  | {
      type: 'user_message'
      text: string
      selectionSnapshot: SelectionContext
      sheet: SheetSnapshot
      configurationRevision: number
    }
  | {
      type: 'tool_result'
      callId: string
      result: ToolResult
      operationReceipt?: OperationReceipt
    }
  | {
      type: 'operation_status'
      requestId: string
      result: OperationStatusResult
    }
  | { type: 'interrupt' }
  | { type: 'reset'; revision: number }
  | { type: 'refresh_ai_capabilities' }
  | {
      type: 'set_ai_configuration'
      revision: number
      configuration: AgentConfiguration
    }

export type AgentStatusState = 'thinking' | 'idle'

export type ServerMessage =
  | { type: 'assistant_text_delta'; text: string }
  | {
      type: 'assistant_done'
      provider: ProviderId
      model: string
      resolvedModel?: string
      effort?: string
      metrics: TurnMetrics
    }
  | {
      type: 'tool_call'
      callId: string
      name: CadToolName
      input: unknown
      turnId?: string
      operation?: CadOperationRequest
    }
  | {
      type: 'get_operation_status'
      turnId: string
      requestId: string
      operationId: string
    }
  | { type: 'status'; state: AgentStatusState }
  | { type: 'error'; message: string; provider?: ProviderId }
  | {
      type: 'ai_capabilities'
      providers: ProviderCapability[]
      refreshing: boolean
    }
  | { type: 'ai_provider_status'; provider: ProviderCapability }
  | {
      type: 'ai_configuration_applied'
      revision: number
      configuration: AgentConfiguration
      newConversation: boolean
    }
  | {
      type: 'ai_configuration_rejected'
      revision: number
      message: string
    }

export const REAL_TOOL_NAMES = CAD_TOOL_NAMES

export type ProtocolParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

const PROVIDER_ID_SET = new Set<string>(PROVIDER_IDS)
const PROVIDER_STATUS_SET = new Set<string>([
  'checking',
  'ready',
  'missing',
  'authentication-required',
  'incompatible',
  'failed'
])
const CAD_TOOL_NAME_SET = new Set<string>(CAD_TOOL_NAMES)
const MAX_IDENTIFIER_LENGTH = 200
const MAX_DESCRIPTION_LENGTH = 4_000
const MAX_MODELS_PER_PROVIDER = 100
const MAX_EFFORTS_PER_MODEL = 10
const INPUT_MODALITY_SET = new Set<InputModality>(['text', 'image', 'audio'])
const TOOL_IMAGE_MIME_TYPE_SET = new Set<string>(TOOL_IMAGE_MIME_TYPES)
const IMAGE_CAPABLE_CAD_TOOL_NAME_SET = new Set<string>(
  IMAGE_CAPABLE_CAD_TOOL_NAMES
)
export const MAX_WEBSOCKET_PAYLOAD_BYTES = 2 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[]
): boolean {
  const allowed = new Set(allowedKeys)
  return Object.keys(value).every((key) => allowed.has(key))
}

function failure<T>(error: string): ProtocolParseResult<T> {
  return { ok: false, error }
}

function isNonEmptyString(value: unknown, max = MAX_DESCRIPTION_LENGTH): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

function isNonBlankPrompt(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isOptionalString(value: unknown, max = MAX_DESCRIPTION_LENGTH): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length <= max)
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && PROVIDER_ID_SET.has(value)
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function parseCadSessionRevision(
  value: unknown
): ProtocolParseResult<CadSessionRevisionSnapshot> {
  if (!isRecord(value)) return failure('revision must be an object')
  if (!hasOnlyKeys(value, ['documentRevision', 'contentRevision'])) {
    return failure('revision contains unsupported fields')
  }
  if (
    !Number.isSafeInteger(value.documentRevision) ||
    (value.documentRevision as number) < 0
  ) {
    return failure('revision.documentRevision must be a non-negative safe integer')
  }
  if (
    !Number.isSafeInteger(value.contentRevision) ||
    (value.contentRevision as number) < 0
  ) {
    return failure('revision.contentRevision must be a non-negative safe integer')
  }
  return {
    ok: true,
    value: value as unknown as CadSessionRevisionSnapshot
  }
}

function parseSelectionSnapshot(value: unknown): ProtocolParseResult<SelectionContext> {
  if (!isRecord(value)) return failure('selectionSnapshot must be an object')
  if (!hasOnlyKeys(value, ['count', 'units', 'revision'])) {
    return failure('selectionSnapshot contains unsupported fields')
  }
  if (!Number.isSafeInteger(value.count) || (value.count as number) < 0) {
    return failure('selectionSnapshot.count must be a non-negative safe integer')
  }
  if (!isNonEmptyString(value.units, MAX_IDENTIFIER_LENGTH)) {
    return failure('selectionSnapshot.units must be a non-empty string')
  }
  const revision = parseCadSessionRevision(value.revision)
  if (!revision.ok) return failure(`selectionSnapshot.${revision.error}`)
  return { ok: true, value: value as unknown as SelectionContext }
}

function parseSheetSnapshot(value: unknown): ProtocolParseResult<SheetSnapshot> {
  if (!isRecord(value)) return failure('sheet must be an object')
  if (
    !hasOnlyKeys(value, [
      'paper',
      'orientation',
      'scaleDenominator',
      'drawingUnit',
      'templateId',
      'fields'
    ])
  ) {
    return failure('sheet contains unsupported fields')
  }
  if (!isNonEmptyString(value.paper, MAX_IDENTIFIER_LENGTH)) {
    return failure('sheet.paper must be a non-empty string')
  }
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
  if (!isNonEmptyString(value.drawingUnit, MAX_IDENTIFIER_LENGTH)) {
    return failure('sheet.drawingUnit must be a non-empty string')
  }
  if (!isOptionalString(value.templateId, MAX_IDENTIFIER_LENGTH)) {
    return failure('sheet.templateId must be a bounded string when provided')
  }
  if (value.fields !== undefined) {
    if (
      !isRecord(value.fields) ||
      !Object.entries(value.fields).every(
        ([key, fieldValue]) =>
          isNonEmptyString(key, MAX_IDENTIFIER_LENGTH) &&
          typeof fieldValue === 'string' &&
          fieldValue.length <= MAX_DESCRIPTION_LENGTH
      )
    ) {
      return failure('sheet.fields must be a bounded record of string values when provided')
    }
  }
  return { ok: true, value: value as unknown as SheetSnapshot }
}

function parseToolResult(value: unknown): ProtocolParseResult<ToolResult> {
  if (!isRecord(value)) return failure('tool_result.result must be an object')
  if (!hasOnlyKeys(value, ['data', 'image', 'error'])) {
    return failure('tool_result.result contains unsupported fields')
  }
  const hasData = hasOwn(value, 'data')
  const hasImage = hasOwn(value, 'image')
  const hasError = hasOwn(value, 'error')
  if (hasData === hasError || (hasError && hasImage)) {
    return failure('tool_result.result must contain exactly one of data or error')
  }
  if (hasError && !isNonEmptyString(value.error)) {
    return failure('tool_result.result.error must be a bounded non-empty string')
  }
  if (hasImage) {
    const image = parseToolImagePayload(value.image)
    if (!image.ok) return failure(image.error)
  }
  return { ok: true, value: value as ToolResult }
}

function parseToolImagePayload(
  value: unknown
): ProtocolParseResult<ToolImagePayload> {
  if (!isRecord(value)) return failure('tool_result.result.image must be an object')
  if (
    !hasOnlyKeys(value, [
      'mimeType',
      'base64',
      'byteLength',
      'width',
      'height',
      'aspectRatio',
      'sha256',
      'captureId',
      'renderRevision'
    ])
  ) {
    return failure('tool_result.result.image contains unsupported fields')
  }
  if (
    typeof value.mimeType !== 'string' ||
    !TOOL_IMAGE_MIME_TYPE_SET.has(value.mimeType)
  ) {
    return failure('tool_result.result.image.mimeType is unsupported')
  }
  if (typeof value.base64 !== 'string') {
    return failure('tool_result.result.image.base64 must be a Base64 string')
  }
  const decodedLength = decodedBase64Length(value.base64)
  if (decodedLength === undefined) {
    return failure('tool_result.result.image.base64 is malformed')
  }
  if (decodedLength <= 0 || decodedLength > MAX_TOOL_IMAGE_BYTES) {
    return failure(
      `tool_result.result.image exceeds the ${MAX_TOOL_IMAGE_BYTES}-byte decoded limit`
    )
  }
  if (
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength !== decodedLength
  ) {
    return failure(
      'tool_result.result.image.byteLength must equal the decoded Base64 length'
    )
  }
  if (
    !validImageDimension(value.width) ||
    !validImageDimension(value.height) ||
    (value.width as number) * (value.height as number) > MAX_TOOL_IMAGE_PIXELS
  ) {
    return failure('tool_result.result.image dimensions are invalid or excessive')
  }
  const expectedAspectRatio = (value.width as number) / (value.height as number)
  if (
    typeof value.aspectRatio !== 'number' ||
    !Number.isFinite(value.aspectRatio) ||
    Math.abs(value.aspectRatio - expectedAspectRatio) > 1e-9
  ) {
    return failure('tool_result.result.image.aspectRatio does not match its dimensions')
  }
  const headerDimensions = imageHeaderDimensions(
    value.base64,
    value.mimeType as ToolImageMimeType
  )
  if (
    !headerDimensions ||
    headerDimensions.width !== value.width ||
    headerDimensions.height !== value.height
  ) {
    return failure(
      'tool_result.result.image bytes do not match the declared MIME type and dimensions'
    )
  }
  if (
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  ) {
    return failure('tool_result.result.image.sha256 must be a lowercase SHA-256 hex digest')
  }
  if (
    typeof value.captureId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value.captureId)
  ) {
    return failure('tool_result.result.image.captureId is invalid')
  }
  if (!isRevision(value.renderRevision)) {
    return failure('tool_result.result.image.renderRevision must be a positive safe integer')
  }
  return { ok: true, value: value as unknown as ToolImagePayload }
}

function validImageDimension(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) > 0 &&
    (value as number) <= MAX_TOOL_IMAGE_DIMENSION
  )
}

function decodedBase64Length(value: string): number | undefined {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value
    )
  ) {
    return undefined
  }

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  if (value.endsWith('==')) {
    const trailing = alphabet.indexOf(value[value.length - 3])
    if (trailing < 0 || (trailing & 0x0f) !== 0) return undefined
  } else if (value.endsWith('=')) {
    const trailing = alphabet.indexOf(value[value.length - 2])
    if (trailing < 0 || (trailing & 0x03) !== 0) return undefined
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}

function imageHeaderDimensions(
  base64: string,
  mimeType: ToolImageMimeType
): { width: number; height: number } | undefined {
  const bytes = decodeBase64Prefix(base64, 30)
  if (mimeType === 'image/png') {
    if (
      bytes.length < 24 ||
      !sameBytes(bytes, 0, [137, 80, 78, 71, 13, 10, 26, 10]) ||
      !sameBytes(bytes, 12, [73, 72, 68, 82])
    ) {
      return undefined
    }
    return {
      width: readUint32BigEndian(bytes, 16),
      height: readUint32BigEndian(bytes, 20)
    }
  }

  if (
    bytes.length < 30 ||
    !sameBytes(bytes, 0, [82, 73, 70, 70]) ||
    !sameBytes(bytes, 8, [87, 69, 66, 80])
  ) {
    return undefined
  }
  const chunk = String.fromCharCode(...bytes.slice(12, 16))
  if (chunk === 'VP8X') {
    return {
      width: 1 + readUint24LittleEndian(bytes, 24),
      height: 1 + readUint24LittleEndian(bytes, 27)
    }
  }
  if (chunk === 'VP8L' && bytes[20] === 0x2f) {
    return {
      width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
      height:
        1 +
        ((bytes[22] & 0xc0) >> 6) +
        (bytes[23] << 2) +
        ((bytes[24] & 0x0f) << 10)
    }
  }
  if (
    chunk === 'VP8 ' &&
    sameBytes(bytes, 23, [0x9d, 0x01, 0x2a])
  ) {
    return {
      width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
      height: (bytes[28] | (bytes[29] << 8)) & 0x3fff
    }
  }
  return undefined
}

function decodeBase64Prefix(value: string, maximumBytes: number): number[] {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes: number[] = []
  for (let index = 0; index < value.length && bytes.length < maximumBytes; index += 4) {
    const a = alphabet.indexOf(value[index])
    const b = alphabet.indexOf(value[index + 1])
    const c = value[index + 2] === '=' ? 0 : alphabet.indexOf(value[index + 2])
    const d = value[index + 3] === '=' ? 0 : alphabet.indexOf(value[index + 3])
    if (a < 0 || b < 0 || c < 0 || d < 0) return []
    bytes.push((a << 2) | (b >> 4))
    if (value[index + 2] !== '=') bytes.push(((b & 0x0f) << 4) | (c >> 2))
    if (value[index + 3] !== '=') bytes.push(((c & 0x03) << 6) | d)
  }
  return bytes.slice(0, maximumBytes)
}

function sameBytes(
  source: readonly number[],
  offset: number,
  expected: readonly number[]
): boolean {
  return expected.every((value, index) => source[offset + index] === value)
}

function readUint32BigEndian(bytes: readonly number[], offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  )
}

function readUint24LittleEndian(bytes: readonly number[], offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

export function validateToolResultForTool(
  name: string,
  value: unknown
): ProtocolParseResult<ToolResult> {
  const parsed = parseToolResult(value)
  if (!parsed.ok) return parsed
  if (
    parsed.value.image &&
    !IMAGE_CAPABLE_CAD_TOOL_NAME_SET.has(name)
  ) {
    return failure(`CAD tool "${name}" is not allowed to return an image`)
  }
  if (
    !parsed.value.image &&
    IMAGE_CAPABLE_CAD_TOOL_NAME_SET.has(name) &&
    !parsed.value.error
  ) {
    return failure(`CAD tool "${name}" returned no image`)
  }
  return parsed
}

export function modelImageInputSupport(
  model: Pick<ModelCapability, 'inputModalities'>
): 'supported' | 'unsupported' | 'unknown' {
  if (model.inputModalities === undefined) return 'unknown'
  return model.inputModalities.includes('image') ? 'supported' : 'unsupported'
}

export function parseAgentConfiguration(
  value: unknown
): ProtocolParseResult<AgentConfiguration> {
  if (!isRecord(value)) return failure('configuration must be an object')
  if (!hasOnlyKeys(value, ['provider', 'model', 'effort'])) {
    return failure('configuration contains unsupported fields')
  }
  if (!isProviderId(value.provider)) {
    return failure(`configuration.provider is unsupported: ${String(value.provider)}`)
  }
  if (!isNonEmptyString(value.model, MAX_IDENTIFIER_LENGTH)) {
    return failure('configuration.model must be a bounded non-empty string')
  }
  if (
    value.effort !== undefined &&
    !isNonEmptyString(value.effort, MAX_IDENTIFIER_LENGTH)
  ) {
    return failure('configuration.effort must be a bounded non-empty string when provided')
  }
  return { ok: true, value: value as unknown as AgentConfiguration }
}

function parseEffortCapability(value: unknown): ProtocolParseResult<EffortCapability> {
  if (!isRecord(value)) return failure('effort capability must be an object')
  if (!hasOnlyKeys(value, ['value', 'displayName', 'description', 'isDefault'])) {
    return failure('effort capability contains unsupported fields')
  }
  if (!isNonEmptyString(value.value, MAX_IDENTIFIER_LENGTH)) {
    return failure('effort capability value must be a bounded non-empty string')
  }
  if (value.value === 'ultra') {
    return failure('effort capability "ultra" is disabled because EnvCAD does not permit subagents')
  }
  if (!isNonEmptyString(value.displayName, MAX_IDENTIFIER_LENGTH)) {
    return failure('effort capability displayName must be a bounded non-empty string')
  }
  if (!isOptionalString(value.description)) {
    return failure('effort capability description must be bounded when provided')
  }
  if (typeof value.isDefault !== 'boolean') {
    return failure('effort capability isDefault must be a boolean')
  }
  return { ok: true, value: value as unknown as EffortCapability }
}

function parseModelCapability(value: unknown): ProtocolParseResult<ModelCapability> {
  if (!isRecord(value)) return failure('model capability must be an object')
  if (
    !hasOnlyKeys(value, [
      'id',
      'invocationName',
      'resolvedModel',
      'displayName',
      'description',
      'supportedEfforts',
      'defaultEffort',
      'inputModalities',
      'isDefault'
    ])
  ) {
    return failure('model capability contains unsupported fields')
  }
  for (const key of ['id', 'invocationName', 'displayName'] as const) {
    if (!isNonEmptyString(value[key], MAX_IDENTIFIER_LENGTH)) {
      return failure(`model capability ${key} must be a bounded non-empty string`)
    }
  }
  if (!isOptionalString(value.resolvedModel, MAX_IDENTIFIER_LENGTH)) {
    return failure('model capability resolvedModel must be bounded when provided')
  }
  if (typeof value.description !== 'string' || value.description.length > MAX_DESCRIPTION_LENGTH) {
    return failure('model capability description must be a bounded string')
  }
  if (
    !Array.isArray(value.supportedEfforts) ||
    value.supportedEfforts.length > MAX_EFFORTS_PER_MODEL
  ) {
    return failure('model capability supportedEfforts must be an array')
  }
  const efforts: EffortCapability[] = []
  const effortValues = new Set<string>()
  for (const rawEffort of value.supportedEfforts) {
    const parsed = parseEffortCapability(rawEffort)
    if (!parsed.ok) return failure(parsed.error)
    if (effortValues.has(parsed.value.value)) {
      return failure(`model capability contains duplicate effort "${parsed.value.value}"`)
    }
    effortValues.add(parsed.value.value)
    efforts.push(parsed.value)
  }
  if (
    value.defaultEffort !== undefined &&
    (!isNonEmptyString(value.defaultEffort, MAX_IDENTIFIER_LENGTH) ||
      !effortValues.has(value.defaultEffort))
  ) {
    return failure('model capability defaultEffort must reference an advertised effort')
  }
  const markedDefaults = efforts.filter((effort) => effort.isDefault)
  if (markedDefaults.length > 1) {
    return failure('model capability may advertise at most one default effort')
  }
  if (
    value.defaultEffort !== undefined &&
    (markedDefaults.length !== 1 || markedDefaults[0].value !== value.defaultEffort)
  ) {
    return failure('model capability default effort metadata is inconsistent')
  }
  if (value.inputModalities !== undefined) {
    if (
      !Array.isArray(value.inputModalities) ||
      value.inputModalities.length > INPUT_MODALITY_SET.size ||
      !value.inputModalities.every(
        (modality) =>
          typeof modality === 'string' &&
          INPUT_MODALITY_SET.has(modality as InputModality)
      ) ||
      new Set(value.inputModalities).size !== value.inputModalities.length
    ) {
      return failure(
        'model capability inputModalities must be unique supported modality names when provided'
      )
    }
  }
  if (typeof value.isDefault !== 'boolean') {
    return failure('model capability isDefault must be a boolean')
  }
  return { ok: true, value: value as unknown as ModelCapability }
}

export function parseProviderCapability(
  value: unknown
): ProtocolParseResult<ProviderCapability> {
  if (!isRecord(value)) return failure('provider capability must be an object')
  if (
    !hasOnlyKeys(value, [
      'id',
      'displayName',
      'status',
      'statusMessage',
      'executableVersion',
      'models',
      'discoveryMs'
    ])
  ) {
    return failure('provider capability contains unsupported fields')
  }
  if (!isProviderId(value.id)) {
    return failure(`provider capability id is unsupported: ${String(value.id)}`)
  }
  if (!isNonEmptyString(value.displayName, MAX_IDENTIFIER_LENGTH)) {
    return failure('provider capability displayName must be a bounded non-empty string')
  }
  if (typeof value.status !== 'string' || !PROVIDER_STATUS_SET.has(value.status)) {
    return failure(`provider capability status is unsupported: ${String(value.status)}`)
  }
  if (!isNonEmptyString(value.statusMessage)) {
    return failure('provider capability statusMessage must be a bounded non-empty string')
  }
  if (!isOptionalString(value.executableVersion, MAX_IDENTIFIER_LENGTH)) {
    return failure('provider capability executableVersion must be bounded when provided')
  }
  if (value.discoveryMs !== undefined && !isNonNegativeFinite(value.discoveryMs)) {
    return failure('provider capability discoveryMs must be a non-negative finite number')
  }
  if (
    !Array.isArray(value.models) ||
    value.models.length > MAX_MODELS_PER_PROVIDER
  ) {
    return failure('provider capability models must be an array')
  }
  const modelIds = new Set<string>()
  let defaultModels = 0
  for (const rawModel of value.models) {
    const parsed = parseModelCapability(rawModel)
    if (!parsed.ok) return failure(parsed.error)
    if (modelIds.has(parsed.value.id)) {
      return failure(`provider capability contains duplicate model "${parsed.value.id}"`)
    }
    modelIds.add(parsed.value.id)
    if (parsed.value.isDefault) defaultModels += 1
  }
  if (value.status === 'ready' && value.models.length === 0) {
    return failure('ready provider capability must advertise at least one model')
  }
  if (value.models.length > 0 && defaultModels !== 1) {
    return failure('provider capability with models must advertise exactly one default model')
  }
  return { ok: true, value: value as unknown as ProviderCapability }
}

function parseProviderList(value: unknown): ProtocolParseResult<ProviderCapability[]> {
  if (!Array.isArray(value) || value.length > PROVIDER_IDS.length) {
    return failure('providers must be a bounded array')
  }
  const providers: ProviderCapability[] = []
  const ids = new Set<ProviderId>()
  for (const rawProvider of value) {
    const parsed = parseProviderCapability(rawProvider)
    if (!parsed.ok) return failure(parsed.error)
    if (ids.has(parsed.value.id)) {
      return failure(`providers contains duplicate provider "${parsed.value.id}"`)
    }
    ids.add(parsed.value.id)
    providers.push(parsed.value)
  }
  return { ok: true, value: providers }
}

function parseTurnMetrics(value: unknown): ProtocolParseResult<TurnMetrics> {
  if (!isRecord(value)) return failure('assistant_done.metrics must be an object')
  if (
    !hasOnlyKeys(value, [
      'providerReadyMs',
      'conversationStartupMs',
      'firstTextMs',
      'firstToolCallMs',
      'totalMs',
      'toolCalls',
      'retries',
      'inputTokens',
      'outputTokens'
    ])
  ) {
    return failure('assistant_done.metrics contains unsupported fields')
  }
  if (!isNonNegativeFinite(value.totalMs)) {
    return failure('assistant_done.metrics.totalMs must be a non-negative finite number')
  }
  if (!Number.isSafeInteger(value.toolCalls) || (value.toolCalls as number) < 0) {
    return failure('assistant_done.metrics.toolCalls must be a non-negative integer')
  }
  for (const key of [
    'providerReadyMs',
    'conversationStartupMs',
    'firstTextMs',
    'firstToolCallMs'
  ] as const) {
    if (value[key] !== undefined && !isNonNegativeFinite(value[key])) {
      return failure(`assistant_done.metrics.${key} must be non-negative when provided`)
    }
  }
  for (const key of ['retries', 'inputTokens', 'outputTokens'] as const) {
    if (
      value[key] !== undefined &&
      (!Number.isSafeInteger(value[key]) || (value[key] as number) < 0)
    ) {
      return failure(
        `assistant_done.metrics.${key} must be a non-negative integer when provided`
      )
    }
  }
  return { ok: true, value: value as unknown as TurnMetrics }
}

export function parseClientMessage(value: unknown): ProtocolParseResult<ClientMessage> {
  if (!isRecord(value)) return failure('message must be a JSON object')

  switch (value.type) {
    case 'user_message': {
      if (
        !hasOnlyKeys(value, [
          'type',
          'text',
          'selectionSnapshot',
          'sheet',
          'configurationRevision'
        ])
      ) {
        return failure('user_message contains unsupported fields')
      }
      if (!isNonBlankPrompt(value.text)) {
        return failure('user_message.text must contain at least one non-whitespace character')
      }
      if (!isRevision(value.configurationRevision)) {
        return failure('user_message.configurationRevision must be a positive safe integer')
      }
      const selection = parseSelectionSnapshot(value.selectionSnapshot)
      if (!selection.ok) return failure(selection.error)
      const sheet = parseSheetSnapshot(value.sheet)
      if (!sheet.ok) return failure(sheet.error)
      return { ok: true, value: value as unknown as ClientMessage }
    }
    case 'tool_result': {
      if (
        !hasOnlyKeys(value, [
          'type',
          'callId',
          'result',
          'operationReceipt'
        ])
      ) {
        return failure('tool_result contains unsupported fields')
      }
      if (!isNonEmptyString(value.callId, MAX_IDENTIFIER_LENGTH)) {
        return failure('tool_result.callId must be a bounded non-empty string')
      }
      const result = parseToolResult(value.result)
      if (!result.ok) return failure(result.error)
      if (
        value.operationReceipt !== undefined &&
        !operationReceiptSchema.safeParse(value.operationReceipt).success
      ) {
        return failure('tool_result.operationReceipt must be a valid receipt')
      }
      return { ok: true, value: value as unknown as ClientMessage }
    }
    case 'operation_status': {
      if (!hasOnlyKeys(value, ['type', 'requestId', 'result'])) {
        return failure('operation_status contains unsupported fields')
      }
      if (!isNonEmptyString(value.requestId, MAX_IDENTIFIER_LENGTH)) {
        return failure('operation_status.requestId must be a bounded non-empty string')
      }
      if (!operationStatusResultSchema.safeParse(value.result).success) {
        return failure('operation_status.result must be a valid operation status')
      }
      return { ok: true, value: value as unknown as ClientMessage }
    }
    case 'interrupt':
    case 'refresh_ai_capabilities':
      if (!hasOnlyKeys(value, ['type'])) {
        return failure(`${String(value.type)} contains unsupported fields`)
      }
      return { ok: true, value: value as unknown as ClientMessage }
    case 'reset':
      if (!hasOnlyKeys(value, ['type', 'revision'])) {
        return failure('reset contains unsupported fields')
      }
      if (!isRevision(value.revision)) {
        return failure('reset.revision must be a positive safe integer')
      }
      return { ok: true, value: value as unknown as ClientMessage }
    case 'set_ai_configuration': {
      if (!hasOnlyKeys(value, ['type', 'revision', 'configuration'])) {
        return failure('set_ai_configuration contains unsupported fields')
      }
      if (!isRevision(value.revision)) {
        return failure('set_ai_configuration.revision must be a positive safe integer')
      }
      const configuration = parseAgentConfiguration(value.configuration)
      if (!configuration.ok) return failure(configuration.error)
      return { ok: true, value: value as unknown as ClientMessage }
    }
    default:
      return failure(`unsupported client message type: ${String(value.type)}`)
  }
}

export function parseServerMessage(value: unknown): ProtocolParseResult<ServerMessage> {
  if (!isRecord(value)) return failure('message must be a JSON object')

  switch (value.type) {
    case 'assistant_text_delta':
      if (!hasOnlyKeys(value, ['type', 'text'])) {
        return failure('assistant_text_delta contains unsupported fields')
      }
      return typeof value.text === 'string'
        ? { ok: true, value: value as unknown as ServerMessage }
        : failure('assistant_text_delta.text must be a string')
    case 'assistant_done': {
      if (
        !hasOnlyKeys(value, [
          'type',
          'provider',
          'model',
          'resolvedModel',
          'effort',
          'metrics'
        ])
      ) {
        return failure('assistant_done contains unsupported fields')
      }
      if (!isProviderId(value.provider)) {
        return failure('assistant_done.provider must be a supported provider')
      }
      if (!isNonEmptyString(value.model, MAX_IDENTIFIER_LENGTH)) {
        return failure('assistant_done.model must be a bounded non-empty string')
      }
      if (!isOptionalString(value.resolvedModel, MAX_IDENTIFIER_LENGTH)) {
        return failure('assistant_done.resolvedModel must be bounded when provided')
      }
      if (!isOptionalString(value.effort, MAX_IDENTIFIER_LENGTH)) {
        return failure('assistant_done.effort must be bounded when provided')
      }
      const metrics = parseTurnMetrics(value.metrics)
      if (!metrics.ok) return failure(metrics.error)
      return { ok: true, value: value as unknown as ServerMessage }
    }
    case 'tool_call':
      if (
        !hasOnlyKeys(value, [
          'type',
          'callId',
          'name',
          'input',
          'turnId',
          'operation'
        ])
      ) {
        return failure('tool_call contains unsupported fields')
      }
      if (!isNonEmptyString(value.callId, MAX_IDENTIFIER_LENGTH)) {
        return failure('tool_call.callId must be a bounded non-empty string')
      }
      if (!isNonEmptyString(value.name, MAX_IDENTIFIER_LENGTH) || !CAD_TOOL_NAME_SET.has(value.name)) {
        return failure(`tool_call.name is not a registered CAD tool: ${String(value.name)}`)
      }
      if (
        value.turnId !== undefined &&
        !isNonEmptyString(value.turnId, MAX_IDENTIFIER_LENGTH)
      ) {
        return failure('tool_call.turnId must be a bounded non-empty string')
      }
      if (value.operation !== undefined) {
        const operation = cadOperationRequestSchema.safeParse(value.operation)
        if (!operation.success) {
          return failure('tool_call.operation must be a valid CAD operation')
        }
        if (
          !value.turnId ||
          operation.data.turnId !== value.turnId ||
          operation.data.toolName !== value.name
        ) {
          return failure('tool_call.operation identity must match its turn and tool')
        }
        if (!toolCallMayMutate(value.name, value.input)) {
          return failure('read-only tool_call must not carry operation metadata')
        }
      }
      return { ok: true, value: value as unknown as ServerMessage }
    case 'get_operation_status':
      if (
        !hasOnlyKeys(value, [
          'type',
          'turnId',
          'requestId',
          'operationId'
        ])
      ) {
        return failure('get_operation_status contains unsupported fields')
      }
      if (
        !isNonEmptyString(value.turnId, MAX_IDENTIFIER_LENGTH) ||
        !isNonEmptyString(value.requestId, MAX_IDENTIFIER_LENGTH) ||
        !isNonEmptyString(value.operationId, MAX_IDENTIFIER_LENGTH)
      ) {
        return failure(
          'get_operation_status identifiers must be bounded non-empty strings'
        )
      }
      return { ok: true, value: value as unknown as ServerMessage }
    case 'status':
      if (!hasOnlyKeys(value, ['type', 'state'])) {
        return failure('status contains unsupported fields')
      }
      return value.state === 'thinking' || value.state === 'idle'
        ? { ok: true, value: value as unknown as ServerMessage }
        : failure('status.state must be "thinking" or "idle"')
    case 'error':
      if (!hasOnlyKeys(value, ['type', 'message', 'provider'])) {
        return failure('error contains unsupported fields')
      }
      if (!isNonEmptyString(value.message)) {
        return failure('error.message must be a bounded non-empty string')
      }
      if (value.provider !== undefined && !isProviderId(value.provider)) {
        return failure('error.provider must be supported when provided')
      }
      return { ok: true, value: value as unknown as ServerMessage }
    case 'ai_capabilities': {
      if (!hasOnlyKeys(value, ['type', 'providers', 'refreshing'])) {
        return failure('ai_capabilities contains unsupported fields')
      }
      if (typeof value.refreshing !== 'boolean') {
        return failure('ai_capabilities.refreshing must be a boolean')
      }
      const providers = parseProviderList(value.providers)
      return providers.ok
        ? { ok: true, value: value as unknown as ServerMessage }
        : failure(providers.error)
    }
    case 'ai_provider_status': {
      if (!hasOnlyKeys(value, ['type', 'provider'])) {
        return failure('ai_provider_status contains unsupported fields')
      }
      const provider = parseProviderCapability(value.provider)
      return provider.ok
        ? { ok: true, value: value as unknown as ServerMessage }
        : failure(provider.error)
    }
    case 'ai_configuration_applied': {
      if (
        !hasOnlyKeys(value, [
          'type',
          'revision',
          'configuration',
          'newConversation'
        ])
      ) {
        return failure('ai_configuration_applied contains unsupported fields')
      }
      if (!isRevision(value.revision)) {
        return failure('ai_configuration_applied.revision must be a positive safe integer')
      }
      const configuration = parseAgentConfiguration(value.configuration)
      if (!configuration.ok) return failure(configuration.error)
      if (typeof value.newConversation !== 'boolean') {
        return failure('ai_configuration_applied.newConversation must be a boolean')
      }
      return { ok: true, value: value as unknown as ServerMessage }
    }
    case 'ai_configuration_rejected':
      if (!hasOnlyKeys(value, ['type', 'revision', 'message'])) {
        return failure('ai_configuration_rejected contains unsupported fields')
      }
      if (!isRevision(value.revision)) {
        return failure('ai_configuration_rejected.revision must be a positive safe integer')
      }
      return isNonEmptyString(value.message)
        ? { ok: true, value: value as unknown as ServerMessage }
        : failure('ai_configuration_rejected.message must be a bounded non-empty string')
    default:
      return failure(`unsupported server message type: ${String(value.type)}`)
  }
}
