import {
  discoverCodexExecutable,
  isCodexAuthenticatedWithChatGpt,
  type CodexDiscoveryResult
} from '../../../desktop/codexExecutable'
import type {
  AgentConfiguration,
  ModelCapability,
  ProviderCapability
} from '../../../src/agent/protocol'
import {
  CAD_TOOL_SPECS,
  executeCadTool,
  type CadToolBridge
} from '../cadToolSpecs'
import { createEffortCapabilities } from '../providerCatalog'
import { SYSTEM_PROMPT } from '../systemPrompt'
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
  type CodexNotification,
  type CodexServerRequest
} from './codexAppServerClient'
import {
  attestCodexMcpIsolation,
  probeCodexMcpServerNames
} from './codexIsolation'
import {
  buildCodexThreadSecurityConfig,
  CODEX_APPROVAL_POLICY,
  CODEX_SANDBOX_MODE,
  OFFICIAL_CODEX_MODEL_PROVIDER
} from './codexSecurityConfig'
import {
  presentBlockedEnvironmentNames,
  redactProviderDiagnostic
} from './environment'
import { recordProviderPromptEvidence } from './acceptanceEvidence'
import type {
  AgentConversation,
  AgentEvent,
  AgentProvider,
  ProviderLogger
} from './types'

const SECURITY_INSTRUCTIONS = `${SYSTEM_PROMPT}

EnvCAD security boundary:
- Use only the dynamic CAD tools registered by EnvCAD.
- Never run commands, inspect or modify files, browse the web, use apps or connectors, invoke MCP servers, load skills or plugins, or delegate to subagents.
- The working directory is an empty, read-only runtime directory and is not drawing context.
- Stop and report a CAD tool failure; never invent a successful result.`
const CODEX_SECRET_NAMES = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN'
] as const
const CHATGPT_PLAN_TYPES = new Set([
  'free',
  'go',
  'plus',
  'pro',
  'prolite',
  'team',
  'self_serve_business_usage_based',
  'business',
  'enterprise_cbp_usage_based',
  'enterprise',
  'edu',
  'unknown'
])
const MAX_CODEX_MODEL_PAGES = 50
const MAX_CODEX_MODELS = 100
// Codex CLI 0.145 reports `vscode` for fresh app-server threads on Windows,
// while other app-server launch paths report `appServer`. The source is
// provenance metadata rather than an execution-policy field; keep the accepted
// set narrow and continue attesting every security-relevant field below.
const ALLOWED_CODEX_THREAD_SOURCES = new Set(['appServer', 'vscode'])

const DISALLOWED_ITEM_TYPES = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'collabAgentToolCall',
  'subAgentActivity',
  'webSearch',
  'imageView',
  'imageGeneration',
  'hookPrompt',
  'sleep'
])
const ALLOWED_ITEM_TYPES = new Set([
  'userMessage',
  'agentMessage',
  'reasoning',
  'plan',
  'dynamicToolCall',
  'contextCompaction'
])
const PASSIVE_NOTIFICATION_METHODS = new Set([
  'thread/started',
  'thread/status/changed',
  'turn/started',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/textDelta',
  'item/plan/delta',
  'turn/plan/updated',
  'serverRequest/resolved',
  'account/rateLimits/updated',
  'account/updated',
  'warning',
  'guardianWarning',
  'deprecationNotice',
  'model/safetyBuffering/updated',
  'model/verification',
  'windows/worldWritableWarning'
])
const SECURITY_NOTIFICATION_PREFIXES = [
  'item/commandExecution/',
  'item/fileChange/',
  'item/mcpToolCall/',
  'command/exec/',
  'process/',
  'app/',
  'mcpServer/',
  'hook/',
  'skills/',
  'fs/',
  'externalAgentConfig/',
  'fuzzyFileSearch/',
  'remoteControl/',
  'thread/goal/',
  'turn/diff/'
] as const

type ClientFactory = (options: CodexAppServerClientOptions) => CodexAppServerClient

export interface CodexProviderOptions {
  environment?: NodeJS.ProcessEnv
  runtimeDirectory: string
  discoverExecutable?: typeof discoverCodexExecutable
  authenticate?: typeof isCodexAuthenticatedWithChatGpt
  probeMcpServerNames?: (executablePath: string) => Promise<string[]>
  clientFactory?: ClientFactory
  logger?: ProviderLogger
}

interface CodexModel {
  id: string
  model: string
  displayName: string
  description: string
  hidden: boolean
  isDefault: boolean
  defaultReasoningEffort: string
  supportedReasoningEfforts: Array<{
    reasoningEffort: string
    description: string
  }>
}

interface ModelListResult {
  data: CodexModel[]
  nextCursor?: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every((key) => keys.has(key))
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 4_000
}

function assertChatGptAccount(value: unknown): void {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['account', 'requiresOpenaiAuth']) ||
    value.requiresOpenaiAuth !== true ||
    !isRecord(value.account) ||
    !hasOnlyKeys(value.account, ['email', 'planType', 'type']) ||
    value.account.type !== 'chatgpt' ||
    (value.account.email !== null &&
      (typeof value.account.email !== 'string' ||
        value.account.email.length > 4_000)) ||
    typeof value.account.planType !== 'string' ||
    !CHATGPT_PLAN_TYPES.has(value.account.planType)
  ) {
    throw new Error(
      'Codex app-server is not authenticated with the required ChatGPT login.'
    )
  }
}

function tokenCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function boundedStringArray(
  value: unknown,
  maximumLength = 1_000
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximumLength &&
    value.every((item) => typeof item === 'string' && item.length <= 4_000)
  )
}

function requestId(value: unknown): boolean {
  return (
    (typeof value === 'number' && Number.isSafeInteger(value)) ||
    (typeof value === 'string' && value.length > 0 && value.length <= 200)
  )
}

function parseModelListResult(value: unknown): ModelListResult {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error('Codex model/list returned an invalid response.')
  }
  if (
    value.nextCursor !== undefined &&
    value.nextCursor !== null &&
    !nonEmptyString(value.nextCursor)
  ) {
    throw new Error('Codex model/list returned an invalid pagination cursor.')
  }
  const data = value.data.map((raw): CodexModel => {
    if (!isRecord(raw)) throw new Error('Codex model/list returned a malformed model.')
    for (const key of ['id', 'model', 'displayName', 'description', 'defaultReasoningEffort'] as const) {
      if (!nonEmptyString(raw[key])) {
        throw new Error(`Codex model/list returned an invalid ${key}.`)
      }
    }
    if (
      typeof raw.hidden !== 'boolean' ||
      typeof raw.isDefault !== 'boolean' ||
      !Array.isArray(raw.supportedReasoningEfforts)
    ) {
      throw new Error('Codex model/list returned malformed capability metadata.')
    }
    const supportedReasoningEfforts = raw.supportedReasoningEfforts.map((effort) => {
      if (
        !isRecord(effort) ||
        !nonEmptyString(effort.reasoningEffort) ||
        typeof effort.description !== 'string'
      ) {
        throw new Error('Codex model/list returned a malformed reasoning effort.')
      }
      return {
        reasoningEffort: effort.reasoningEffort,
        description: effort.description
      }
    })
    return {
      id: raw.id as string,
      model: raw.model as string,
      displayName: raw.displayName as string,
      description: raw.description as string,
      hidden: raw.hidden,
      isDefault: raw.isDefault,
      defaultReasoningEffort: raw.defaultReasoningEffort as string,
      supportedReasoningEfforts
    }
  })
  return {
    data,
    ...(value.nextCursor ? { nextCursor: value.nextCursor } : {})
  }
}

function mapModels(models: readonly CodexModel[]): ModelCapability[] {
  const visible = models.filter(
    (model) =>
      !model.hidden &&
      // Omitting effort invokes the provider default. A model whose runtime
      // default is Ultra could therefore activate multi-agent orchestration
      // through the UI's "Default" option even if Ultra were hidden from the
      // effort list. Keep that model out of EnvCAD's single-agent catalog.
      model.defaultReasoningEffort !== 'ultra'
  )
  const mapped = visible.map((model) => {
    const descriptions = new Map(
      model.supportedReasoningEfforts.map((effort) => [
        effort.reasoningEffort,
        effort.description
      ])
    )
    const values = model.supportedReasoningEfforts
      .map((effort) => effort.reasoningEffort)
      .filter((effort) => effort !== 'ultra')
    const defaultEffort = values.includes(model.defaultReasoningEffort)
      ? model.defaultReasoningEffort
      : values[0]
    return {
      id: model.id,
      invocationName: model.model,
      ...(model.id !== model.model ? { resolvedModel: model.model } : {}),
      displayName: model.displayName,
      description: model.description,
      supportedEfforts: createEffortCapabilities(values, defaultEffort, descriptions),
      ...(defaultEffort ? { defaultEffort } : {}),
      isDefault: model.isDefault
    } satisfies ModelCapability
  })
  let defaultIndex = mapped.findIndex((model) => model.isDefault)
  if (defaultIndex < 0 && mapped.length > 0) defaultIndex = 0
  return mapped.map((model, index) => ({ ...model, isDefault: index === defaultIndex }))
}

function dynamicToolResult(result: { data?: unknown; error?: string }) {
  if (result.error) {
    return {
      contentItems: [{ type: 'inputText', text: result.error }],
      success: false
    }
  }
  return {
    contentItems: [
      {
        type: 'inputText',
        text:
          typeof result.data === 'string'
            ? result.data
            : JSON.stringify(result.data ?? null, null, 2)
      }
    ],
    success: true
  }
}

class TurnQueue {
  private events: AgentEvent[] = []
  private waiters: Array<{
    resolve(result: IteratorResult<AgentEvent>): void
    reject(error: Error): void
  }> = []
  private ended = false
  private failure: Error | undefined

  push(event: AgentEvent): void {
    if (this.ended || this.failure) return
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve({ value: event, done: false })
    else this.events.push(event)
  }

