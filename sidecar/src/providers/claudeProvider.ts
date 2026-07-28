import {
  query,
  type ModelInfo,
  type Query,
  type SDKRateLimitInfo,
  type SDKResultError,
  type SDKSystemMessage
} from '@anthropic-ai/claude-agent-sdk'
import {
  discoverClaudeExecutable,
  isClaudeAuthenticated,
  type ClaudeDiscoveryResult
} from '../../../desktop/claudeExecutable'
import type {
  AgentConfiguration,
  ModelCapability,
  ProviderCapability
} from '../../../src/agent/protocol'
import { createCadMcpServer } from '../cadTools'
import { CAD_TOOL_NAMES, type CadToolBridge } from '../cadToolSpecs'
import { createEffortCapabilities } from '../providerCatalog'
import { SYSTEM_PROMPT } from '../systemPrompt'
import { recordProviderPromptEvidence } from './acceptanceEvidence'
import {
  presentBlockedEnvironmentNames,
  redactProviderDiagnostic,
  sanitizedProviderEnvironment
} from './environment'
import type {
  AgentConversation,
  AgentEvent,
  AgentProvider,
  ProviderLogger
} from './types'

const DISCOVERY_TIMEOUT_MS = 20_000
const CLAUDE_SECRET_NAMES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN'
] as const
const ALLOWED_CLAUDE_TOOLS = new Set(
  CAD_TOOL_NAMES.map((name) => `mcp__cad__${name}`)
)

type ClaudeQueryFactory = typeof query

export interface ClaudeProviderOptions {
  environment?: NodeJS.ProcessEnv
  runtimeDirectory: string
  queryFactory?: ClaudeQueryFactory
  discoverExecutable?: typeof discoverClaudeExecutable
  authenticate?: typeof isClaudeAuthenticated
  logger?: ProviderLogger
  discoveryTimeoutMs?: number
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

async function* idleDiscoveryPrompt(): AsyncGenerator<never, void, unknown> {
  await new Promise<void>(() => {})
}

function formatResultError(result: SDKResultError): string {
  const details = result.errors.map((error) => error.trim()).filter(Boolean)
  const detail = details.length > 0 ? `: ${details.join('; ')}` : ''
  return `Claude agent error (${result.subtype})${detail}`
}

function formatRateLimitError(info: SDKRateLimitInfo): string {
  const limitType = info.rateLimitType ?? 'subscription'
  if (!info.resetsAt) return `Claude ${limitType} usage limit reached`
  const resetMilliseconds =
    info.resetsAt < 1_000_000_000_000 ? info.resetsAt * 1000 : info.resetsAt
  const resetDate = new Date(resetMilliseconds)
  const resetDetail = Number.isNaN(resetDate.getTime())
    ? ''
    : `; resets at ${resetDate.toISOString()}`
  return `Claude ${limitType} usage limit reached${resetDetail}`
}

export function assertClaudeSubscriptionAuthentication(
  message: SDKSystemMessage
): 'oauth' | 'none' {
  const source = message.apiKeySource as string
  if (source !== 'oauth' && source !== 'none') {
    throw new Error(
      `Claude authentication source must be the Claude Code subscription login, but the Agent SDK reported "${source}". ` +
        'EnvCAD requires the existing Claude Code subscription login and does not permit API-key authentication.'
    )
  }
  return source
}

function mapModels(models: readonly ModelInfo[]): ModelCapability[] {
  const seen = new Set<string>()
  const mapped = models
    .filter((model) => model.value.trim() && !seen.has(model.value))
    .map((model) => {
      seen.add(model.value)
      const effortValues = model.supportedEffortLevels ?? []
      const defaultEffort = effortValues.includes('high')
        ? 'high'
        : effortValues[0]
      return {
        id: model.value,
        invocationName: model.value,
        ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
        displayName: model.displayName,
        description: model.description,
        supportedEfforts: createEffortCapabilities(
          effortValues,
          defaultEffort
        ),
        ...(defaultEffort ? { defaultEffort } : {}),
        isDefault:
          model.value === 'default' ||
          /^default\b/i.test(model.displayName)
      } satisfies ModelCapability
    })

  let defaultIndex = mapped.findIndex((model) => model.isDefault)
  if (defaultIndex < 0 && mapped.length > 0) defaultIndex = 0
  return mapped.map((model, index) => ({ ...model, isDefault: index === defaultIndex }))
}

class ClaudeConversation implements AgentConversation {
  private sessionId: string | undefined
  private currentQuery: Query | undefined
  private closed = false
  private generation = 0

  constructor(
    private readonly configuration: AgentConfiguration,
    private readonly executablePath: string,
    private readonly runtimeDirectory: string,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly tools: CadToolBridge,
    private readonly queryFactory: ClaudeQueryFactory,
    private readonly logger: ProviderLogger
  ) {}

