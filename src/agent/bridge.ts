import { reactive } from 'vue'
import type { AiPreferences } from '../../desktop/aiPreferences'
import {
  DEVELOPMENT_SESSION_TOKEN,
  ENVCAD_WEBSOCKET_PROTOCOL,
  sessionTokenProtocol,
  type SidecarConnectionConfig
} from '../../desktop/runtimeProtocol'
import { pushToast } from '../toast/toastStore'
import { verifyToolImageSha256 } from './imageIntegrity'
import {
  MAX_WEBSOCKET_PAYLOAD_BYTES,
  parseClientMessage,
  parseServerMessage,
  validateToolResultForTool,
  type AgentConfiguration,
  type ClientMessage,
  type ProviderCapability,
  type ProviderId,
  type ServerMessage,
  type SelectionSnapshot,
  type SheetSnapshot,
  type ToolResult,
  type TurnMetrics
} from './protocol'

export type ConnectionState = 'connecting' | 'online' | 'offline'
export type AgentStatus = 'idle' | 'thinking'

export interface AgentChatMessage {
  role: 'user' | 'assistant'
  text: string
  provider?: ProviderId
  model?: string
  resolvedModel?: string
  effort?: string
  metrics?: TurnMetrics
}

export interface PendingToolCall {
  callId: string
  name: string
  input: unknown
}

export interface AgentBridgeState {
  connectionState: ConnectionState
  offlineReason: string
  status: AgentStatus
  messages: AgentChatMessage[]
  streamingText: string
  pendingToolCalls: PendingToolCall[]
  providers: ProviderCapability[]
  selectedProvider: ProviderId
  selectedModelId: string
  selectedEffort?: string
  appliedConfiguration?: AgentConfiguration
  appliedRevision?: number
  pendingRevision?: number
  configurationReady: boolean
  configurationError: string
  preferencesReady: boolean
  refreshingCapabilities: boolean
  recommendedConfigurations: AiPreferences['recommendedConfigurations']
}

export type ToolHandler = (input: unknown) => Promise<ToolResult> | ToolResult
export type AgentBridgeEvent =
  | ServerMessage
  | { type: 'tool_result'; callId: string; name: string; result: ToolResult }
  | { type: 'connection_reset'; message: string }
export type AgentBridgeListener = (message: AgentBridgeEvent) => void
export type SavePreferences = (
  preferences: AiPreferences
) => Promise<AiPreferences>

export const DEFAULT_BROWSER_CONNECTION: SidecarConnectionConfig = {
  url: 'ws://127.0.0.1:8787',
  protocols: [
    ENVCAD_WEBSOCKET_PROTOCOL,
    sessionTokenProtocol(DEVELOPMENT_SESSION_TOKEN)
  ]
}
const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 5000

function defaultPreferences(): AiPreferences {
  return {
    schemaVersion: 1,
    selectedProvider: 'claude-code',
    lastSelectedModels: {},
    lastSelectedEfforts: {}
  }
}

function sameConfiguration(
  left: AgentConfiguration | undefined,
  right: AgentConfiguration | undefined
): boolean {
  return (
    left?.provider === right?.provider &&
    left?.model === right?.model &&
    left?.effort === right?.effort
  )
}

function clonePreferences(preferences: AiPreferences): AiPreferences {
  return JSON.parse(JSON.stringify(preferences)) as AiPreferences
}

/**
 * Browser-side half of the provider-neutral assistant bridge. It owns the
 * revisioned configuration handshake, persistence projection, WebSocket
 * reconnection, and serialized browser CAD-tool dispatch.
 */
export class AgentBridge {
  readonly state: AgentBridgeState = reactive({
    connectionState: 'connecting',
    offlineReason: '',
    status: 'idle',
    messages: [],
    streamingText: '',
    pendingToolCalls: [],
    providers: [],
    selectedProvider: 'claude-code',
    selectedModelId: '',
    selectedEffort: undefined,
    appliedConfiguration: undefined,
    appliedRevision: undefined,
    pendingRevision: undefined,
    configurationReady: false,
    configurationError: '',
    preferencesReady: false,
    refreshingCapabilities: false,
    recommendedConfigurations: undefined
  })