  end(): void {
    if (this.ended || this.failure) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true })
    }
  }

  fail(error: Error): void {
    if (this.ended || this.failure) return
    this.failure = error
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  async *iterate(): AsyncIterable<AgentEvent> {
    while (true) {
      if (this.events.length > 0) {
        yield this.events.shift()!
        continue
      }
      if (this.failure) throw this.failure
      if (this.ended) return
      const result = await new Promise<IteratorResult<AgentEvent>>((resolve, reject) => {
        this.waiters.push({ resolve, reject })
      })
      if (result.done) return
      yield result.value
    }
  }
}

class CodexConversation implements AgentConversation {
  private threadId = ''
  private announcedThreadId: string | undefined
  private currentTurnId: string | undefined
  private announcedTurnId: string | undefined
  private currentQueue: TurnQueue | undefined
  private closed = false
  private fatalError: Error | undefined
  private readonly removeNotificationListener: () => void
  private readonly removeProtocolErrorListener: () => void

  private constructor(
    private readonly configuration: AgentConfiguration,
    private readonly tools: CadToolBridge,
    private readonly client: CodexAppServerClient,
    private readonly runtimeDirectory: string,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly onClosed: () => void
  ) {
    client.setServerRequestHandler((request) => this.handleServerRequest(request))
    this.removeNotificationListener = client.onNotification((notification) =>
      this.handleNotification(notification)
    )
    this.removeProtocolErrorListener = client.onProtocolError((error) =>
      this.securityFailure(error)
    )
  }

  static async create(
    configuration: AgentConfiguration,
    tools: CadToolBridge,
    client: CodexAppServerClient,
    runtimeDirectory: string,
    environment: NodeJS.ProcessEnv,
    disabledMcpServerNames: readonly string[],
    onClosed: () => void
  ): Promise<CodexConversation> {
    const conversation = new CodexConversation(
      configuration,
      tools,
      client,
      runtimeDirectory,
      environment,
      onClosed
    )
    try {
      await client.start()
      await attestCodexMcpIsolation(
        client,
        runtimeDirectory,
        disabledMcpServerNames
      )
      assertChatGptAccount(
        await client.request('account/read', { refreshToken: false })
      )
      const result = await client.request('thread/start', {
        model: configuration.model,
        modelProvider: OFFICIAL_CODEX_MODEL_PROVIDER,
        cwd: runtimeDirectory,
        approvalPolicy: CODEX_APPROVAL_POLICY,
        sandbox: CODEX_SANDBOX_MODE,
        allowProviderModelFallback: false,
        ephemeral: true,
        experimentalRawEvents: false,
        environments: [],
        baseInstructions: SECURITY_INSTRUCTIONS,
        developerInstructions: SECURITY_INSTRUCTIONS,
        dynamicTools: CAD_TOOL_SPECS.map((spec) => ({
          type: 'function',
          name: spec.name,
          description: spec.description,
          inputSchema: spec.jsonSchema,
          deferLoading: false
        })),
        selectedCapabilityRoots: [],
        config: buildCodexThreadSecurityConfig(disabledMcpServerNames)
      })
      if (
        !isRecord(result) ||
        !isRecord(result.thread) ||
        !nonEmptyString(result.thread.id)
      ) {
        throw new Error('Codex thread/start returned an invalid thread id.')
      }
      conversation.threadId = result.thread.id
      if (
        conversation.announcedThreadId &&
        conversation.announcedThreadId !== conversation.threadId
      ) {
        throw new Error('Codex announced a different thread than thread/start returned.')
      }
      if (conversation.fatalError) throw conversation.fatalError
      return conversation
    } catch (error) {
      await conversation.close()
      throw error
    }
  }