  async *runTurn(input: { prompt: string }): AsyncIterable<AgentEvent> {
    if (this.closed) throw new Error('Claude conversation is closed.')
    if (this.currentQuery) throw new Error('A Claude turn is already running.')
    const generation = this.generation
    let activeQuery: Query | undefined
    let rateLimitError: string | undefined
    let toolFailure: Error | undefined
    try {
      await recordProviderPromptEvidence(
        'claude-code',
        input.prompt,
        this.environment
      )
      activeQuery = this.queryFactory({
        prompt: input.prompt,
        options: {
          model: this.configuration.model,
          ...(this.configuration.effort
            ? { effort: this.configuration.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' }
            : {}),
          systemPrompt: SYSTEM_PROMPT,
          mcpServers: {
            cad: createCadMcpServer(this.tools, (error) => {
              toolFailure = error
              void activeQuery?.interrupt().catch(() => {})
            })
          },
          allowedTools: ['mcp__cad__*'],
          tools: [],
          permissionMode: 'dontAsk',
          pathToClaudeCodeExecutable: this.executablePath,
          cwd: this.runtimeDirectory,
          env: sanitizedProviderEnvironment(this.environment),
          settingSources: [],
          skills: [],
          plugins: [],
          strictMcpConfig: true,
          ...(this.sessionId ? { resume: this.sessionId } : {})
        }
      })
      this.currentQuery = activeQuery

      for await (const message of activeQuery) {
        if (message.type === 'system' && message.subtype === 'init') {
          const authSource = assertClaudeSubscriptionAuthentication(message)
          const forbidden = message.tools.filter(
            (name) => !ALLOWED_CLAUDE_TOOLS.has(name)
          )
          if (forbidden.length > 0) {
            throw new Error(
              `Claude security boundary rejected non-CAD tools: ${forbidden.join(', ')}`
            )
          }
          this.logger.log(
            authSource === 'oauth'
              ? '[sidecar] Claude authentication source verified: Claude Code login.'
              : '[sidecar] Claude authentication source verified: no API key; Claude Code login.'
          )
          if (message.session_id && generation === this.generation) {
            this.sessionId = message.session_id
          }
          if (message.model) yield { type: 'resolved_model', model: message.model }
        } else if (message.type === 'assistant') {
          if (message.error) {
            const detail = message.message.content
              .filter((block) => block.type === 'text')
              .map((block) => block.text.trim())
              .filter(Boolean)
              .join('\n')
            throw new Error(
              detail
                ? `Claude request failed (${message.error}): ${detail}`
                : rateLimitError ?? `Claude request failed: ${message.error}`
            )
          }
          for (const block of message.message.content) {
            if (block.type === 'text' && block.text) {
              yield { type: 'text_delta', text: block.text }
            }
          }
        } else if (message.type === 'auth_status' && message.error) {
          throw new Error(`Claude authentication failed: ${message.error}`)
        } else if (
          message.type === 'rate_limit_event' &&
          message.rate_limit_info.status === 'rejected'
        ) {
          rateLimitError = formatRateLimitError(message.rate_limit_info)
        } else if (message.type === 'result') {
          if (message.session_id && generation === this.generation) {
            this.sessionId = message.session_id
          }
          if (message.subtype !== 'success') {
            const resultError = formatResultError(message)
            throw new Error(rateLimitError ? `${rateLimitError}; ${resultError}` : resultError)
          }
          const usage = message.usage as
            | { input_tokens?: number; output_tokens?: number }
            | undefined
          if (usage) {
            yield {
              type: 'token_usage',
              ...(typeof usage.input_tokens === 'number'
                ? { inputTokens: usage.input_tokens }
                : {}),
              ...(typeof usage.output_tokens === 'number'
                ? { outputTokens: usage.output_tokens }
                : {})
            }
          }
        }
      }
      if (toolFailure) throw toolFailure
      if (rateLimitError) throw new Error(rateLimitError)
    } catch (error) {
      // Interrupting the SDK is how EnvCAD stops generation after a browser
      // CAD-tool error. Some SDK versions surface that interrupt before the
      // async iterator ends, so preserve the authoritative tool failure.
      if (toolFailure) throw toolFailure
      throw error
    } finally {
      activeQuery?.close()
      if (this.currentQuery === activeQuery) this.currentQuery = undefined
    }
  }

  async interrupt(): Promise<void> {
    await this.currentQuery?.interrupt()
  }

  async reset(): Promise<void> {
    this.generation += 1
    this.sessionId = undefined
    await this.interrupt()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.generation += 1
    this.sessionId = undefined
    const query = this.currentQuery
    this.currentQuery = undefined
    try {
      const interrupt = query?.interrupt()
      void interrupt?.catch(() => {
        // Closing the query below is authoritative.
      })
    } catch {
      // Closing the query below is authoritative.
    }
    query?.close()
  }
}

export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude-code' as const
  readonly displayName = 'Claude Code'
  private capability: ProviderCapability = {
    id: this.id,
    displayName: this.displayName,
    status: 'checking',
    statusMessage: 'Checking Claude Code…',
    models: []
  }
  private executablePath: string | undefined
  private readonly environment: NodeJS.ProcessEnv
  private readonly queryFactory: ClaudeQueryFactory
  private readonly logger: ProviderLogger

