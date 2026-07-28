import { createHash, randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import type {
  AgentConfiguration,
  ClientMessage,
  ProviderCapability,
  SelectionSnapshot,
  ServerMessage,
  SheetSnapshot,
  ToolResult,
  TurnMetrics
} from '../../src/agent/protocol'
import {
  parseClientMessage,
  validateToolResultForTool
} from '../../src/agent/protocol'
import { getCadToolSpec, type CadToolBridge } from './cadToolSpecs'
import { redactProviderDiagnostic } from './providers/environment'
import { ProviderManager } from './providers/providerManager'

const TOOL_TIMEOUT_MS = 30_000

interface PendingCall {
  name: string
  resolve: (result: ToolResult) => void
  timer: ReturnType<typeof setTimeout>
}

interface ActiveTurn {
  startedAt: number
  firstTextMs?: number
  firstToolCallMs?: number
  toolCalls: number
  retries: number
  inputTokens?: number
  outputTokens?: number
}

export interface BridgeSessionOptions {
  providerManager: ProviderManager
  toolTimeoutMs?: number
  logger?: Pick<Console, 'log' | 'error'>
}

export function buildTurnPrompt(
  text: string,
  selection?: SelectionSnapshot,
  sheet?: SheetSnapshot
): string {
  const selectionNote =
    selection && selection.count > 0
      ? `Selection attached: ${selection.count} entities, ids [${selection.ids.join(', ')}]. Units: ${selection.units}.`
      : 'Selection attached: none.'
  const sheetNote = sheet
    ? `Active sheet: ${sheet.paper} ${sheet.orientation}, scale 1:${sheet.scaleDenominator}, ` +
      `drawing unit ${sheet.drawingUnit}${sheet.templateId ? `, template ${sheet.templateId}` : ''}.`
    : undefined
  const contextLines = [selectionNote, sheetNote].filter(Boolean).join('\n')
  return `${text}\n\n<context>\n${contextLines}\n</context>`
}

/**
 * One provider-neutral conversation coordinator per authenticated renderer
 * WebSocket. Provider discovery remains usable even when no provider is ready.
 */
export class BridgeSession {
  private readonly pendingCalls = new Map<string, PendingCall>()
  private lastSelectionSnapshot: SelectionSnapshot | undefined
  private lastSheet: SheetSnapshot | undefined
  private appliedConfiguration: AgentConfiguration | undefined
  private appliedRevision: number | undefined
  private latestRequestedRevision = 0
  private configurationQueue = Promise.resolve()
  private pendingConversationStartupMs: number | undefined
  private activeTurn: ActiveTurn | undefined
  private turnRunning = false
  private capabilityRefreshPending = false
  private discoveryInFlight: Promise<void> | undefined
  private closed = false
  private closePromise: Promise<void> | undefined
  private toolDispatchQueue = Promise.resolve()
  private readonly toolTimeoutMs: number
  private readonly logger: Pick<Console, 'log' | 'error'>
  private readonly manager: ProviderManager
  readonly discoveryReady: Promise<void>

  private readonly toolBridge: CadToolBridge = {
    callTool: (name, input) => this.callTool(name, input),
    getSelectionSnapshot: () => this.lastSelectionSnapshot
  }

  constructor(
    private readonly ws: WebSocket,
    options: BridgeSessionOptions
  ) {
    this.manager = options.providerManager
    this.toolTimeoutMs = options.toolTimeoutMs ?? TOOL_TIMEOUT_MS
    this.logger = options.logger ?? console
    ws.on('message', (raw) => this.handleRawMessage(raw))
    ws.on('close', () => {
      void this.cleanup('Browser connection closed')
    })
    ws.on('error', (error) => {
      this.logger.error('[sidecar] browser WebSocket error:', error)
    })
    this.discoveryReady = this.discoverCapabilities()
  }

  async close(reason = 'Sidecar session closed'): Promise<void> {
    await this.cleanup(reason)
  }

  private cleanup(reason: string): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.closePromise = (async () => {
      for (const pending of this.pendingCalls.values()) {
        clearTimeout(pending.timer)
        pending.resolve({ error: `${reason} while waiting for ${pending.name}` })
      }
      this.pendingCalls.clear()
      try {
        await this.manager.close()
      } catch (error) {
        this.logger.error('[sidecar] provider cleanup failed:', error)
      }
    })()
    return this.closePromise
  }

  private send(message: ServerMessage): boolean {
    if (!this.closed && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(message))
        return true
      } catch (error) {
        this.logger.error(`[sidecar] failed to send ${message.type}:`, error)
      }
    } else if (!this.closed) {
      this.logger.error(`[sidecar] cannot send ${message.type}: browser WebSocket is not open`)
    }
    return false
  }

  private reportProtocolError(message: string): void {
    this.logger.error(`[sidecar] rejected browser message: ${message}`)
    this.send({ type: 'error', message: `Invalid browser message: ${message}` })
  }

  private reportAgentError(error: unknown): void {
    const message = redactProviderDiagnostic(
      error instanceof Error ? error.message : error
    )
    this.logger.error(`[sidecar] agent error: ${message}`)
    this.send({
      type: 'error',
      message,
      ...(this.appliedConfiguration
        ? { provider: this.appliedConfiguration.provider }
        : {})
    })
  }

  private discoverCapabilities(): Promise<void> {
    if (this.discoveryInFlight) return this.discoveryInFlight
    this.send({
      type: 'ai_capabilities',
      providers: this.manager.catalog,
      refreshing: true
    })
    const discovery = (async () => {
      try {
        const providers = await this.manager.discover((provider) => {
          this.send({ type: 'ai_provider_status', provider })
        })
        this.send({
          type: 'ai_capabilities',
          providers,
          refreshing: false
        })
      } catch (error) {
        this.reportAgentError(error)
        this.send({
          type: 'ai_capabilities',
          providers: this.manager.catalog,
          refreshing: false
        })
      }
    })()
    this.discoveryInFlight = discovery
    void discovery.finally(() => {
      if (this.discoveryInFlight === discovery) {
        this.discoveryInFlight = undefined
      }
    })
    return discovery
  }

  private get capabilitiesBusy(): boolean {
    return this.capabilityRefreshPending || Boolean(this.discoveryInFlight)
  }

  private handleRawMessage(raw: unknown): void {
    let decoded: unknown
    try {
      decoded = JSON.parse(String(raw))
    } catch {
      this.reportProtocolError('malformed JSON')
      return
    }

    const parsed = parseClientMessage(decoded)
    if (!parsed.ok) {
      this.reportProtocolError(parsed.error)
      return
    }
    this.handleMessage(parsed.value)
  }

  private handleMessage(message: ClientMessage): void {
    switch (message.type) {
      case 'user_message':
        if (this.capabilitiesBusy) {
          this.send({
            type: 'error',
            message:
              'AI capabilities are refreshing; wait for the final provider catalog before sending.'
          })
          return
        }
        if (this.turnRunning) {
          this.send({
            type: 'error',
            message: 'An AI turn is already in progress; wait for status "idle" before sending again.'
          })
          return
        }
        if (
          !this.appliedConfiguration ||
          this.appliedRevision === undefined ||
          message.configurationRevision !== this.appliedRevision
        ) {
          this.send({
            type: 'error',
            message:
              'The selected AI configuration has not been acknowledged. Wait for configuration confirmation before sending.'
          })
          return
        }
        this.lastSelectionSnapshot = message.selectionSnapshot
        this.lastSheet = message.sheet
        void this.runTurn(message.text)
        break
      case 'tool_result':
        this.resolveToolResult(message.callId, message.result)
        break
      case 'interrupt':
        void this.manager.interrupt().catch((error) => this.reportAgentError(error))
        break
      case 'reset':
        if (this.capabilitiesBusy) {
          this.send({
            type: 'ai_configuration_rejected',
            revision: message.revision,
            message:
              'Cannot start a new conversation while AI capabilities are refreshing.'
          })
          return
        }
        if (this.turnRunning) {
          this.send({
            type: 'ai_configuration_rejected',
            revision: message.revision,
            message: 'Cannot start a new conversation while an AI turn is running.'
          })
          return
        }
        if (message.revision <= this.latestRequestedRevision) {
          this.send({
            type: 'ai_configuration_rejected',
            revision: message.revision,
            message: `Configuration revision ${message.revision} is stale.`
          })
          return
        }
        this.latestRequestedRevision = message.revision
        this.configurationQueue = this.configurationQueue
          .then(() => this.resetConversation(message.revision))
          .catch((error) => this.reportAgentError(error))
        break
      case 'refresh_ai_capabilities':
        if (this.turnRunning) {
          this.send({
            type: 'error',
            message: 'Cannot refresh AI capabilities while an AI turn is running.'
          })
          return
        }
        if (this.capabilitiesBusy) return
        this.capabilityRefreshPending = true
        this.configurationQueue = this.configurationQueue
          .then(() => this.discoverCapabilities())
          .catch((error) => this.reportAgentError(error))
          .finally(() => {
            this.capabilityRefreshPending = false
          })
        break
      case 'set_ai_configuration':
        this.queueConfigurationUpdate(message.revision, message.configuration)
        break
    }
  }

  private queueConfigurationUpdate(
    revision: number,
    configuration: AgentConfiguration
  ): void {
    if (this.capabilitiesBusy) {
      this.send({
        type: 'ai_configuration_rejected',
        revision,
        message:
          'Provider, model, and effort cannot change while AI capabilities are refreshing.'
      })
      return
    }
    if (this.turnRunning) {
      this.send({
        type: 'ai_configuration_rejected',
        revision,
        message: 'Provider, model, and effort cannot change while an AI turn is running.'
      })
      return
    }
    if (revision <= this.latestRequestedRevision) {
      this.send({
        type: 'ai_configuration_rejected',
        revision,
        message: `Configuration revision ${revision} is stale.`
      })
      return
    }
    this.latestRequestedRevision = revision
    this.configurationQueue = this.configurationQueue
      .then(() => this.applyConfiguration(revision, configuration))
      .catch((error) => this.reportAgentError(error))
  }

  private async applyConfiguration(
    revision: number,
    configuration: AgentConfiguration
  ): Promise<void> {
    if (this.closed) return
    const startedAt = performance.now()
    try {
      const result = await this.manager.applyConfiguration(configuration, this.toolBridge)
      this.pendingConversationStartupMs = performance.now() - startedAt
      this.appliedConfiguration = result.configuration
      this.appliedRevision = revision
      this.send({
        type: 'ai_configuration_applied',
        revision,
        configuration: result.configuration,
        newConversation: result.newConversation
      })
    } catch (error) {
      this.send({
        type: 'ai_configuration_rejected',
        revision,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private async resetConversation(revision: number): Promise<void> {
    const configuration = this.appliedConfiguration
    if (!configuration) {
      this.send({
        type: 'ai_configuration_rejected',
        revision,
        message: 'No acknowledged AI configuration is available to reset.'
      })
      return
    }
    const startedAt = performance.now()
    try {
      await this.manager.clearConversation()
      const result = await this.manager.applyConfiguration(configuration, this.toolBridge)
      this.pendingConversationStartupMs = performance.now() - startedAt
      this.appliedConfiguration = result.configuration
      this.appliedRevision = revision
      this.send({
        type: 'ai_configuration_applied',
        revision,
        configuration: result.configuration,
        newConversation: true
      })
    } catch (error) {
      this.appliedConfiguration = undefined
      this.appliedRevision = undefined
      this.send({
        type: 'ai_configuration_rejected',
        revision,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  callTool(name: string, input: unknown): Promise<ToolResult> {
    const dispatch = this.toolDispatchQueue.then(() => this.dispatchTool(name, input))
    this.toolDispatchQueue = dispatch.then(
      () => undefined,
      () => undefined
    )
    return dispatch
  }

  private dispatchTool(name: string, input: unknown): Promise<ToolResult> {
    const spec = getCadToolSpec(name)
    if (!spec) return Promise.resolve({ error: `Unknown CAD tool: ${name}` })
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ error: `Browser connection is not open; cannot run ${name}` })
    }
    const turn = this.activeTurn
    if (turn) {
      turn.toolCalls += 1
      turn.firstToolCallMs ??= performance.now() - turn.startedAt
    }

    return new Promise((resolve) => {
      const callId = randomUUID()
      const timer = setTimeout(() => {
        this.pendingCalls.delete(callId)
        resolve({
          error: `Timed out waiting for the browser to respond to ${name} after ${this.toolTimeoutMs / 1000}s`
        })
      }, this.toolTimeoutMs)
      timer.unref()
      this.pendingCalls.set(callId, { name, resolve, timer })

      if (!this.send({ type: 'tool_call', callId, name: spec.name, input })) {
        clearTimeout(timer)
        this.pendingCalls.delete(callId)
        resolve({ error: `Failed to send ${name} to the browser` })
      }
    })
  }

  private resolveToolResult(callId: string, result: ToolResult): void {
    const pending = this.pendingCalls.get(callId)
    if (!pending) {
      this.reportProtocolError(`tool_result references unknown callId "${callId}"`)
      return
    }
    clearTimeout(pending.timer)
    this.pendingCalls.delete(callId)
    const validated = validateToolResultForTool(pending.name, result)
    if (!validated.ok) {
      const message = `invalid ${pending.name} result: ${validated.error}`
      this.reportProtocolError(message)
      pending.resolve({ error: `Browser returned an invalid ${pending.name} result.` })
      return
    }
    if (
      validated.value.image &&
      createHash('sha256')
        .update(Buffer.from(validated.value.image.base64, 'base64'))
        .digest('hex') !== validated.value.image.sha256
    ) {
      const message =
        `invalid ${pending.name} result: ` +
        'tool_result.result.image.sha256 does not match the decoded image bytes'
      this.reportProtocolError(message)
      pending.resolve({ error: `Browser returned an invalid ${pending.name} result.` })
      return
    }
    pending.resolve(validated.value)
  }

  private providerCapability(configuration: AgentConfiguration): ProviderCapability | undefined {
    return this.manager.catalog.find((provider) => provider.id === configuration.provider)
  }

  private async runTurn(text: string): Promise<void> {
    const configuration = this.appliedConfiguration
    const conversation = this.manager.conversation
    if (!configuration || !conversation) {
      this.reportAgentError(new Error('No acknowledged AI configuration is active.'))
      return
    }

    const active: ActiveTurn = {
      startedAt: performance.now(),
      toolCalls: 0,
      retries: 0
    }
    this.activeTurn = active
    this.turnRunning = true
    this.send({ type: 'status', state: 'thinking' })

    let resolvedModel =
      this.providerCapability(configuration)?.models.find(
        (model) => model.invocationName === configuration.model
      )?.resolvedModel
    try {
      const prompt = buildTurnPrompt(text, this.lastSelectionSnapshot, this.lastSheet)
      for await (const event of conversation.runTurn({ prompt })) {
        if (event.type === 'text_delta') {
          active.firstTextMs ??= performance.now() - active.startedAt
          this.send({ type: 'assistant_text_delta', text: event.text })
        } else if (event.type === 'retry') {
          active.retries += 1
        } else if (event.type === 'resolved_model') {
          resolvedModel = event.model
        } else if (event.type === 'token_usage') {
          active.inputTokens = event.inputTokens
          active.outputTokens = event.outputTokens
        }
      }
    } catch (error) {
      this.reportAgentError(error)
    } finally {
      const capability = this.providerCapability(configuration)
      const metrics: TurnMetrics = {
        ...(capability?.discoveryMs !== undefined
          ? { providerReadyMs: capability.discoveryMs }
          : {}),
        ...(this.pendingConversationStartupMs !== undefined
          ? { conversationStartupMs: this.pendingConversationStartupMs }
          : {}),
        ...(active.firstTextMs !== undefined ? { firstTextMs: active.firstTextMs } : {}),
        ...(active.firstToolCallMs !== undefined
          ? { firstToolCallMs: active.firstToolCallMs }
          : {}),
        totalMs: performance.now() - active.startedAt,
        toolCalls: active.toolCalls,
        ...(active.retries > 0 ? { retries: active.retries } : {}),
        ...(active.inputTokens !== undefined ? { inputTokens: active.inputTokens } : {}),
        ...(active.outputTokens !== undefined ? { outputTokens: active.outputTokens } : {})
      }
      this.pendingConversationStartupMs = undefined
      this.send({
        type: 'assistant_done',
        provider: configuration.provider,
        model: configuration.model,
        ...(resolvedModel ? { resolvedModel } : {}),
        ...(configuration.effort ? { effort: configuration.effort } : {}),
        metrics
      })
      this.send({ type: 'status', state: 'idle' })
      this.activeTurn = undefined
      this.turnRunning = false
    }
  }
}