  async *runTurn(input: { prompt: string }): AsyncIterable<AgentEvent> {
    if (this.fatalError) throw this.fatalError
    if (this.closed) throw new Error('Codex conversation is closed.')
    if (this.currentQueue) throw new Error('A Codex turn is already running.')
    const queue = new TurnQueue()
    this.currentQueue = queue
    try {
      await recordProviderPromptEvidence(
        'openai-codex',
        input.prompt,
        this.environment
      )
      const result = await this.client.request('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text: input.prompt, text_elements: [] }],
        model: this.configuration.model,
        ...(this.configuration.effort ? { effort: this.configuration.effort } : {})
      })
      if (!isRecord(result) || !isRecord(result.turn) || !nonEmptyString(result.turn.id)) {
        throw new Error('Codex turn/start returned an invalid turn id.')
      }
      this.currentTurnId = result.turn.id
      if (
        this.announcedTurnId &&
        this.announcedTurnId !== this.currentTurnId
      ) {
        throw new Error('Codex announced a different turn than turn/start returned.')
      }
      for await (const event of queue.iterate()) yield event
    } finally {
      this.currentQueue = undefined
      this.currentTurnId = undefined
      this.announcedTurnId = undefined
    }
  }

  async interrupt(): Promise<void> {
    if (!this.currentTurnId) return
    await this.client.request('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.currentTurnId
    })
  }

  async reset(): Promise<void> {
    await this.interrupt()
    this.currentQueue?.fail(new Error('Codex conversation was reset.'))
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      await this.interrupt()
    } catch {
      // Closing the app-server process below is authoritative.
    }
    this.currentQueue?.fail(new Error('Codex conversation closed.'))
    this.currentQueue = undefined
    this.removeNotificationListener()
    this.removeProtocolErrorListener()
    this.client.setServerRequestHandler(undefined)
    await this.client.close()
    this.onClosed()
  }

  private async handleServerRequest(request: CodexServerRequest): Promise<unknown> {
    if (!isRecord(request.params)) {
      throw new Error('Codex item/tool/call params must be an object.')
    }
    const params = request.params
    if (
      !hasOnlyKeys(params, [
        'arguments',
        'callId',
        'namespace',
        'threadId',
        'tool',
        'turnId'
      ]) ||
      !Object.prototype.hasOwnProperty.call(params, 'arguments')
    ) {
      throw new Error('Codex item/tool/call contains unsupported or missing fields.')
    }
    for (const key of ['callId', 'threadId', 'turnId', 'tool'] as const) {
      if (!nonEmptyString(params[key])) {
        throw new Error(`Codex item/tool/call has an invalid ${key}.`)
      }
    }
    if (
      params.threadId !== this.threadId ||
      !this.currentTurnId ||
      params.turnId !== this.currentTurnId
    ) {
      throw new Error('Codex item/tool/call referenced the wrong conversation.')
    }
    if (params.namespace !== undefined && params.namespace !== null) {
      throw new Error('Codex namespaced tools are disabled in EnvCAD.')
    }
    const result = await executeCadTool(
      this.tools,
      params.tool as string,
      params.arguments
    )
    if (result.error) {
      const failure = new Error(
        `Codex CAD tool ${String(params.tool)} failed: ${result.error}`
      )
      setImmediate(() => this.securityFailure(failure))
    }
    return dynamicToolResult(result)
  }

  private handleNotification(notification: CodexNotification): void {
    const { method, params } = notification
    if (method === 'thread/settings/updated') {
      const error = this.validateThreadSettingsUpdate(params)
      if (error) this.securityFailure(error)
      return
    }
    if (method === 'remoteControl/status/changed') {
      if (isRecord(params) && params.status === 'disabled') return
      this.securityFailure(
        new Error('Codex security boundary rejected active remote control.')
      )
      return
    }
    if (
      SECURITY_NOTIFICATION_PREFIXES.some((prefix) => method.startsWith(prefix)) ||
      method === 'model/rerouted'
    ) {
      this.securityFailure(
        new Error(`Codex security boundary rejected event "${method}".`)
      )
      return
    }
    if (method === 'error') {
      const detail =
        isRecord(params) && typeof params.message === 'string'
          ? `: ${params.message}`
          : ''
      this.securityFailure(new Error(`Codex app-server error${detail}`))
      return
    }
    if (method === 'item/started' || method === 'item/completed') {
      const timestampKey =
        method === 'item/started' ? 'startedAtMs' : 'completedAtMs'
      if (
        !isRecord(params) ||
        !hasOnlyKeys(params, ['item', timestampKey, 'threadId', 'turnId']) ||
        params.threadId !== this.threadId ||
        !this.currentTurnId ||
        params.turnId !== this.currentTurnId ||
        !tokenCount(params[timestampKey]) ||
        !isRecord(params.item) ||
        !nonEmptyString(params.item.type)
      ) {
        this.securityFailure(new Error(`Codex emitted malformed ${method} metadata.`))
        return
      }
      const itemType = params.item.type
      if (DISALLOWED_ITEM_TYPES.has(itemType) || !ALLOWED_ITEM_TYPES.has(itemType)) {
        this.securityFailure(
          new Error(`Codex security boundary rejected item type "${itemType}".`)
        )
      }
      return
    }
    if (method === 'item/agentMessage/delta') {
      if (
        !isRecord(params) ||
        !hasOnlyKeys(params, ['delta', 'itemId', 'threadId', 'turnId']) ||
        params.threadId !== this.threadId ||
        !this.currentTurnId ||
        params.turnId !== this.currentTurnId ||
        !nonEmptyString(params.itemId) ||
        typeof params.delta !== 'string'
      ) {
        this.securityFailure(new Error('Codex emitted malformed agent-message delta.'))
        return
      }
      this.currentQueue?.push({ type: 'text_delta', text: params.delta })
      return
    }
    if (method === 'thread/tokenUsage/updated') {
      if (
        !isRecord(params) ||
        !hasOnlyKeys(params, ['threadId', 'tokenUsage', 'turnId']) ||
        params.threadId !== this.threadId ||
        !this.currentTurnId ||
        params.turnId !== this.currentTurnId ||
        !isRecord(params.tokenUsage) ||
        !isRecord(params.tokenUsage.last) ||
        !tokenCount(params.tokenUsage.last.inputTokens) ||
        !tokenCount(params.tokenUsage.last.outputTokens)
      ) {
        this.securityFailure(new Error('Codex emitted malformed token-usage metadata.'))
        return
      }
      this.currentQueue?.push({
        type: 'token_usage',
        inputTokens: params.tokenUsage.last.inputTokens,
        outputTokens: params.tokenUsage.last.outputTokens
      })
      return
    }
    if (method === 'turn/completed') {
      if (
        !isRecord(params) ||
        !hasOnlyKeys(params, ['threadId', 'turn']) ||
        params.threadId !== this.threadId ||
        !isRecord(params.turn) ||
        !nonEmptyString(params.turn.id) ||
        !nonEmptyString(params.turn.status)
      ) {
        this.securityFailure(new Error('Codex emitted malformed turn/completed metadata.'))
        return
      }
      if (this.currentTurnId && params.turn.id !== this.currentTurnId) {
        this.securityFailure(new Error('Codex completed an unexpected turn.'))
        return
      }
      if (params.turn.status === 'completed') {
        this.currentQueue?.end()
      } else if (params.turn.status === 'interrupted') {
        this.currentQueue?.fail(new Error('Codex turn was interrupted.'))
      } else {
        const message =
          isRecord(params.turn.error) && typeof params.turn.error.message === 'string'
            ? params.turn.error.message
            : `Codex turn ended with status ${params.turn.status}.`
        this.currentQueue?.fail(new Error(redactProviderDiagnostic(message)))
      }
      return
    }
    if (PASSIVE_NOTIFICATION_METHODS.has(method)) {
      const error = this.validatePassiveNotification(method, params)
      if (error) this.securityFailure(error)
      return
    }
    this.securityFailure(
      new Error(`Codex app-server emitted unrecognized event "${method}".`)
    )
  }

  private validatePassiveNotification(
    method: string,
    params: unknown
  ): Error | undefined {
    const malformed = () =>
      new Error(`Codex emitted malformed ${method} metadata.`)
    const sameThread = (value: unknown) =>
      nonEmptyString(value) &&
      (value === this.threadId ||
        (!this.threadId && value === this.announcedThreadId))
    const sameTurn = (value: unknown) =>
      nonEmptyString(value) &&
      (value === this.currentTurnId ||
        (!this.currentTurnId && value === this.announcedTurnId))
    const turnScoped = (
      value: unknown,
      allowedKeys: readonly string[]
    ): value is Record<string, unknown> =>
      isRecord(value) &&
      hasOnlyKeys(value, allowedKeys) &&
      sameThread(value.threadId) &&
      sameTurn(value.turnId)

    if (method === 'thread/started') {
      if (
        !isRecord(params) ||
        !hasOnlyKeys(params, ['thread']) ||
        !isRecord(params.thread) ||
        !nonEmptyString(params.thread.id) ||
        params.thread.cwd !== this.runtimeDirectory ||
        params.thread.ephemeral !== true ||
        !ALLOWED_CODEX_THREAD_SOURCES.has(String(params.thread.source)) ||
        params.thread.modelProvider !== 'openai' ||
        (params.thread.parentThreadId !== undefined &&
          params.thread.parentThreadId !== null) ||
        (params.thread.forkedFromId !== undefined &&
          params.thread.forkedFromId !== null) ||
        (params.thread.agentRole !== undefined &&
          params.thread.agentRole !== null) ||
        (params.thread.agentNickname !== undefined &&
          params.thread.agentNickname !== null) ||
        !Array.isArray(params.thread.turns) ||
        params.thread.turns.length !== 0
      ) {
        return malformed()
      }
      if (this.threadId && params.thread.id !== this.threadId) return malformed()
      this.announcedThreadId = params.thread.id
      return undefined
    }

    if (method === 'thread/status/changed') {
      if (
        !isRecord(params) ||
        !hasOnlyKeys(params, ['status', 'threadId']) ||
        !sameThread(params.threadId) ||
        !isRecord(params.status) ||
        !nonEmptyString(params.status.type)
      ) {
        return malformed()
      }
      if (
        params.status.type === 'idle' &&
        hasOnlyKeys(params.status, ['type'])
      ) {
        return undefined
      }
      if (
        params.status.type === 'active' &&
        hasOnlyKeys(params.status, ['activeFlags', 'type']) &&
        Array.isArray(params.status.activeFlags) &&
        params.status.activeFlags.length === 0
      ) {
        return undefined
      }
      return new Error(
        'Codex security boundary rejected a thread waiting for approval, user input, or system recovery.'
      )
    }

    if (method === 'turn/started') {
      if (
        !isRecord(params) ||
        !hasOnlyKeys(params, ['threadId', 'turn']) ||
        !sameThread(params.threadId) ||
        !isRecord(params.turn) ||
        !hasOnlyKeys(params.turn, [
          'completedAt',
          'durationMs',
          'error',
          'id',
          'items',
          'itemsView',
          'startedAt',
          'status'
        ]) ||
        !nonEmptyString(params.turn.id) ||
        params.turn.status !== 'inProgress' ||
        !Array.isArray(params.turn.items) ||
        !params.turn.items.every(
          (item) =>
            isRecord(item) &&
            nonEmptyString(item.type) &&
            ALLOWED_ITEM_TYPES.has(item.type)
        )
      ) {
        return malformed()
      }
      if (this.currentTurnId && params.turn.id !== this.currentTurnId) {
        return malformed()
      }
      this.announcedTurnId = params.turn.id
      return undefined
    }

    if (method === 'item/reasoning/summaryPartAdded') {
      if (
        !turnScoped(params, [
          'itemId',
          'summaryIndex',
          'threadId',
          'turnId'
        ]) ||
        !nonEmptyString(params.itemId) ||
        !Number.isSafeInteger(params.summaryIndex)
      ) {
        return malformed()
      }
      return undefined
    }

    if (method === 'item/reasoning/summaryTextDelta') {
      if (
        !turnScoped(params, [
          'delta',
          'itemId',
          'summaryIndex',
          'threadId',
          'turnId'
        ]) ||
        typeof params.delta !== 'string' ||
        !nonEmptyString(params.itemId) ||
        !Number.isSafeInteger(params.summaryIndex)
      ) {
        return malformed()
      }
      return undefined
    }

    if (method === 'item/reasoning/textDelta') {
      if (
        !turnScoped(params, [
          'contentIndex',
          'delta',
          'itemId',
          'threadId',
          'turnId'
        ]) ||
        !Number.isSafeInteger(params.contentIndex) ||
        typeof params.delta !== 'string' ||
        !nonEmptyString(params.itemId)
      ) {
        return malformed()
      }
      return undefined
    }

    if (method === 'item/plan/delta') {
      if (
        !turnScoped(params, [
          'delta',
          'itemId',
          'threadId',
          'turnId'
        ]) ||
        typeof params.delta !== 'string' ||
        !nonEmptyString(params.itemId)
      ) {
        return malformed()
      }
      return undefined
    }

    if (method === 'turn/plan/updated') {
      if (
        !turnScoped(params, [
          'explanation',
          'plan',
          'threadId',
          'turnId'
        ]) ||
        (params.explanation !== undefined &&
          params.explanation !== null &&
          typeof params.explanation !== 'string') ||
        !Array.isArray(params.plan) ||
        params.plan.length > 1_000 ||
        !params.plan.every(
          (step) =>
            isRecord(step) &&
            hasOnlyKeys(step, ['status', 'step']) &&
            typeof step.step === 'string' &&
            (step.status === 'pending' ||
              step.status === 'inProgress' ||
              step.status === 'completed')
        )
      ) {
        return malformed()
      }
      return undefined
    }

    if (method === 'serverRequest/resolved') {
      if (
        !isRecord(params) ||
        !hasOnlyKeys(params, ['requestId', 'threadId']) ||
        !sameThread(params.threadId) ||
        !requestId(params.requestId)
      ) {
        return malformed()
      }
      return undefined
    }

    if (method === 'account/rateLimits/updated') {
      return !isRecord(params) ||
        !hasOnlyKeys(params, ['rateLimits']) ||
        !isRecord(params.rateLimits)
        ? malformed()
        : undefined
    }

    if (method === 'account/updated') {
      if (
        !isRecord(params) ||
        !hasOnlyKeys(params, ['authMode', 'planType']) ||
        params.authMode !== 'chatgpt' ||
        (params.planType !== undefined &&
          params.planType !== null &&
          !nonEmptyString(params.planType))
      ) {
        return new Error(
          'Codex security boundary rejected a non-ChatGPT authentication update.'
        )
      }
      return undefined
    }

    if (method === 'warning' || method === 'guardianWarning') {
      const requiredKeys =
        method === 'warning'
          ? ['message', 'threadId']
          : ['message', 'threadId']
      if (
        !isRecord(params) ||
        !hasOnlyKeys(params, requiredKeys) ||
        !nonEmptyString(params.message) ||
        (method === 'guardianWarning' &&
          !sameThread(params.threadId)) ||
        (method === 'warning' &&
          params.threadId !== undefined &&
          params.threadId !== null &&
          !sameThread(params.threadId))
      ) {
        return malformed()
      }
      return undefined
    }

    if (method === 'deprecationNotice') {
      if (
        !isRecord(params) ||
        !hasOnlyKeys(params, ['details', 'summary']) ||
        !nonEmptyString(params.summary) ||
        (params.details !== undefined &&
          params.details !== null &&
          typeof params.details !== 'string')
      ) {
        return malformed()
      }
      return undefined
    }

    if (method === 'model/safetyBuffering/updated') {
      if (
        !turnScoped(params, [
          'fasterModel',
          'model',
          'reasons',
          'showBufferingUi',
          'threadId',
          'turnId',
          'useCases'
        ]) ||
        !nonEmptyString(params.model) ||
        (params.fasterModel !== undefined &&
          params.fasterModel !== null &&
          !nonEmptyString(params.fasterModel)) ||
        !boundedStringArray(params.reasons) ||
        typeof params.showBufferingUi !== 'boolean' ||
        !boundedStringArray(params.useCases)
      ) {
        return malformed()
      }
      return undefined
    }

    if (method === 'model/verification') {
      if (
        !turnScoped(params, [
          'threadId',
          'turnId',
          'verifications'
        ]) ||
        !Array.isArray(params.verifications) ||
        !params.verifications.every(
          (verification) => verification === 'trustedAccessForCyber'
        )
      ) {
        return malformed()
      }
      return undefined
    }

    if (method === 'windows/worldWritableWarning') {
      if (
        !isRecord(params) ||
        !hasOnlyKeys(params, ['extraCount', 'failedScan', 'samplePaths']) ||
        !tokenCount(params.extraCount) ||
        typeof params.failedScan !== 'boolean' ||
        !boundedStringArray(params.samplePaths)
      ) {
        return malformed()
      }
      return undefined
    }

    return malformed()
  }

  private validateThreadSettingsUpdate(params: unknown): Error | undefined {
    if (
      !isRecord(params) ||
      !hasOnlyKeys(params, ['threadId', 'threadSettings']) ||
      params.threadId !== this.threadId ||
      !isRecord(params.threadSettings)
    ) {
      return new Error('Codex emitted malformed thread settings metadata.')
    }
    const settings = params.threadSettings
    if (
      !hasOnlyKeys(settings, [
        'activePermissionProfile',
        'approvalPolicy',
        'approvalsReviewer',
        'collaborationMode',
        'cwd',
        'effort',
        'model',
        'modelProvider',
        'multiAgentMode',
        'personality',
        'sandboxPolicy',
        'serviceTier',
        'summary'
      ]) ||
      settings.approvalPolicy !== 'never' ||
      settings.approvalsReviewer !== 'user' ||
      settings.cwd !== this.runtimeDirectory ||
      settings.model !== this.configuration.model ||
      settings.effort !== (this.configuration.effort ?? null) ||
      settings.modelProvider !== 'openai' ||
      (settings.activePermissionProfile !== undefined &&
        settings.activePermissionProfile !== null) ||
      settings.multiAgentMode !== 'explicitRequestOnly' ||
      !isRecord(settings.sandboxPolicy) ||
      !hasOnlyKeys(settings.sandboxPolicy, ['networkAccess', 'type']) ||
      settings.sandboxPolicy.type !== 'readOnly' ||
      (settings.sandboxPolicy.networkAccess !== undefined &&
        settings.sandboxPolicy.networkAccess !== false) ||
      !isRecord(settings.collaborationMode) ||
      !hasOnlyKeys(settings.collaborationMode, ['mode', 'settings']) ||
      settings.collaborationMode.mode !== 'default' ||
      !isRecord(settings.collaborationMode.settings) ||
      !hasOnlyKeys(settings.collaborationMode.settings, [
        'developer_instructions',
        'model',
        'reasoning_effort'
      ]) ||
      settings.collaborationMode.settings.model !== this.configuration.model ||
      settings.collaborationMode.settings.reasoning_effort !==
        (this.configuration.effort ?? null) ||
      (settings.collaborationMode.settings.developer_instructions !== null &&
        typeof settings.collaborationMode.settings.developer_instructions !==
          'string')
    ) {
      return new Error(
        'Codex security boundary rejected unexpected thread settings.'
      )
    }
    return undefined
  }

  private securityFailure(error: Error): void {
    if (this.fatalError) return
    const safe = new Error(redactProviderDiagnostic(error.message))
    this.fatalError = safe
    this.currentQueue?.fail(safe)
    if (this.currentTurnId) {
      void this.client
        .request('turn/interrupt', {
          threadId: this.threadId,
          turnId: this.currentTurnId
        })
        .catch(() => {})
    }
    this.closed = true
    this.removeNotificationListener()
    this.removeProtocolErrorListener()
    this.client.setServerRequestHandler(undefined)
    void this.client
      .close()
      .catch(() => {})
      .finally(this.onClosed)
  }
}