  constructor(private readonly options: ClaudeProviderOptions) {
    this.environment = options.environment ?? process.env
    this.queryFactory = options.queryFactory ?? query
    this.logger = options.logger ?? console
  }

  async discover(): Promise<ProviderCapability> {
    const startedAt = performance.now()
    const blocked = presentBlockedEnvironmentNames(this.environment, CLAUDE_SECRET_NAMES)
    if (blocked.length > 0) {
      return this.store({
        id: this.id,
        displayName: this.displayName,
        status: 'failed',
        statusMessage:
          `Claude Code is disabled because ${blocked.join(', ')} is set. ` +
          'EnvCAD only permits the installed Claude Code subscription login. Remove the variable and refresh.',
        models: [],
        discoveryMs: performance.now() - startedAt
      })
    }

    let discovery: ClaudeDiscoveryResult
    try {
      discovery = await (this.options.discoverExecutable ?? discoverClaudeExecutable)({
        environment: this.environment
      })
    } catch (error) {
      return this.store({
        id: this.id,
        displayName: this.displayName,
        status: 'failed',
        statusMessage: `Claude Code discovery failed: ${redactProviderDiagnostic(
          error instanceof Error ? error.message : error
        )}`,
        models: [],
        discoveryMs: performance.now() - startedAt
      })
    }
    if (discovery.status === 'missing') {
      return this.store({
        id: this.id,
        displayName: this.displayName,
        status: 'missing',
        statusMessage:
          'Claude Code was not found. Install Claude Code, run "claude auth login", then refresh.',
        models: [],
        discoveryMs: performance.now() - startedAt
      })
    }
    if (discovery.status === 'incompatible') {
      return this.store({
        id: this.id,
        displayName: this.displayName,
        status: 'incompatible',
        statusMessage:
          `Claude Code ${discovery.version} is incompatible; EnvCAD requires ` +
          `${discovery.expectedVersion}. Update Claude Code, then refresh.`,
        executableVersion: discovery.version,
        models: [],
        discoveryMs: performance.now() - startedAt
      })
    }
    const authenticated = await (this.options.authenticate ?? isClaudeAuthenticated)(
      discovery.executablePath
    )
    if (!authenticated) {
      return this.store({
        id: this.id,
        displayName: this.displayName,
        status: 'authentication-required',
        statusMessage:
          'Claude Code is installed but not signed in. Run "claude auth login", then refresh.',
        executableVersion: discovery.version,
        models: [],
        discoveryMs: performance.now() - startedAt
      })
    }

    let discoveryQuery: Query | undefined
    try {
      discoveryQuery = this.queryFactory({
        prompt: idleDiscoveryPrompt(),
        options: {
          pathToClaudeCodeExecutable: discovery.executablePath,
          tools: [],
          allowedTools: [],
          permissionMode: 'dontAsk',
          systemPrompt: 'EnvCAD capability discovery. Do not perform a model turn.',
          persistSession: false,
          cwd: this.options.runtimeDirectory,
          env: sanitizedProviderEnvironment(this.environment),
          settingSources: [],
          skills: [],
          plugins: []
        }
      })
      const models = await withTimeout(
        discoveryQuery.supportedModels(),
        this.options.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS,
        'Claude model discovery'
      )
      const mapped = mapModels(models)
      if (mapped.length === 0) throw new Error('Claude Code returned an empty model catalog')
      this.executablePath = discovery.executablePath
      return this.store({
        id: this.id,
        displayName: this.displayName,
        status: 'ready',
        statusMessage: `Claude Code ${discovery.version} is ready using the existing subscription login.`,
        executableVersion: discovery.version,
        models: mapped,
        discoveryMs: performance.now() - startedAt
      })
    } catch (error) {
      this.executablePath = undefined
      return this.store({
        id: this.id,
        displayName: this.displayName,
        status: 'failed',
        statusMessage: `Claude model discovery failed: ${redactProviderDiagnostic(
          error instanceof Error ? error.message : error
        )}`,
        executableVersion: discovery.version,
        models: [],
        discoveryMs: performance.now() - startedAt
      })
    } finally {
      discoveryQuery?.close()
    }
  }

  async createConversation(
    configuration: AgentConfiguration,
    tools: CadToolBridge
  ): Promise<AgentConversation> {
    if (this.capability.status !== 'ready' || !this.executablePath) {
      throw new Error(`Claude Code is unavailable: ${this.capability.statusMessage}`)
    }
    return new ClaudeConversation(
      configuration,
      this.executablePath,
      this.options.runtimeDirectory,
      this.environment,
      tools,
      this.queryFactory,
      this.logger
    )
  }

  async close(): Promise<void> {
    // Conversations own their Claude subprocesses.
  }

  private store(capability: ProviderCapability): ProviderCapability {
    this.capability = capability
    return capability
  }
}
