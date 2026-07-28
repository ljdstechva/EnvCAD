/**
 * Shared wire protocol between the renderer and the provider-neutral AI
 * sidecar. This module deliberately has no Node-only dependencies.
 */
import {
  CAD_TOOL_NAMES,
  type CadToolName
} from '../../sidecar/src/cadToolSpecs'

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
}

export interface SheetSnapshot {
  paper: string
  orientation: 'portrait' | 'landscape'
  scaleDenominator: number
  drawingUnit: string
  templateId?: string
  fields?: Record<string, string>
}

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
      configurationRevision: number
    }
  | { type: 'tool_result'; callId: string; result: ToolResult }
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
  | { type: 'tool_call'; callId: string; name: CadToolName; input: unknown }
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
const MAX_SELECTION_IDS = 10_000
const MAX_MODELS_PER_PROVIDER = 100
const MAX_EFFORTS_PER_MODEL = 10
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

function parseSelectionSnapshot(value: unknown): ProtocolParseResult<SelectionSnapshot> {
  if (!isRecord(value)) return failure('selectionSnapshot must be an object')
  if (!hasOnlyKeys(value, ['ids', 'count', 'units'])) {
    return failure('selectionSnapshot contains unsupported fields')
  }
  if (
    !Array.isArray(value.ids) ||
    value.ids.length > MAX_SELECTION_IDS ||
    !value.ids.every((id) => isNonEmptyString(id, MAX_IDENTIFIER_LENGTH))
  ) {
    return failure('selectionSnapshot.ids must be an array of bounded non-empty strings')
  }
  if (!Number.isInteger(value.count) || (value.count as number) < 0) {
    return failure('selectionSnapshot.count must be a non-negative integer')
  }
  if (value.count !== value.ids.length) {
    return failure('selectionSnapshot.count must equal selectionSnapshot.ids.length')
  }
  if (!isNonEmptyString(value.units, MAX_IDENTIFIER_LENGTH)) {
    return failure('selectionSnapshot.units must be a non-empty string')
  }
  return { ok: true, value: value as unknown as SelectionSnapshot }
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
  if (!hasOnlyKeys(value, ['data', 'error'])) {
    return failure('tool_result.result contains unsupported fields')
  }
  const hasData = hasOwn(value, 'data')
  const hasError = hasOwn(value, 'error')
  if (hasData === hasError) {
    return failure('tool_result.result must contain exactly one of data or error')
  }
  if (hasError && !isNonEmptyString(value.error)) {
    return failure('tool_result.result.error must be a bounded non-empty string')
  }
  return { ok: true, value: value as ToolResult }
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
      if (!hasOnlyKeys(value, ['type', 'callId', 'result'])) {
        return failure('tool_result contains unsupported fields')
      }
      if (!isNonEmptyString(value.callId, MAX_IDENTIFIER_LENGTH)) {
        return failure('tool_result.callId must be a bounded non-empty string')
      }
      const result = parseToolResult(value.result)
      if (!result.ok) return failure(result.error)
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
      if (!hasOnlyKeys(value, ['type', 'callId', 'name', 'input'])) {
        return failure('tool_call contains unsupported fields')
      }
      if (!isNonEmptyString(value.callId, MAX_IDENTIFIER_LENGTH)) {
        return failure('tool_call.callId must be a bounded non-empty string')
      }
      if (!isNonEmptyString(value.name, MAX_IDENTIFIER_LENGTH) || !CAD_TOOL_NAME_SET.has(value.name)) {
        return failure(`tool_call.name is not a registered CAD tool: ${String(value.name)}`)
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