  private ws: WebSocket | undefined
  private reconnectDelayMs = RECONNECT_MIN_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private readonly handlers = new Map<string, ToolHandler>()
  private readonly listeners = new Set<AgentBridgeListener>()
  private stopped = true
  private connection: SidecarConnectionConfig = DEFAULT_BROWSER_CONNECTION
  private toolQueue: Promise<void> = Promise.resolve()
  private preferences: AiPreferences = defaultPreferences()
  private savePreferences: SavePreferences | undefined
  private preferenceSaveQueue: Promise<void> = Promise.resolve()
  private nextConfigurationRevision = 0
  private pendingConfiguration: AgentConfiguration | undefined
  private pendingResetRevision: number | undefined
  private readonly fallbackNotices = new Set<string>()
  private lastSendError: string | undefined

  registerHandler(name: string, handler: ToolHandler): void {
    this.handlers.set(name, handler)
  }

  subscribe(listener: AgentBridgeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  initializePreferences(
    preferences: AiPreferences = defaultPreferences(),
    savePreferences?: SavePreferences
  ): void {
    this.preferences = clonePreferences(preferences)
    this.savePreferences = savePreferences
    this.state.selectedProvider = preferences.selectedProvider
    this.state.recommendedConfigurations = preferences.recommendedConfigurations
      ? clonePreferences(preferences).recommendedConfigurations
      : undefined
    this.state.preferencesReady = true
    this.reconcileSelection()
  }

  configureConnection(connection: SidecarConnectionConfig): void {
    const unchanged =
      this.connection.url === connection.url &&
      this.connection.protocols.length === connection.protocols.length &&
      this.connection.protocols.every(
        (protocol, index) => protocol === connection.protocols[index]
      )
    if (unchanged) return

    this.stopSocket()
    this.connection = {
      url: connection.url,
      protocols: [...connection.protocols] as SidecarConnectionConfig['protocols']
    }
    this.reconnectDelayMs = RECONNECT_MIN_MS
  }

  waitForRuntime(reason: string): void {
    this.stopSocket()
    this.state.connectionState = 'connecting'
    this.state.offlineReason = reason
  }

  setUnavailable(reason: string): void {
    this.stopSocket()
    this.state.connectionState = 'offline'
    this.state.offlineReason = reason
  }

  connect(): void {
    if (!this.state.preferencesReady) this.initializePreferences()
    if (!this.stopped && this.ws?.readyState !== WebSocket.CLOSED) return
    this.stopped = false
    this.state.offlineReason = ''
    this.openSocket()
  }

  disconnect(): void {
    this.stopSocket()
    this.state.connectionState = 'offline'
  }

  selectProvider(provider: ProviderId): void {
    if (!this.canChangeConfiguration()) return
    if (!this.state.providers.some((candidate) => candidate.id === provider)) return
    this.invalidateConfiguration()
    this.state.selectedProvider = provider
    this.preferences.selectedProvider = provider
    this.persistPreferences()
    this.reconcileSelection()
  }

  selectModel(modelId: string): void {
    if (!this.canChangeConfiguration()) return
    const provider = this.selectedProviderCapability()
    const model = provider?.models.find((candidate) => candidate.id === modelId)
    if (!provider || !model) return
    this.invalidateConfiguration()
    this.state.selectedModelId = model.id
    this.preferences.lastSelectedModels[provider.id] = model.id
    const storedEffort =
      this.preferences.lastSelectedEfforts[provider.id]?.[model.id]
    this.state.selectedEffort = model.supportedEfforts.some(
      (effort) => effort.value === storedEffort
    )
      ? storedEffort
      : undefined
    this.persistPreferences()
    this.requestSelectedConfiguration()
  }

  selectEffort(effort: string | undefined): void {
    if (!this.canChangeConfiguration()) return
    const provider = this.selectedProviderCapability()
    const model = this.selectedModelCapability()
    if (!provider || !model) return
    if (
      effort !== undefined &&
      !model.supportedEfforts.some((candidate) => candidate.value === effort)
    ) {
      return
    }
    this.invalidateConfiguration()
    this.state.selectedEffort = effort
    const providerEfforts =
      this.preferences.lastSelectedEfforts[provider.id] ?? {}
    if (effort) providerEfforts[model.id] = effort
    else delete providerEfforts[model.id]
    this.preferences.lastSelectedEfforts[provider.id] = providerEfforts
    this.persistPreferences()
    this.requestSelectedConfiguration()
  }

  refreshCapabilities(): void {
    if (
      this.state.status === 'thinking' ||
      this.state.refreshingCapabilities
    ) {
      return
    }
    this.state.refreshingCapabilities = true
    if (!this.send({ type: 'refresh_ai_capabilities' })) {
      this.state.refreshingCapabilities = false
      this.reportBridgeError('Cannot refresh AI capabilities while the sidecar is offline.')
    }
  }

  sendUserMessage(
    text: string,
    selectionSnapshot: SelectionSnapshot,
    sheet: SheetSnapshot
  ): void {
    if (
      this.state.refreshingCapabilities ||
      !this.state.configurationReady ||
      !this.state.appliedRevision ||
      !this.state.appliedConfiguration
    ) {
      throw new Error(
        'Wait for the selected provider, model, and effort to be confirmed before sending.'
      )
    }
    const message: ClientMessage = {
      type: 'user_message',
      text,
      selectionSnapshot,
      sheet,
      configurationRevision: this.state.appliedRevision
    }
    if (!this.send(message)) {
      throw new Error(
        this.lastSendError ??
          'AI Assistant sidecar is offline; the message was not sent.'
      )
    }
    this.state.messages.push({ role: 'user', text })
  }

  interrupt(): void {
    if (!this.send({ type: 'interrupt' })) {
      console.error('[agent-bridge] cannot interrupt: sidecar is offline')
    }
  }

  reset(): boolean {
    if (!this.canChangeConfiguration()) return false
    const configuration = this.state.appliedConfiguration
    if (!configuration || this.state.appliedRevision === undefined) {
      this.reportBridgeError(
        'Cannot start a new conversation until the AI configuration is ready.'
      )
      return false
    }
    const revision = ++this.nextConfigurationRevision
    this.state.pendingRevision = revision
    this.pendingConfiguration = { ...configuration }
    this.pendingResetRevision = revision
    this.state.configurationReady = false
    this.state.configurationError = ''
    if (!this.send({ type: 'reset', revision })) {
      this.state.pendingRevision = undefined
      this.pendingConfiguration = undefined
      this.pendingResetRevision = undefined
      this.state.configurationError =
        'The new conversation could not be started because the sidecar is offline.'
      console.error('[agent-bridge] cannot reset: sidecar is offline')
      return false
    }
    return true
  }

  selectedProviderCapability(): ProviderCapability | undefined {
    return this.state.providers.find(
      (provider) => provider.id === this.state.selectedProvider
    )
  }

  selectedModelCapability() {
    return this.selectedProviderCapability()?.models.find(
      (model) => model.id === this.state.selectedModelId
    )
  }

  private canChangeConfiguration(): boolean {
    if (
      this.state.status !== 'thinking' &&
      !this.state.refreshingCapabilities
    ) {
      return true
    }
    pushToast(
      this.state.refreshingCapabilities
        ? 'Provider, model, and effort cannot change while capabilities are refreshing.'
        : 'Provider, model, and effort cannot change while the assistant is working.',
      'info'
    )
    return false
  }

  private invalidateConfiguration(): void {
    this.state.configurationReady = false
    this.state.configurationError = ''
    this.state.pendingRevision = undefined
    this.pendingConfiguration = undefined
    this.pendingResetRevision = undefined
  }

  private stopSocket(): void {
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    const previous = this.ws
    this.ws = undefined
    previous?.close()
    this.invalidateConfiguration()
    this.state.appliedConfiguration = undefined
    this.state.appliedRevision = undefined
    this.state.status = 'idle'
    this.state.streamingText = ''
    this.state.pendingToolCalls = []
    this.state.refreshingCapabilities = false
  }

  private openSocket(): void {
    this.state.connectionState = 'connecting'
    let ws: WebSocket
    try {
      ws = new WebSocket(this.connection.url, this.connection.protocols)
    } catch (error) {
      this.reportBridgeError(
        `Failed to create the sidecar WebSocket: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      this.state.connectionState = 'offline'
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return
      this.state.connectionState = 'online'
      this.state.refreshingCapabilities = false
      this.state.offlineReason = ''
      this.reconnectDelayMs = RECONNECT_MIN_MS
      this.invalidateConfiguration()
      this.state.appliedConfiguration = undefined
      this.state.appliedRevision = undefined
    })
    ws.addEventListener('message', (event) => {
      if (this.ws !== ws) return
      void this.handleServerMessage(String(event.data))
    })
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return
      const wasOnline = this.state.connectionState === 'online'
      const interruptedTurn =
        this.state.status === 'thinking' ||
        this.state.streamingText.length > 0 ||
        this.state.pendingToolCalls.length > 0
      this.ws = undefined
      this.invalidateConfiguration()
      this.state.appliedConfiguration = undefined
      this.state.appliedRevision = undefined
      this.state.status = 'idle'
      this.state.streamingText = ''
      this.state.pendingToolCalls = []
      this.state.refreshingCapabilities = false
      this.state.connectionState = 'offline'
      this.state.offlineReason =
        'AI Assistant disconnected. EnvCAD is reconnecting; CAD editing remains available.'
      if (wasOnline) {
        if (interruptedTurn) {
          const message =
            'AI Assistant disconnected during the active turn. The incomplete response was not carried into the replacement conversation.'
          this.state.messages.push({ role: 'assistant', text: `[error] ${message}` })
          this.emit({ type: 'connection_reset', message })
          pushToast(message, 'info')
        } else {
          pushToast('Assistant sidecar disconnected - reconnecting...', 'info')
        }
      }
      if (!this.stopped) this.scheduleReconnect()
    })
    ws.addEventListener('error', (event) => {
      console.error('[agent-bridge] WebSocket connection error:', event)
      ws.close()
    })
  }

  private scheduleReconnect(): void {
    clearTimeout(this.reconnectTimer)
    const delay = this.reconnectDelayMs
    this.reconnectDelayMs = Math.min(
      this.reconnectDelayMs * 2,
      RECONNECT_MAX_MS
    )
    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped) this.openSocket()
    }, delay)
  }

  private send(message: ClientMessage): boolean {
    this.lastSendError = undefined
    const parsed = parseClientMessage(message)
    if (!parsed.ok) {
      this.lastSendError = `Refusing to send invalid browser message: ${parsed.error}`
      this.reportBridgeError(this.lastSendError)
      return false
    }
    const serialized = JSON.stringify(parsed.value)
    const payloadBytes = new TextEncoder().encode(serialized).byteLength
    if (payloadBytes > MAX_WEBSOCKET_PAYLOAD_BYTES) {
      this.lastSendError =
        `The complete AI request is ${payloadBytes.toLocaleString()} bytes and exceeds ` +
        "EnvCAD's 2 MiB transport capacity. Reduce the prompt, selection, or sheet context and try again."
      this.reportBridgeError(this.lastSendError)
      return false
    }
    if (import.meta.env.DEV) {
      console.debug('[agent-bridge] ->', {
        type: message.type,
        payloadBytes,
        ...(message.type === 'user_message'
          ? { promptCharacters: message.text.length }
          : {})
      })
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(serialized)
        return true
      } catch (error) {
        this.lastSendError = `Failed to send ${message.type}: ${
          error instanceof Error ? error.message : String(error)
        }`
        this.reportBridgeError(this.lastSendError)
      }
    } else {
      this.lastSendError = 'AI Assistant sidecar is offline; the message was not sent.'
    }
    return false
  }

  private async handleServerMessage(raw: string): Promise<void> {
    let decoded: unknown
    try {
      decoded = JSON.parse(raw)
    } catch {
      this.reportBridgeError('Sidecar sent malformed JSON')
      return
    }
    const parsed = parseServerMessage(decoded)
    if (!parsed.ok) {
      this.reportBridgeError(`Sidecar sent an invalid message: ${parsed.error}`)
      return
    }
    const message = parsed.value
    if (import.meta.env.DEV) console.debug('[agent-bridge] <-', message)

    switch (message.type) {
      case 'assistant_text_delta':
        this.state.streamingText += message.text
        break
      case 'assistant_done':
        this.state.messages.push({
          role: 'assistant',
          text: this.state.streamingText,
          provider: message.provider,
          model: message.model,
          ...(message.resolvedModel
            ? { resolvedModel: message.resolvedModel }
            : {}),
          ...(message.effort ? { effort: message.effort } : {}),
          metrics: message.metrics
        })
        this.state.streamingText = ''
        break
      case 'status':
        this.state.status = message.state
        break
      case 'error':
        console.error(`[agent-bridge] sidecar error: ${message.message}`)
        this.state.messages.push({
          role: 'assistant',
          text: `[error] ${message.message}`,
          ...(message.provider ? { provider: message.provider } : {})
        })
        pushToast(message.message)
        break
      case 'tool_call':
        this.emit(message)
        this.enqueueToolCall(
          message.callId,
          message.name,
          message.input,
          this.ws
        )
        return
      case 'ai_capabilities':
        this.state.providers = message.providers
        this.state.refreshingCapabilities = message.refreshing
        this.reconcileSelection()
        break
      case 'ai_provider_status':
        this.mergeProviderCapability(message.provider)
        this.reconcileSelection()
        break
      case 'ai_configuration_applied':
        if (message.revision !== this.state.pendingRevision) return
        if (message.revision === this.pendingResetRevision) {
          this.state.messages = []
          this.state.streamingText = ''
          this.pendingResetRevision = undefined
        }
        this.state.pendingRevision = undefined
        this.pendingConfiguration = undefined
        this.state.appliedRevision = message.revision
        this.state.appliedConfiguration = message.configuration
        this.state.configurationReady = true
        this.state.configurationError = ''
        break
      case 'ai_configuration_rejected':
        if (message.revision !== this.state.pendingRevision) return
        if (message.revision === this.pendingResetRevision) {
          this.pendingResetRevision = undefined
        }
        this.state.pendingRevision = undefined
        this.pendingConfiguration = undefined
        this.state.configurationReady = false
        this.state.configurationError = message.message
        pushToast(message.message)
        break
    }
    this.emit(message)
  }

  private mergeProviderCapability(provider: ProviderCapability): void {
    const index = this.state.providers.findIndex(
      (candidate) => candidate.id === provider.id
    )
    if (index < 0) this.state.providers.push(provider)
    else this.state.providers.splice(index, 1, provider)
  }

  private reconcileSelection(): void {
    if (!this.state.preferencesReady) return
    const provider = this.selectedProviderCapability()
    if (!provider) return

    if (provider.status !== 'ready') {
      this.invalidateConfiguration()
      this.state.selectedModelId =
        this.preferences.lastSelectedModels[provider.id] ?? ''
      this.state.selectedEffort = undefined
      this.state.configurationError = provider.statusMessage
      return
    }

    const storedModel = this.preferences.lastSelectedModels[provider.id]
    const model =
      provider.models.find(
        (candidate) =>
          candidate.id === storedModel ||
          candidate.invocationName === storedModel
      ) ??
      provider.models.find((candidate) => candidate.isDefault) ??
      provider.models[0]
    if (!model) {
      this.invalidateConfiguration()
      this.state.configurationError = `${provider.displayName} returned no models.`
      return
    }

    if (storedModel && storedModel !== model.id) {
      this.noticeFallback(
        `${provider.id}:model:${storedModel}:${model.id}`,
        `${provider.displayName} no longer advertises ${storedModel}; using ${model.displayName}.`
      )
    }
    this.state.selectedModelId = model.id
    this.preferences.lastSelectedModels[provider.id] = model.id

    const storedEffort =
      this.preferences.lastSelectedEfforts[provider.id]?.[model.id]
    const effort = model.supportedEfforts.some(
      (candidate) => candidate.value === storedEffort
    )
      ? storedEffort
      : undefined
    if (storedEffort && !effort) {
      this.noticeFallback(
        `${provider.id}:${model.id}:effort:${storedEffort}`,
        `${model.displayName} no longer advertises effort ${storedEffort}; using Default.`
      )
      delete this.preferences.lastSelectedEfforts[provider.id]?.[model.id]
    }
    this.state.selectedEffort = effort
    this.persistPreferences()
    this.requestSelectedConfiguration()
  }

  private noticeFallback(key: string, message: string): void {
    if (this.fallbackNotices.has(key)) return
    this.fallbackNotices.add(key)
    pushToast(message, 'info')
  }

  private requestSelectedConfiguration(): void {
    if (
      this.state.connectionState !== 'online' ||
      this.state.status === 'thinking'
    ) {
      return
    }
    const provider = this.selectedProviderCapability()
    const model = this.selectedModelCapability()
    if (!provider || provider.status !== 'ready' || !model) return
    const configuration: AgentConfiguration = {
      provider: provider.id,
      model: model.invocationName,
      ...(this.state.selectedEffort
        ? { effort: this.state.selectedEffort }
        : {})
    }
    if (
      (this.state.configurationReady &&
        sameConfiguration(this.state.appliedConfiguration, configuration)) ||
      sameConfiguration(this.pendingConfiguration, configuration)
    ) {
      return
    }
    const revision = ++this.nextConfigurationRevision
    this.state.pendingRevision = revision
    this.state.configurationReady = false
    this.state.configurationError = ''
    this.pendingConfiguration = configuration
    if (
      !this.send({
        type: 'set_ai_configuration',
        revision,
        configuration
      })
    ) {
      this.state.pendingRevision = undefined
      this.pendingConfiguration = undefined
      this.state.configurationError =
        'AI configuration could not be sent because the sidecar is offline.'
    }
  }

  private persistPreferences(): void {
    if (!this.savePreferences) return
    const snapshot = clonePreferences(this.preferences)
    this.preferenceSaveQueue = this.preferenceSaveQueue
      .then(async () => {
        await this.savePreferences!(snapshot)
      })
      .catch((error) => {
        console.error('[agent-bridge] failed to save AI preferences:', error)
        pushToast('AI provider preferences could not be saved.')
      })
  }

  private enqueueToolCall(
    callId: string,
    name: string,
    input: unknown,
    sourceSocket: WebSocket | undefined
  ): void {
    if (!sourceSocket) return
    this.state.pendingToolCalls.push({ callId, name, input })
    this.toolQueue = this.toolQueue.then(() =>
      this.handleToolCall(callId, name, input, sourceSocket).catch((error) => {
        this.reportBridgeError(
          `Tool dispatch for ${name} failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      })
    )
  }

