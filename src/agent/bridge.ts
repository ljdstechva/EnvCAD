import { reactive } from 'vue'
import type { AiPreferences } from '../../desktop/aiPreferences'
import {
  DEVELOPMENT_SESSION_TOKEN,
  ENVCAD_WEBSOCKET_PROTOCOL,
  sessionTokenProtocol,
  type SidecarConnectionConfig
} from '../../desktop/runtimeProtocol'
import {
  getCadSessionRevision,
  getWorkspaceRevision,
  type CadSessionRevision
} from '../cad/session'
import { pushToast } from '../toast/toastStore'
import { verifyToolImageSha256 } from './imageIntegrity'
import {
  ENVCAD_TURN_REVISION_FIELD,
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
import {
  type CadOperationRequest,
  type OperationReceipt,
  parseAgentClientEnvelope,
  parseAgentServerEnvelope,
  persistedTurnEventEnvelopeSchema,
  MAX_INLINE_TURN_TEXT_UTF8_BYTES,
  type AgentClientEnvelope,
  type AgentServerEnvelope,
  type InputReference,
  type InstructionBreakdown,
  type PersistedTurnEventEnvelope,
  type SkillActivation,
  type TurnFinished,
  type TurnOutcome,
  type TurnPhase,
  type WorkspaceRevision
} from '../../shared/agent-contracts'
import { CadMutationExecutor } from '../cad/operations/CadMutationExecutor'
import { MlightCadUndoGroupAdapter } from '../cad/infrastructure/mlightcad/MlightCadUndoGroupAdapter'
import { OperationCoordinator } from '../cad/operations/OperationCoordinator'
import { createDurableOperationCoordinator } from '../cad/infrastructure/storage/OperationRuntime'
import {
  DurableTurnSession,
  type DurableActiveTurn
} from './runtime/DurableTurnSession'
import { TurnProjection } from './runtime/TurnProjection'
import {
  InputIngestionClient,
  localInputDisplayText,
  type InputIngestionProgress
} from './runtime/InputIngestionClient'
import {
  DraftStore,
  type QueuedTurnDraft
} from './runtime/DraftStore'

export type ConnectionState =
  | 'connecting'
  | 'online'
  | 'reconnecting'
  | 'offline'
export type AgentStatus =
  | 'idle'
  | 'waiting'
  | 'thinking'
  | 'recovering'
  | 'failed'

export interface AgentChatMessage {
  role: 'user' | 'assistant'
  text: string
  provider?: ProviderId
  model?: string
  resolvedModel?: string
  effort?: string
  metrics?: TurnMetrics
  turnId?: string
  outcome?: TurnOutcome
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
  activeTurnId?: string
  turnPhase?: TurnPhase
  turnStatus: string
  activeSkills: SkillActivation[]
  instructionBreakdown?: InstructionBreakdown
  operationReceipts: OperationReceipt[]
  terminalOutcome?: TurnOutcome
  terminal?: TurnFinished
  inputProgress?: InputIngestionProgress
  queuedMessages: QueuedTurnDraft[]
  queueStatus: string
}

export type ToolHandler = (input: unknown) => Promise<ToolResult> | ToolResult
export type AgentBridgeEvent =
  | ServerMessage
  | { type: 'durable_event'; envelope: PersistedTurnEventEnvelope }
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
const CONTENT_MUTATING_CAD_TOOLS = new Set([
  'move_entities',
  'copy_entities',
  'rotate_entities',
  'scale_entities',
  'delete_entities',
  'set_entity_layer',
  'set_entity_color',
  'change_text',
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
  'set_layer_properties',
  'set_current_layer',
  'import_boundary_from_csv',
  'import_boundary_from_geojson',
  'place_monitoring_points',
  'insert_symbol'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseTurnRevision(input: unknown): CadSessionRevision | undefined {
  if (!isRecord(input)) return undefined
  const value = input[ENVCAD_TURN_REVISION_FIELD]
  if (!isRecord(value)) return undefined
  if (
    !Number.isSafeInteger(value.documentRevision) ||
    (value.documentRevision as number) < 0 ||
    !Number.isSafeInteger(value.contentRevision) ||
    (value.contentRevision as number) < 0
  ) {
    return undefined
  }
  return {
    documentRevision: value.documentRevision as number,
    contentRevision: value.contentRevision as number
  }
}

function withoutTurnRevision(input: unknown): unknown {
  if (!isRecord(input)) return input
  const publicInput = { ...input }
  delete publicInput[ENVCAD_TURN_REVISION_FIELD]
  return publicInput
}

function revisionsEqual(
  left: CadSessionRevision,
  right: CadSessionRevision
): boolean {
  return (
    left.documentRevision === right.documentRevision &&
    left.contentRevision === right.contentRevision
  )
}

function toolMayMutateCadContent(name: string, input: unknown): boolean {
  if (name === 'measure_clearance') {
    return isRecord(input) && input.draw === true
  }
  return CONTENT_MUTATING_CAD_TOOLS.has(name)
}

function withRevision(
  result: ToolResult,
  revision: WorkspaceRevision
): ToolResult {
  const data = isRecord(result.data)
    ? { ...result.data, revision }
    : { value: result.data ?? null, revision }
  return { ...result, data }
}

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
    recommendedConfigurations: undefined,
    activeTurnId: undefined,
    turnPhase: undefined,
    turnStatus: '',
    activeSkills: [],
    instructionBreakdown: undefined,
    operationReceipts: [],
    terminalOutcome: undefined,
    terminal: undefined,
    inputProgress: undefined,
    queuedMessages: [],
    queueStatus: ''
  })

  private readonly turnSession: DurableTurnSession
  private readonly draftStore: DraftStore
  private readonly inputIngestion: InputIngestionClient
  private turnProjection: TurnProjection | undefined
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
  private activeSelectionSnapshot: SelectionSnapshot | undefined
  private durabilityFailureReported = false
  private operationCoordinator: OperationCoordinator | undefined
  private mutationExecutor: CadMutationExecutor | undefined
  private readonly undoGroups = new MlightCadUndoGroupAdapter()
  private readonly mutationControllers = new Map<string, AbortController>()
  private processingQueue = false

  constructor(
    options: {
      turnSession?: DurableTurnSession
      operationCoordinator?: OperationCoordinator
      draftStore?: DraftStore
    } = {}
  ) {
    this.turnSession = options.turnSession ?? new DurableTurnSession()
    this.draftStore =
      options.draftStore ??
      new DraftStore({
        onPersistenceError: (error) => this.reportBridgeError(error.message)
      })
    this.syncQueueState()
    this.inputIngestion = new InputIngestionClient({
      command: (payload) => this.turnSession.command(payload),
      send: (envelope) => this.sendV2(envelope),
      onProgress: (progress) => {
        this.state.inputProgress = progress
        if (!this.turnSession.activeTurn) {
          this.state.turnStatus =
            `Preserving large input: ${progress.receivedBytes.toLocaleString()} ` +
            `of ${progress.totalBytes.toLocaleString()} bytes.`
        }
      }
    })
    this.operationCoordinator = options.operationCoordinator
    const active = this.turnSession.activeTurn
    this.nextConfigurationRevision = Math.max(
      this.nextConfigurationRevision,
      active?.configurationRevision ?? 0
    )
    this.restoreDurableTurn(active)
  }

  private restoreDurableTurn(active: DurableActiveTurn | undefined): void {
    if (!active) return
    this.turnProjection = new TurnProjection(active.turnId, {
      lastSequence: active.lastServerSequence,
      assistantText: active.streamingText,
      accepted: active.accepted,
      phase: active.projection?.phase,
      status: active.projection?.status,
      activeSkills: active.projection?.activeSkills,
      instructionBreakdown: active.projection?.instructionBreakdown,
      operationReceipts: active.projection?.operationReceipts
    })
    this.activeSelectionSnapshot = structuredClone(active.selectionSnapshot)
    this.state.activeTurnId = active.turnId
    this.state.streamingText = active.streamingText
    this.state.turnPhase = active.projection?.phase
    this.state.activeSkills = structuredClone(
      active.projection?.activeSkills ?? []
    )
    this.state.instructionBreakdown = active.projection?.instructionBreakdown
      ? structuredClone(active.projection.instructionBreakdown)
      : undefined
    this.state.operationReceipts = structuredClone(
      active.projection?.operationReceipts ?? []
    )
    this.state.status = active.accepted ? 'thinking' : 'waiting'
    this.state.turnStatus = active.accepted
      ? 'Restoring the durable turn.'
      : 'Waiting to submit the preserved draft.'
    this.state.messages.push({
      role: 'user',
      text: active.text,
      turnId: active.turnId
    })
  }

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
    sheet: SheetSnapshot,
    referenceInputIds: string[] = []
  ): string | Promise<string> {
    if (!text.trim()) throw new Error('Enter an instruction before sending.')
    if (selectionSnapshot.count !== selectionSnapshot.ids.length) {
      throw new Error('The frozen selection count does not match its entity IDs.')
    }
    const uniqueReferenceInputIds = [...new Set(referenceInputIds)]
    if (uniqueReferenceInputIds.length > 1_000) {
      throw new Error('A turn cannot include more than 1,000 local references.')
    }
    const inputByteLength = new TextEncoder().encode(text).byteLength
    const workspaceRevision = getWorkspaceRevision()
    if (
      workspaceRevision.documentRevision !==
        selectionSnapshot.revision.documentRevision ||
      workspaceRevision.contentRevision !==
        selectionSnapshot.revision.contentRevision
    ) {
      throw new Error(
        'The drawing changed while the message was being prepared. Capture the selection again.'
      )
    }
    const frozenSelection: SelectionSnapshot = {
      ids: [...selectionSnapshot.ids],
      count: selectionSnapshot.count,
      units: selectionSnapshot.units,
      revision: { ...selectionSnapshot.revision }
    }
    if (
      this.turnSession.activeTurn ||
      this.state.status !== 'idle' ||
      this.state.connectionState !== 'online' ||
      this.state.refreshingCapabilities ||
      !this.state.configurationReady ||
      !this.state.appliedRevision ||
      !this.state.appliedConfiguration
    ) {
      return this.queueUserMessage(
        text,
        inputByteLength,
        frozenSelection,
        sheet,
        uniqueReferenceInputIds
      )
    }
    if (inputByteLength > MAX_INLINE_TURN_TEXT_UTF8_BYTES) {
      return this.ingestLargeInstruction(
        text,
        inputByteLength,
        frozenSelection,
        workspaceRevision,
        sheet,
        uniqueReferenceInputIds
      )
    }
    return this.commitUserTurn(
      text,
      undefined,
      frozenSelection,
      workspaceRevision,
      sheet,
      uniqueReferenceInputIds
    )
  }

  async ingestTextAttachment(file: File): Promise<InputReference> {
    if (this.state.connectionState !== 'online') {
      throw new Error(
        'Reconnect the AI Assistant before attaching a file so EnvCAD can preserve it locally.'
      )
    }
    const text = await file.text()
    return this.inputIngestion.ingestText(text, file.name || 'attachment.txt')
  }

  async deleteLocalInput(inputId: string): Promise<void> {
    if (this.turnSession.activeTurn) {
      throw new Error(
        'Wait for the active turn to finish before deleting a local input reference.'
      )
    }
    if (this.state.connectionState !== 'online') {
      throw new Error(
        'Reconnect the AI Assistant before deleting the local input copy.'
      )
    }
    await this.inputIngestion.delete(inputId)
  }

  getComposerDraft(): string {
    return this.draftStore.composerText
  }

  saveComposerDraft(text: string): boolean {
    return this.draftStore.setComposerText(text)
  }

  removeQueuedMessage(queueId: string): void {
    if (!this.draftStore.remove(queueId)) {
      this.reportBridgeError('The queued message could not be removed safely.')
      return
    }
    this.syncQueueState()
  }

  clearQueuedMessages(): void {
    if (!this.draftStore.clearQueue()) {
      this.reportBridgeError('The assistant queue could not be cleared safely.')
      return
    }
    this.syncQueueState()
  }

  resumeQueuedMessage(queueId: string): void {
    const queued = this.draftStore.queuedTurns.find(
      (item) => item.queueId === queueId
    )
    if (!queued) return
    const revision = getCadSessionRevision()
    if (
      !this.draftStore.update(queueId, {
        selectionSnapshot: {
          ...queued.selectionSnapshot,
          revision
        },
        status: 'queued',
        reason: undefined
      })
    ) {
      this.reportBridgeError('The queued message could not be rebound safely.')
      return
    }
    this.syncQueueState()
    void this.processQueuedTurns()
  }

  private queueUserMessage(
    text: string,
    inputByteLength: number,
    selectionSnapshot: SelectionSnapshot,
    sheet: SheetSnapshot,
    referenceInputIds: string[]
  ): string | Promise<string> {
    if (
      inputByteLength > MAX_INLINE_TURN_TEXT_UTF8_BYTES &&
      this.state.connectionState === 'online'
    ) {
      return this.inputIngestion.ingestText(text).then((reference) =>
        this.enqueueQueuedTurn(
          localInputDisplayText(text, reference),
          reference,
          selectionSnapshot,
          sheet,
          referenceInputIds
        )
      )
    }
    if (inputByteLength > MAX_INLINE_TURN_TEXT_UTF8_BYTES) {
      throw new Error(
        'Reconnect before queueing this large instruction. The composer remains editable so the draft can be retried without truncation.'
      )
    }
    return this.enqueueQueuedTurn(
      text,
      undefined,
      selectionSnapshot,
      sheet,
      referenceInputIds
    )
  }

  private enqueueQueuedTurn(
    text: string,
    instructionReference: InputReference | undefined,
    selectionSnapshot: SelectionSnapshot,
    sheet: SheetSnapshot,
    referenceInputIds: string[]
  ): string {
    this.draftStore.enqueue({
      text,
      ...(instructionReference ? { instructionReference } : {}),
      referenceInputIds,
      selectionSnapshot,
      sheet: structuredClone(sheet)
    })
    this.syncQueueState()
    this.state.queueStatus =
      'Follow-up preserved locally and queued for the current provider.'
    return text
  }

  private async ingestLargeInstruction(
    text: string,
    inputByteLength: number,
    frozenSelection: SelectionSnapshot,
    workspaceRevision: WorkspaceRevision,
    sheet: SheetSnapshot,
    referenceInputIds: string[] = []
  ): Promise<string> {
    this.state.status = 'waiting'
    this.state.turnStatus = 'Reserving local storage for the large instruction.'
    this.state.inputProgress = {
      inputId: '',
      receivedBytes: 0,
      totalBytes: inputByteLength,
      receivedChunks: 0,
      status: 'receiving'
    }
    let instructionReference: InputReference
    try {
      instructionReference = await this.inputIngestion.ingestText(text)
    } catch (error) {
      this.state.status = 'idle'
      this.state.turnStatus = ''
      this.state.inputProgress = undefined
      throw error
    }
    const currentRevision = getWorkspaceRevision()
    if (
      currentRevision.documentRevision !==
        frozenSelection.revision.documentRevision ||
      currentRevision.contentRevision !==
        frozenSelection.revision.contentRevision
    ) {
      this.state.status = 'idle'
      this.state.turnStatus = ''
      this.state.inputProgress = undefined
      throw new Error(
        'The drawing changed while the large instruction was being preserved. The input remains stored locally; capture the selection again.'
      )
    }
    return this.commitUserTurn(
      localInputDisplayText(text, instructionReference),
      instructionReference,
      frozenSelection,
      workspaceRevision,
      sheet,
      referenceInputIds
    )
  }

  private commitUserTurn(
    durableText: string,
    instructionReference: InputReference | undefined,
    frozenSelection: SelectionSnapshot,
    workspaceRevision: WorkspaceRevision,
    sheet: SheetSnapshot,
    referenceInputIds: string[] = [],
    durableIds?: { turnId: string; messageId: string }
  ): string {
    const configurationRevision = this.state.appliedRevision
    const configuration = this.state.appliedConfiguration
    if (!configurationRevision || !configuration) {
      throw new Error(
        'The selected provider configuration changed before the turn was committed.'
      )
    }
    const { active, envelope } = this.turnSession.beginTurn(
      {
        text: durableText,
        ...(instructionReference
          ? {
              instructionInputId: instructionReference.inputId,
              originalInputByteLength: instructionReference.byteLength
            }
          : {}),
        referenceInputIds,
        selectionSnapshot: frozenSelection,
        workspaceRevision,
        sheet: structuredClone(sheet),
        configurationRevision,
        configuration: { ...configuration }
      },
      durableIds
    )
    this.durabilityFailureReported = false
    this.activeSelectionSnapshot = frozenSelection
    this.turnProjection = new TurnProjection(active.turnId)
    this.state.activeTurnId = active.turnId
    this.state.status = 'waiting'
    this.state.turnStatus = 'Waiting for durable acknowledgment.'
    this.state.turnPhase = undefined
    this.state.activeSkills = []
    this.state.instructionBreakdown = undefined
    this.state.operationReceipts = []
    this.state.terminalOutcome = undefined
    this.state.terminal = undefined
    this.state.inputProgress = undefined
    this.state.messages.push({
      role: 'user',
      text: durableText,
      turnId: active.turnId
    })
    if (!this.sendV2(envelope)) {
      this.state.turnStatus =
        this.lastSendError ??
        'AI Assistant sidecar is offline; the preserved message will resume after reconnect.'
    }
    return durableText
  }

  private syncQueueState(): void {
    this.state.queuedMessages = this.draftStore.queuedTurns
    if (this.state.queuedMessages.length === 0) {
      this.state.queueStatus = ''
    }
  }

  private async processQueuedTurns(): Promise<void> {
    if (this.processingQueue) return
    this.processingQueue = true
    try {
      const queued = this.draftStore.queuedTurns[0]
      if (
        !queued ||
        this.turnSession.activeTurn ||
        this.state.status !== 'idle' ||
        this.state.connectionState !== 'online' ||
        !this.state.configurationReady ||
        !this.state.appliedRevision ||
        !this.state.appliedConfiguration
      ) {
        return
      }
      if (queued.status === 'needs-review') {
        this.state.queueStatus =
          queued.reason ??
          'The next queued message needs review before it can be sent.'
        return
      }

      const revision = getWorkspaceRevision()
      const queuedRevision = queued.selectionSnapshot.revision
      const documentChanged =
        revision.documentRevision !== queuedRevision.documentRevision
      const selectedDrawingChanged =
        queued.selectionSnapshot.count > 0 &&
        revision.contentRevision !== queuedRevision.contentRevision
      if (documentChanged || selectedDrawingChanged) {
        const reason = documentChanged
          ? 'A different drawing is now open. Review this queued message before sending it to the new document.'
          : 'The drawing changed after this selection was queued. Review the frozen selection before sending.'
        this.draftStore.update(queued.queueId, {
          status: 'needs-review',
          reason
        })
        this.syncQueueState()
        this.state.queueStatus = reason
        return
      }

      const selectionSnapshot: SelectionSnapshot = {
        ...queued.selectionSnapshot,
        ids: [...queued.selectionSnapshot.ids],
        revision: {
          documentRevision: revision.documentRevision,
          contentRevision: revision.contentRevision
        }
      }
      this.commitUserTurn(
        queued.text,
        queued.instructionReference,
        selectionSnapshot,
        revision,
        queued.sheet,
        queued.referenceInputIds,
        {
          turnId: `queued-${queued.queueId}`,
          messageId: queued.queueId
        }
      )
      if (!this.draftStore.remove(queued.queueId)) {
        this.reportBridgeError(
          'The queued message started, but its queue marker could not be cleared. Its stable turn ID prevents duplicate execution.'
        )
      }
      this.syncQueueState()
    } catch (error) {
      this.state.queueStatus =
        error instanceof Error
          ? error.message
          : 'The queued message could not be started.'
    } finally {
      this.processingQueue = false
    }
  }

  interrupt(): void {
    const active = this.turnSession.activeTurn
    if (!active) {
      console.error('[agent-bridge] cannot interrupt: no durable turn is active')
      return
    }
    this.abortActiveMutations()
    const message = this.turnSession.command(
      { type: 'cancel_turn', turnId: active.turnId },
      active.turnId
    )
    if (!this.sendV2(message)) {
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
    this.abortActiveMutations()
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    const previous = this.ws
    this.ws = undefined
    previous?.close()
    this.invalidateConfiguration()
    this.state.appliedConfiguration = undefined
    this.state.appliedRevision = undefined
    const active = this.turnSession.activeTurn
    this.state.status = active ? 'waiting' : 'idle'
    if (active) {
      this.state.turnStatus =
        'Assistant connection stopped; the durable turn remains preserved.'
    } else {
      this.state.streamingText = ''
      this.state.pendingToolCalls = []
      this.activeSelectionSnapshot = undefined
    }
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
      const active = this.turnSession.activeTurn
      if (active?.accepted || (active && active.lastServerSequence > 0)) {
        this.resumeDurableTurn(active)
      }
    })
    ws.addEventListener('message', (event) => {
      if (this.ws !== ws) return
      void this.handleServerMessage(String(event.data))
    })
    ws.addEventListener('close', () => {
      this.inputIngestion.failPending(
        'AI Assistant disconnected before local input ingestion completed. The composer draft remains available to retry.'
      )
      if (this.ws !== ws) return
      const wasOnline = this.state.connectionState === 'online'
      const active = this.turnSession.activeTurn
      this.abortActiveMutations()
      this.ws = undefined
      this.invalidateConfiguration()
      this.state.appliedConfiguration = undefined
      this.state.appliedRevision = undefined
      this.state.refreshingCapabilities = false
      this.state.status = active ? 'waiting' : 'idle'
      if (active) {
        this.state.turnStatus =
          'Connection interrupted; reconnecting to the preserved turn.'
      } else {
        this.state.streamingText = ''
        this.state.pendingToolCalls = []
        this.activeSelectionSnapshot = undefined
      }
      this.state.connectionState = this.stopped ? 'offline' : 'reconnecting'
      this.state.offlineReason =
        'AI Assistant disconnected. EnvCAD is reconnecting; CAD editing remains available.'
      if (wasOnline) {
        pushToast(
          active
            ? 'Assistant disconnected; the active turn is preserved and will resume.'
            : 'Assistant sidecar disconnected - reconnecting...',
          'info'
        )
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
        "EnvCAD's 2 MiB transport capacity. Reduce the prompt or sheet context and try again."
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

  private sendV2(message: AgentClientEnvelope): boolean {
    this.lastSendError = undefined
    const parsed = parseAgentClientEnvelope(message)
    if (!parsed.ok) {
      this.lastSendError =
        'EnvCAD could not validate the durable assistant command.'
      console.error(
        `[agent-bridge] refusing invalid protocol v2 command: ${parsed.developerMessage}`
      )
      return false
    }
    const serialized = JSON.stringify(parsed.value)
    const payloadBytes = new TextEncoder().encode(serialized).byteLength
    if (payloadBytes > MAX_WEBSOCKET_PAYLOAD_BYTES) {
      this.lastSendError =
        `The complete AI request is ${payloadBytes.toLocaleString()} bytes and exceeds ` +
        "EnvCAD's 2 MiB transport capacity. The draft remains preserved."
      this.reportBridgeError(this.lastSendError)
      return false
    }
    if (import.meta.env.DEV) {
      console.debug('[agent-bridge] ->', {
        type: message.payload.type,
        protocolVersion: message.protocolVersion,
        payloadBytes
      })
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(serialized)
        return true
      } catch (error) {
        this.lastSendError = `Failed to send ${message.payload.type}: ${
          error instanceof Error ? error.message : String(error)
        }`
        console.error(`[agent-bridge] ${this.lastSendError}`)
      }
    } else {
      this.lastSendError =
        'AI Assistant sidecar is offline; the preserved message will resume after reconnect.'
    }
    return false
  }

  private resumeDurableTurn(active: DurableActiveTurn): void {
    const envelope = this.turnSession.command(
      {
        type: 'resume_turn',
        turnId: active.turnId,
        lastSequence: active.lastServerSequence
      },
      active.turnId
    )
    if (!this.sendV2(envelope)) {
      this.state.turnStatus =
        'Waiting to reconnect to the preserved durable turn.'
    }
  }

  private submitPreservedDraft(): void {
    const active = this.turnSession.activeTurn
    if (
      !active ||
      active.accepted ||
      active.lastServerSequence > 0 ||
      this.state.appliedRevision !== active.configurationRevision ||
      !sameConfiguration(this.state.appliedConfiguration, active.configuration)
    ) {
      return
    }
    if (this.sendV2(this.turnSession.submitEnvelope(active))) {
      this.state.status = 'waiting'
      this.state.turnStatus = 'Waiting for durable acknowledgment.'
    }
  }

  private async handleServerMessage(raw: string): Promise<void> {
    let decoded: unknown
    try {
      decoded = JSON.parse(raw)
    } catch {
      this.reportBridgeError('Sidecar sent malformed JSON')
      return
    }
    if (isRecord(decoded) && decoded.protocolVersion !== undefined) {
      const parsed = parseAgentServerEnvelope(decoded)
      if (!parsed.ok) {
        this.reportBridgeError(
          'The sidecar returned an invalid durable assistant event.'
        )
        console.error(
          `[agent-bridge] invalid protocol v2 event: ${parsed.developerMessage}`
        )
        return
      }
      if (this.inputIngestion.receive(parsed.value.payload)) return
      if (
        parsed.value.payload.type === 'input_progress' ||
        parsed.value.payload.type === 'input_committed' ||
        parsed.value.payload.type === 'input_aborted'
      ) {
        return
      }
      if (parsed.value.payload.type === 'protocol_error') {
        this.reportBridgeError(parsed.value.payload.message)
        return
      }
      this.handleDurableEvent(parsed.value)
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
        if (message.state === 'idle') this.activeSelectionSnapshot = undefined
        break
      case 'error':
        console.error(`[agent-bridge] sidecar error: ${message.message}`)
        if (this.turnSession.activeTurn) {
          this.state.status = 'waiting'
          this.state.turnStatus = message.message
        }
        pushToast(message.message)
        break
      case 'tool_call':
        this.emit({
          ...message,
          input: withoutTurnRevision(message.input)
        })
        this.enqueueToolCall(
          message.callId,
          message.name,
          message.input,
          this.ws,
          message.turnId,
          message.operation
        )
        return
      case 'get_operation_status':
        void this.handleOperationStatusRequest(
          message.requestId,
          message.operationId
        )
        return
      case 'ai_capabilities':
        this.state.providers = message.providers
        this.state.refreshingCapabilities = message.refreshing
        this.reconcileSelection()
        if (!message.refreshing) void this.processQueuedTurns()
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
        this.submitPreservedDraft()
        void this.processQueuedTurns()
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

  private handleDurableEvent(message: AgentServerEnvelope): void {
    const parsed = persistedTurnEventEnvelopeSchema.safeParse(message)
    if (!parsed.success) {
      this.reportBridgeError(
        'The sidecar returned an unsupported durable assistant event.'
      )
      return
    }
    const envelope = parsed.data
    const active = this.turnSession.activeTurn
    if (
      envelope.sessionId !== this.turnSession.sessionId ||
      !active ||
      envelope.turnId !== active.turnId
    ) {
      console.error(
        '[agent-bridge] ignored a durable event for an inactive session or turn'
      )
      return
    }
    this.turnProjection ??= new TurnProjection(active.turnId, {
      lastSequence: active.lastServerSequence,
      assistantText: active.streamingText,
      accepted: active.accepted
    })
    try {
      if (this.turnProjection.apply(envelope) === 'duplicate') return
    } catch (error) {
      this.reportBridgeError(
        'EnvCAD rejected an out-of-order durable assistant event.'
      )
      console.error('[agent-bridge] durable projection failed:', error)
      return
    }

    const projection = this.turnProjection.value
    if (envelope.payload.type !== 'turn_finished') {
      const persisted = this.turnSession.recordServerEvent(envelope.sequence, {
        accepted: projection.accepted,
        streamingText: projection.assistantText,
        projection: {
          phase: projection.phase,
          status: projection.status,
          activeSkills: projection.activeSkills,
          instructionBreakdown: projection.instructionBreakdown,
          operationReceipts: projection.operationReceipts
        }
      })
      if (!persisted) this.reportDurabilityFailure()
    }
    this.state.activeTurnId = active.turnId
    this.state.turnPhase = projection.phase
    this.state.turnStatus = projection.status
    this.state.activeSkills = projection.activeSkills
    this.state.instructionBreakdown = projection.instructionBreakdown
    this.state.operationReceipts = projection.operationReceipts
    this.state.streamingText = projection.assistantText

    const event = envelope.payload
    if (event.type === 'turn_accepted') {
      this.state.status = 'thinking'
    } else if (event.type === 'turn_progress') {
      this.state.status =
        event.phase === 'recovering' ||
        event.phase === 'retrying' ||
        event.phase === 'degraded'
          ? 'recovering'
          : 'thinking'
    } else if (event.type === 'turn_finished') {
      try {
        this.undoGroups.finishTurn(active.turnId)
      } catch (error) {
        this.reportBridgeError(
          'The AI action completed, but EnvCAD could not finalize its grouped undo record.'
        )
        console.error('[agent-bridge] undo group finalization failed:', error)
      }
      const failureText = event.error?.userMessage
      const finalText = projection.assistantText
        ? failureText
          ? `${projection.assistantText}\n\n${failureText}`
          : projection.assistantText
        : failureText ?? event.status
      this.state.messages.push({
        role: 'assistant',
        text: finalText,
        turnId: active.turnId,
        outcome: event.outcome,
        provider: active.configuration.provider,
        model: active.configuration.model,
        ...(active.configuration.effort
          ? { effort: active.configuration.effort }
          : {}),
        metrics: event.metrics
      })
      this.state.streamingText = ''
      this.state.status = 'idle'
      this.state.terminalOutcome = event.outcome
      this.state.terminal = structuredClone(event)
      this.state.pendingToolCalls = []
      this.activeSelectionSnapshot = undefined
      if (!this.turnSession.finishTurn(active.turnId)) {
        this.reportDurabilityFailure()
      }
      this.turnProjection = undefined
      this.requestSelectedConfiguration()
      queueMicrotask(() => void this.processQueuedTurns())
    }
    this.emit({ type: 'durable_event', envelope })
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
    if (this.state.connectionState !== 'online') return
    const active = this.turnSession.activeTurn
    if (active?.accepted || (active && active.lastServerSequence > 0)) return
    const provider = this.selectedProviderCapability()
    const model = this.selectedModelCapability()
    if (!provider || provider.status !== 'ready' || !model) return
    const configuration: AgentConfiguration = active
      ? { ...active.configuration }
      : {
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
      this.submitPreservedDraft()
      return
    }
    const revision = active
      ? active.configurationRevision
      : ++this.nextConfigurationRevision
    this.nextConfigurationRevision = Math.max(
      this.nextConfigurationRevision,
      revision
    )
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
    sourceSocket: WebSocket | undefined,
    turnId?: string,
    operation?: CadOperationRequest
  ): void {
    if (!sourceSocket) return
    this.state.pendingToolCalls.push({
      callId,
      name,
      input: withoutTurnRevision(input)
    })
    this.toolQueue = this.toolQueue.then(() =>
      this.handleToolCall(
        callId,
        name,
        input,
        sourceSocket,
        turnId,
        operation
      ).catch((error) => {
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
    sourceSocket: WebSocket,
    turnId?: string,
    operation?: CadOperationRequest
  ): Promise<void> {
    const handler = this.handlers.get(name)
    let result: ToolResult
    let operationReceipt: OperationReceipt | undefined
    const expectedRevision = parseTurnRevision(input)
    const inputRecord = isRecord(input) ? { ...input } : undefined
    if (inputRecord) delete inputRecord[ENVCAD_TURN_REVISION_FIELD]
    const frozenSelection = this.activeSelectionSnapshot
    const browserInput =
      name === 'get_selected_entities' && inputRecord && frozenSelection
        ? { ...inputRecord, ids: [...frozenSelection.ids] }
        : inputRecord ?? input
    const beforeRevision = getCadSessionRevision()

    if (!expectedRevision) {
      result = {
        error:
          `EnvCAD rejected ${name}: the AI tool call was not bound to the active drawing revision.`
      }
    } else if (!revisionsEqual(expectedRevision, beforeRevision)) {
      result = {
        error:
          `EnvCAD rejected ${name} before execution because the drawing changed ` +
          `since this AI turn began (expected ${expectedRevision.documentRevision}:` +
          `${expectedRevision.contentRevision}, current ${beforeRevision.documentRevision}:` +
          `${beforeRevision.contentRevision}). No CAD change was made; send a new message ` +
          `so the assistant can inspect the current drawing.`
      }
    } else if (name === 'get_selected_entities' && !frozenSelection) {
      result = {
        error: 'EnvCAD rejected get_selected_entities because no active turn snapshot exists.'
      }
    } else {
      try {
        if (operation) {
          const active = this.turnSession.activeTurn
          if (!turnId || !active || turnId !== active.turnId) {
            result = {
              error:
                'EnvCAD rejected the mutation because it was not bound to the active durable turn.'
            }
          } else {
            const controller = new AbortController()
            this.mutationControllers.set(callId, controller)
            try {
              const execution = await this.getMutationExecutor().execute(
                operation,
                browserInput,
                async (payload) =>
                  handler
                    ? await handler(payload)
                    : { error: `No browser handler registered for ${name}` },
                controller.signal
              )
              result = execution.result
              operationReceipt = execution.receipt
            } finally {
              this.mutationControllers.delete(callId)
            }
          }
        } else {
          result = handler
            ? await handler(browserInput)
            : { error: `No browser handler registered for ${name}` }
        }
      } catch (error) {
        result = {
          error: error instanceof Error ? error.message : String(error)
        }
      }

      if (!result.error) {
        const afterRevision = getCadSessionRevision()
        if (afterRevision.documentRevision !== beforeRevision.documentRevision) {
          result = {
            error:
              `EnvCAD discarded the ${name} result because a different drawing ` +
              'became active while the tool was running. Send a new message before continuing.'
          }
        } else if (
          !toolMayMutateCadContent(name, browserInput) &&
          afterRevision.contentRevision !== beforeRevision.contentRevision
        ) {
          result = {
            error:
              `EnvCAD discarded the ${name} result because drawing content changed ` +
              'while the read was running. Send a new message before continuing.'
          }
        } else {
          result = withRevision(result, getWorkspaceRevision())
        }
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
    if (
      !this.send({
        type: 'tool_result',
        callId,
        result,
        ...(operationReceipt ? { operationReceipt } : {})
      })
    ) {
      this.reportBridgeError(
        `Failed to return the result for ${name}; sidecar is offline`
      )
    }
    this.emit({ type: 'tool_result', callId, name, result })
  }

  private getMutationExecutor(): CadMutationExecutor {
    this.operationCoordinator ??= createDurableOperationCoordinator(
      getWorkspaceRevision
    )
    this.mutationExecutor ??= new CadMutationExecutor({
      coordinator: this.operationCoordinator,
      currentRevision: getWorkspaceRevision,
      beginOperationGroup: (request) => this.undoGroups.begin(request)
    })
    return this.mutationExecutor
  }

  private async handleOperationStatusRequest(
    requestId: string,
    operationId: string
  ): Promise<void> {
    try {
      this.operationCoordinator ??= createDurableOperationCoordinator(
        getWorkspaceRevision
      )
      const receipt = await this.operationCoordinator.getReceipt(operationId)
      if (
        !this.send({
          type: 'operation_status',
          requestId,
          result: {
            operationId,
            ...(receipt ? { receipt } : {})
          }
        })
      ) {
        console.error(
          '[agent-bridge] could not return operation status while offline'
        )
      }
    } catch (error) {
      console.error('[agent-bridge] operation status lookup failed:', error)
      this.send({
        type: 'operation_status',
        requestId,
        result: { operationId }
      })
    }
  }

  private abortActiveMutations(): void {
    for (const controller of this.mutationControllers.values()) {
      controller.abort()
    }
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

  private reportDurabilityFailure(): void {
    if (this.durabilityFailureReported) return
    this.durabilityFailureReported = true
    const message =
      'The turn remains recorded by EnvCAD, but this window could not update its local resume cache. Keep the window open until the turn reaches a terminal state.'
    console.error(`[agent-bridge] ${message}`)
    this.state.turnStatus = message
    pushToast(message)
  }
}

export const agentBridge = new AgentBridge()