export class CodexProvider implements AgentProvider {
  readonly id = 'openai-codex' as const
  readonly displayName = 'OpenAI Codex'
  private capability: ProviderCapability = {
    id: this.id,
    displayName: this.displayName,
    status: 'checking',
    statusMessage: 'Checking OpenAI Codex…',
    models: []
  }
  private executablePath: string | undefined
  private disabledMcpServerNames: string[] = []
  private readonly environment: NodeJS.ProcessEnv
  private readonly logger: ProviderLogger
  private readonly conversations = new Set<CodexConversation>()

  constructor(private readonly options: CodexProviderOptions) {
    this.environment = options.environment ?? process.env
    this.logger = options.logger ?? console
  }

  async discover(): Promise<ProviderCapability> {
    const startedAt = performance.now()
    const blocked = presentBlockedEnvironmentNames(
      this.environment,
      CODEX_SECRET_NAMES
    )
    if (blocked.length > 0) {
      return this.store({
        id: this.id,
        displayName: this.displayName,
        status: 'failed',
        statusMessage:
          `OpenAI Codex is disabled because ${blocked.join(', ')} is set. ` +
          'EnvCAD only permits the installed Codex CLI ChatGPT login. Remove the variable and refresh.',
        models: [],
        discoveryMs: performance.now() - startedAt
      })
    }
    let discovery: CodexDiscoveryResult
    try {
      discovery = await (this.options.discoverExecutable ?? discoverCodexExecutable)({
        environment: this.environment
      })
    } catch (error) {
      return this.store({
        id: this.id,
        displayName: this.displayName,
        status: 'failed',
        statusMessage: `Codex CLI discovery failed: ${redactProviderDiagnostic(
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
          'Codex CLI was not found. Install Codex CLI, run "codex login", then refresh.',
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
          `Codex CLI ${discovery.version} is incompatible; EnvCAD requires ` +
          `${discovery.expectedVersion}. Update Codex CLI, then refresh.`,
        executableVersion: discovery.version,
        models: [],
        discoveryMs: performance.now() - startedAt
      })
    }
    const authenticated = await (
      this.options.authenticate ?? isCodexAuthenticatedWithChatGpt
    )(discovery.executablePath)
    if (!authenticated) {
      return this.store({
        id: this.id,
        displayName: this.displayName,
        status: 'authentication-required',
        statusMessage:
          'Codex CLI is installed but is not signed in with ChatGPT. Run "codex login", then refresh.',
        executableVersion: discovery.version,
        models: [],
        discoveryMs: performance.now() - startedAt
      })
    }

    try {
      this.disabledMcpServerNames = await (
        this.options.probeMcpServerNames ??
        ((executablePath) =>
          probeCodexMcpServerNames({
            executablePath,
            runtimeDirectory: this.options.runtimeDirectory,
            environment: this.environment,
            clientFactory: this.options.clientFactory
          }))
      )(discovery.executablePath)
    } catch {
      this.executablePath = undefined
      this.disabledMcpServerNames = []
      return this.store({
        id: this.id,
        displayName: this.displayName,
        status: 'failed',
        statusMessage:
          'Codex configuration probe failed, so EnvCAD disabled Codex to preserve tool isolation.',
        executableVersion: discovery.version,
        models: [],
        discoveryMs: performance.now() - startedAt
      })
    }

    const client = this.createClient(discovery.executablePath)
    let discoveryPhase:
      | 'isolation'
      | 'account'
      | 'models' = 'isolation'
    try {
      await client.start()
      await attestCodexMcpIsolation(
        client,
        this.options.runtimeDirectory,
        this.disabledMcpServerNames
      )
      discoveryPhase = 'account'
      assertChatGptAccount(
        await client.request('account/read', { refreshToken: false })
      )
      discoveryPhase = 'models'
      const models: CodexModel[] = []
      const seenCursors = new Set<string>()
      let cursor: string | null = null
      let pageCount = 0
      do {
        if (cursor && seenCursors.has(cursor)) {
          throw new Error('Codex model/list returned a repeated pagination cursor.')
        }
        if (cursor) seenCursors.add(cursor)
        pageCount += 1
        if (pageCount > MAX_CODEX_MODEL_PAGES) {
          throw new Error('Codex model/list exceeded the pagination limit.')
        }
        const page = parseModelListResult(
          await client.request('model/list', {
            cursor,
            includeHidden: false
          })
        )
        if (models.length + page.data.length > MAX_CODEX_MODELS) {
          throw new Error('Codex model/list exceeded the model limit.')
        }
        models.push(...page.data)
        cursor = page.nextCursor ?? null
      } while (cursor)
      const mapped = mapModels(models)
      if (mapped.length === 0) throw new Error('Codex returned an empty visible model catalog')
      this.executablePath = discovery.executablePath
      return this.store({
        id: this.id,
        displayName: this.displayName,
        status: 'ready',
        statusMessage: `Codex CLI ${discovery.version} is ready using the existing ChatGPT login.`,
        executableVersion: discovery.version,
        models: mapped,
        discoveryMs: performance.now() - startedAt
      })
    } catch (error) {
      this.executablePath = undefined
      this.disabledMcpServerNames = []
      const prefix =
        discoveryPhase === 'isolation'
          ? 'Codex isolation attestation failed'
          : discoveryPhase === 'account'
            ? 'Codex ChatGPT account verification failed'
            : 'Codex model discovery failed'
      return this.store({
        id: this.id,
        displayName: this.displayName,
        status: 'failed',
        statusMessage: `${prefix}: ${redactProviderDiagnostic(
          error instanceof Error ? error.message : error
        )}`,
        executableVersion: discovery.version,
        models: [],
        discoveryMs: performance.now() - startedAt
      })
    } finally {
      await client.close()
    }
  }

  async createConversation(
    configuration: AgentConfiguration,
    tools: CadToolBridge
  ): Promise<AgentConversation> {
    if (this.capability.status !== 'ready' || !this.executablePath) {
      throw new Error(`OpenAI Codex is unavailable: ${this.capability.statusMessage}`)
    }
    const client = this.createClient(this.executablePath)
    let conversation: CodexConversation | undefined
    conversation = await CodexConversation.create(
      configuration,
      tools,
      client,
      this.options.runtimeDirectory,
      this.environment,
      this.disabledMcpServerNames,
      () => {
        if (conversation) this.conversations.delete(conversation)
      }
    )
    this.conversations.add(conversation)
    return conversation
  }

  async close(): Promise<void> {
    await Promise.all([...this.conversations].map((conversation) => conversation.close()))
    this.conversations.clear()
  }

  private createClient(executablePath: string): CodexAppServerClient {
    const factory =
      this.options.clientFactory ??
      ((options: CodexAppServerClientOptions) => new CodexAppServerClient(options))
    return factory({
      executablePath,
      runtimeDirectory: this.options.runtimeDirectory,
      environment: this.environment,
      disabledMcpServerNames: this.disabledMcpServerNames,
      logger: this.logger
    })
  }

  private store(capability: ProviderCapability): ProviderCapability {
    this.capability = capability
    return capability
  }
}