  private async handleToolCall(
    callId: string,
    name: string,
    input: unknown,
    sourceSocket: WebSocket
  ): Promise<void> {
    const handler = this.handlers.get(name)
    let result: ToolResult
    try {
      result = handler
        ? await handler(input)
        : { error: `No browser handler registered for ${name}` }
    } catch (error) {
      result = {
        error: error instanceof Error ? error.message : String(error)
      }
    }
    const validated = validateToolResultForTool(name, result)
    if (!validated.ok) {
      result = {
        error: `Browser rejected the ${name} result: ${validated.error}`
      }
    } else {
      result = validated.value
      const integrity = await verifyToolImageSha256(result)
      if (!integrity.ok) {
        result = {
          error: `Browser rejected the ${name} result: ${integrity.error}`
        }
      }
    }
    this.state.pendingToolCalls = this.state.pendingToolCalls.filter(
      (call) => call.callId !== callId
    )
    if (this.ws !== sourceSocket || sourceSocket.readyState !== WebSocket.OPEN) {
      this.emit({ type: 'tool_result', callId, name, result })
      return
    }
    if (!this.send({ type: 'tool_result', callId, result })) {
      this.reportBridgeError(
        `Failed to return the result for ${name}; sidecar is offline`
      )
    }
    this.emit({ type: 'tool_result', callId, name, result })
  }

  private emit(message: AgentBridgeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(message)
      } catch (error) {
        console.error('[agent-bridge] listener failed:', error)
      }
    }
  }

  private reportBridgeError(message: string): void {
    console.error(`[agent-bridge] ${message}`)
    this.state.messages.push({
      role: 'assistant',
      text: `[error] ${message}`
    })
    pushToast(message)
  }
}

export const agentBridge = new AgentBridge()
