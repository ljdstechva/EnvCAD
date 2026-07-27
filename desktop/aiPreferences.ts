import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  PROVIDER_IDS,
  type AgentConfiguration,
  type ProviderId
} from '../src/agent/protocol'

export const AI_PREFERENCES_SCHEMA_VERSION = 1
const MAX_VALUE_LENGTH = 200
const PROVIDER_SET = new Set<string>(PROVIDER_IDS)
const SECRET_LIKE_VALUE = /\b(?:sk-(?:ant|proj|svcacct)-|Bearer\s+eyJ|eyJ[A-Za-z0-9._-]{20,})/i

export interface AiPreferences {
  schemaVersion: typeof AI_PREFERENCES_SCHEMA_VERSION
  selectedProvider: ProviderId
  lastSelectedModels: Partial<Record<ProviderId, string>>
  lastSelectedEfforts: Partial<Record<ProviderId, Record<string, string>>>
  recommendedConfigurations?: Partial<Record<ProviderId, AgentConfiguration>>
}

export interface AiPreferencesLogger {
  warn(message: string): void
}

const TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'selectedProvider',
  'lastSelectedModels',
  'lastSelectedEfforts',
  'recommendedConfigurations'
])
const CONFIGURATION_KEYS = new Set(['provider', 'model', 'effort'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key))
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && PROVIDER_SET.has(value)
}

function isBoundedPreferenceValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_VALUE_LENGTH &&
    !SECRET_LIKE_VALUE.test(value)
  )
}

function parseProviderStringMap(
  value: unknown,
  label: string
): Partial<Record<ProviderId, string>> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`)
  const output: Partial<Record<ProviderId, string>> = {}
  for (const [provider, selected] of Object.entries(value)) {
    if (!isProviderId(provider) || !isBoundedPreferenceValue(selected)) {
      throw new Error(`${label} contains an invalid provider or value.`)
    }
    output[provider] = selected
  }
  return output
}

function parseEffortMap(
  value: unknown
): Partial<Record<ProviderId, Record<string, string>>> {
  if (!isRecord(value)) throw new Error('lastSelectedEfforts must be an object.')
  const output: Partial<Record<ProviderId, Record<string, string>>> = {}
  for (const [provider, modelEfforts] of Object.entries(value)) {
    if (!isProviderId(provider) || !isRecord(modelEfforts)) {
      throw new Error('lastSelectedEfforts contains an invalid provider.')
    }
    const safeEfforts: Record<string, string> = {}
    for (const [model, effort] of Object.entries(modelEfforts)) {
      if (!isBoundedPreferenceValue(model) || !isBoundedPreferenceValue(effort)) {
        throw new Error('lastSelectedEfforts contains an invalid model or effort.')
      }
      safeEfforts[model] = effort
    }
    output[provider] = safeEfforts
  }
  return output
}

function parseRecommendations(
  value: unknown
): Partial<Record<ProviderId, AgentConfiguration>> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('recommendedConfigurations must be an object.')
  const output: Partial<Record<ProviderId, AgentConfiguration>> = {}
  for (const [provider, rawConfiguration] of Object.entries(value)) {
    if (
      !isProviderId(provider) ||
      !isRecord(rawConfiguration) ||
      !hasOnlyKeys(rawConfiguration, CONFIGURATION_KEYS) ||
      rawConfiguration.provider !== provider ||
      !isBoundedPreferenceValue(rawConfiguration.model) ||
      (rawConfiguration.effort !== undefined &&
        !isBoundedPreferenceValue(rawConfiguration.effort))
    ) {
      throw new Error('recommendedConfigurations contains an invalid configuration.')
    }
    output[provider] = {
      provider,
      model: rawConfiguration.model,
      ...(rawConfiguration.effort ? { effort: rawConfiguration.effort } : {})
    }
  }
  return output
}

export function defaultAiPreferences(): AiPreferences {
  return {
    schemaVersion: AI_PREFERENCES_SCHEMA_VERSION,
    selectedProvider: 'claude-code',
    lastSelectedModels: {},
    lastSelectedEfforts: {}
  }
}

export function parseAiPreferences(value: unknown): AiPreferences {
  if (!isRecord(value) || !hasOnlyKeys(value, TOP_LEVEL_KEYS)) {
    throw new Error('AI preferences must be a strict object.')
  }
  if (value.schemaVersion !== AI_PREFERENCES_SCHEMA_VERSION) {
    throw new Error(`Unsupported AI preferences schema version "${String(value.schemaVersion)}".`)
  }
  if (!isProviderId(value.selectedProvider)) {
    throw new Error('selectedProvider is invalid.')
  }
  const recommendations = parseRecommendations(value.recommendedConfigurations)
  return {
    schemaVersion: AI_PREFERENCES_SCHEMA_VERSION,
    selectedProvider: value.selectedProvider,
    lastSelectedModels: parseProviderStringMap(
      value.lastSelectedModels,
      'lastSelectedModels'
    ),
    lastSelectedEfforts: parseEffortMap(value.lastSelectedEfforts),
    ...(recommendations ? { recommendedConfigurations: recommendations } : {})
  }
}

export class AiPreferencesStore {
  constructor(
    readonly filePath: string,
    private readonly logger: AiPreferencesLogger = console
  ) {}

  async load(): Promise<AiPreferences> {
    try {
      const decoded = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      return parseAiPreferences(decoded)
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code)
          : ''
      if (code !== 'ENOENT') {
        this.logger.warn('AI preferences were invalid and safe defaults were restored.')
      }
      return defaultAiPreferences()
    }
  }

  async save(value: unknown): Promise<AiPreferences> {
    const preferences = parseAiPreferences(value)
    const directory = path.dirname(this.filePath)
    await mkdir(directory, { recursive: true })
    const temporaryPath = path.join(
      directory,
      `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`
    )
    try {
      await writeFile(temporaryPath, `${JSON.stringify(preferences, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx'
      })
      await rename(temporaryPath, this.filePath)
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {})
    }
    return preferences
  }
}
