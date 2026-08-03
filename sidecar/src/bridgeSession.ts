import { createHash, randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import type {
  AgentConfiguration,
  CadSessionRevisionSnapshot,
  ClientMessage,
  ProviderCapability,
  SelectionContext,
  ServerMessage,
  SheetSnapshot,
  ToolResult,
  TurnMetrics
} from '../../src/agent/protocol'
import {
  ENVCAD_TURN_REVISION_FIELD,
  modelImageInputSupport,
  parseClientMessage,
  validateToolResultForTool
} from '../../src/agent/protocol'
import { getCadToolSpec, type CadToolBridge } from './cadToolSpecs'
import { getInputToolSpec, type InputToolName } from './inputToolSpecs'
import { redactProviderDiagnostic } from './providers/environment'
import { ProviderManager } from './providers/providerManager'
import { invokeTextToCadSkillForTurn } from './textToCadSkill'
import {
  AGENT_PROTOCOL_VERSION,
  agentServerEnvelopeSchema,
  parseAgentClientEnvelope,
  operationArgumentsPreimage,
  sameWorkspaceRevision,
  submitTurnEnvelopeSchema,
  toolCallMayMutate,
  toolInputJsonSchema,
  workspaceRevisionSchema,
  type AgentClientEnvelope,
  type AgentServerEnvelope,
  type AgentServerPayload,
  type CadOperationRequest,
  type InputIngestionCommand,
  type InputReference,
  type OperationReceipt,
  type OperationStatusResult,
  type PersistedTurnEventEnvelope,
  type SubmitTurnEnvelope,
  type TurnJournalPort,
  type VerificationSummary,
  type WorkspaceRevision
} from '../../shared/agent-contracts'
import { SkillRegistry } from './application/skills/SkillRegistry'
import { CapabilityBroker } from './application/capabilities/CapabilityBroker'
import type { SkillInvocation } from './domain/skills/SkillInvocation'
import { TurnOrchestrator } from './application/turn/TurnOrchestrator'
import { LocalInputStore } from './application/input/LocalInputStore'
import { InputStoreCapacityError } from './application/input/LocalInputStore'
import {
  InputRetrievalRequestError,
  InputRetrievalService
} from './application/input/InputRetrievalService'
import { ContextBudgetManager } from './application/input/ContextBudgetManager'
import { SYSTEM_PROMPT } from './systemPrompt'
import { PROVIDER_TOOL_SPECS } from './providerToolSpecs'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toolResultRevision(
  result: ToolResult
): CadSessionRevisionSnapshot | undefined {
  if (!isRecord(result.data) || !isRecord(result.data.revision)) return undefined
  const revision = result.data.revision
  if (
    !Number.isSafeInteger(revision.documentRevision) ||
    (revision.documentRevision as number) < 0 ||
    !Number.isSafeInteger(revision.contentRevision) ||
    (revision.contentRevision as number) < 0
  ) {
    return undefined
  }
  return {
    documentRevision: revision.documentRevision as number,
    contentRevision: revision.contentRevision as number
  }
}

function formatInputReference(reference: InputReference): string {
  return [
    `id=${reference.inputId}`,
    `sha256=${reference.sha256}`,
    `mediaType=${reference.mediaType}`,
    `bytes=${reference.byteLength}`,
    `chunks=${reference.chunkCount}`,
    ...(reference.sourceName ? [`sourceName=${reference.sourceName}`] : [])
  ].join(', ')
}

function providerStaticContextBytes(): number {
  const tools = PROVIDER_TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.jsonSchema
  }))
  return (
    Buffer.byteLength(SYSTEM_PROMPT, 'utf8') +
    Buffer.byteLength(JSON.stringify(tools), 'utf8')
  )
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref()
  })
}

function toolResultWorkspaceRevision(
  result: ToolResult
): WorkspaceRevision | undefined {
  if (!isRecord(result.data)) return undefined
  const parsed = workspaceRevisionSchema.safeParse(result.data.revision)
  return parsed.success ? parsed.data : undefined
}

function receiptMatchesOperation(
  receipt: OperationReceipt,
  operation: CadOperationRequest
): boolean {
  return (
    receipt.operationId === operation.operationId &&
    receipt.operationGroupId === operation.operationGroupId &&
    receipt.idempotencyKey === operation.idempotencyKey &&
    receipt.toolName === operation.toolName &&
    receipt.argumentsHash === operation.argumentsHash &&
    sameWorkspaceRevision(receipt.revisionBefore, operation.expectedRevision)
  )
}

function committedReceiptMatchesResult(
  receipt: OperationReceipt,
  result: ToolResult
): boolean {
  if (receipt.status !== 'committed') return true
  if (result.error || !receipt.revisionAfter || !receipt.resultHash) return true
  const resultRevision = toolResultWorkspaceRevision(result)
  if (
    !resultRevision ||
    !sameWorkspaceRevision(receipt.revisionAfter, resultRevision) ||
    !isRecord(result.data)
  ) {
    return false
  }
  const payload = { ...result.data }
  delete payload.revision
  const candidates: unknown[] = [payload]
  if (Object.keys(payload).length === 1 && 'value' in payload) {
    candidates.push(payload.value)
  }
  if (
    receipt.resultReference?.kind === 'inline-json' &&
    createHash('sha256')
      .update(receipt.resultReference.json, 'utf8')
      .digest('hex') !== receipt.resultHash
  ) {
    return false
  }
  return candidates.some((candidate) => {
    const json = JSON.stringify(candidate)
    return (
      json !== undefined &&
      createHash('sha256').update(json, 'utf8').digest('hex') ===
        receipt.resultHash
    )
  })
}

interface PendingCall {
  name: string
  resolve: (result: ToolResult) => void
  timer: ReturnType<typeof setTimeout>
  expectedRevision?: CadSessionRevisionSnapshot
  operation?: CadOperationRequest
}

interface PendingOperationStatus {
  operationId: string
  resolve: (result: OperationStatusResult) => void
  timer: ReturnType<typeof setTimeout>
}

interface ActiveTurn {
  startedAt: number
  firstTextMs?: number
  firstToolCallMs?: number
  toolCalls: number
  mutationCalls: number
  retries: number
  inputTokens?: number
  outputTokens?: number
  unresolvedOperationId?: string
  committedReceipts: number
  verificationWarnings: string[]
  visualEvidence: Array<{
    evidenceId: string
    revision: WorkspaceRevision
  }>
}

export interface BridgeSessionOptions {
  providerManager: ProviderManager
  skillRegistry?: SkillRegistry
  inputStore?: LocalInputStore
  inputRetrieval?: InputRetrievalService
  turnJournal?: TurnJournalPort
  toolTimeoutMs?: number
  logger?: Pick<Console, 'log' | 'error'>
}

export function buildTurnPrompt(
  text: string,
  selection?: SelectionContext,
  sheet?: SheetSnapshot,
  skillInvocation = invokeTextToCadSkillForTurn()
): string {
  const selectionNote =
    selection && selection.count > 0
      ? `Selection attached: ${selection.count} entities. Exact ids are held by EnvCAD; use get_selected_entities to read them in bounded pages. Units: ${selection.units}.`
      : 'Selection attached: none.'
  const sheetNote = sheet
    ? `Active sheet: ${sheet.paper} ${sheet.orientation}, scale 1:${sheet.scaleDenominator}, ` +
      `drawing unit ${sheet.drawingUnit}${sheet.templateId ? `, template ${sheet.templateId}` : ''}.`
    : undefined
  const contextLines = [
    skillInvocation,
    selectionNote,
    sheetNote
  ]
    .filter(Boolean)
    .join('\n')
  return `${text}\n\n<context>\n${contextLines}\n</context>`
}

/**
 * One provider-neutral conversation coordinator per authenticated renderer
 * WebSocket. Provider discovery remains usable even when no provider is ready.
 */
export class BridgeSession {
  private readonly pendingCalls = new Map<string, PendingCall>()
  private readonly pendingOperationStatuses = new Map<
    string,
    PendingOperationStatus
  >()
  private lastSelectionSnapshot: SelectionContext | undefined
  private lastSheet: SheetSnapshot | undefined
  private appliedConfiguration: AgentConfiguration | undefined
  private appliedRevision: number | undefined
  private latestRequestedRevision = 0
  private configurationQueue = Promise.resolve()
  private pendingConversationStartupMs: number | undefined
  private activeTurn: ActiveTurn | undefined
  private activeTurnRevision: CadSessionRevisionSnapshot | undefined
  private activeWorkspaceRevision: WorkspaceRevision | undefined
  private activeDurableTurnId: string | undefined
  private activeInputIds = new Set<string>()
  private operationOrdinal = 0
  private protocolSequence = 0
  private activeTurnPromise: Promise<void> | undefined
  private turnRunning = false
  private capabilityRefreshPending = false
  private discoveryInFlight: Promise<void> | undefined
  private closed = false
  private closePromise: Promise<void> | undefined
  private toolDispatchQueue = Promise.resolve()
  private readonly toolTimeoutMs: number | undefined
  private readonly logger: Pick<Console, 'log' | 'error'>
  private readonly manager: ProviderManager
  private readonly skillRegistry: SkillRegistry
  private readonly capabilityBroker: CapabilityBroker
  private readonly contextBudget: ContextBudgetManager
  private readonly providerToolBridge: CadToolBridge
  private readonly inputStore: LocalInputStore | undefined
  private readonly inputRetrieval: InputRetrievalService | undefined
  private readonly turnOrchestrator: TurnOrchestrator | undefined
  readonly discoveryReady: Promise<void>

  private readonly browserToolBridge: CadToolBridge = {
    callTool: (name, input) => this.callTool(name, input),
    getSelectionSnapshot: () => this.lastSelectionSnapshot
  }

  constructor(
    private readonly ws: WebSocket,
    options: BridgeSessionOptions
  ) {
    this.manager = options.providerManager
    this.logger = options.logger ?? console
    this.skillRegistry = options.skillRegistry ?? new SkillRegistry()
    this.skillRegistry.initialize()
    this.contextBudget = new ContextBudgetManager({
      staticContextBytes: providerStaticContextBytes()
    })
    this.capabilityBroker = new CapabilityBroker({
      delegate: this.browserToolBridge,
      skillRegistry: this.skillRegistry,
      contextBudget: this.contextBudget,
      audit: (event) => {
        if (event.decision === 'denied') {
          this.logger.error(
            `[sidecar] capability denied for ${event.toolName}: ${event.reason ?? 'policy'}`
          )
        }
      }
    })
    this.providerToolBridge = this.capabilityBroker
    this.inputStore = options.inputStore
    this.inputRetrieval = options.inputRetrieval
    this.toolTimeoutMs = options.toolTimeoutMs
    this.turnOrchestrator = options.turnJournal
      ? new TurnOrchestrator({
          journal: options.turnJournal,
          emit: (envelope) => this.sendV2(envelope)
        })
      : undefined
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
        if (pending.operation && this.activeTurn) {
          this.activeTurn.unresolvedOperationId = pending.operation.operationId
        }
        pending.resolve({ error: `${reason} while waiting for ${pending.name}` })
      }
      this.pendingCalls.clear()
      for (const pending of this.pendingOperationStatuses.values()) {
        clearTimeout(pending.timer)
        pending.resolve({ operationId: pending.operationId })
      }
      this.pendingOperationStatuses.clear()
      try {
        await this.manager.close()
      } catch (error) {
        this.logger.error('[sidecar] provider cleanup failed:', error)
      }
      try {
        await this.activeTurnPromise
      } catch (error) {
        this.logger.error('[sidecar] active turn cleanup failed:', error)
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

  private sendV2(envelope: AgentServerEnvelope): void {
    if (!this.closed && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(envelope))
      } catch (error) {
        this.logger.error(
          `[sidecar] failed to send durable ${envelope.payload.type}:`,
          error
        )
      }
    }
  }

  private sendProtocolPayload(
    sessionId: string,
    payload: AgentServerPayload
  ): void {
    const envelope = agentServerEnvelopeSchema.parse({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      sessionId,
      messageId: randomUUID(),
      sequence: ++this.protocolSequence,
      timestamp: new Date().toISOString(),
      payload
    })
    this.sendV2(envelope)
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
        const providers = await this.manager.discover(
          (provider) => {
            this.send({ type: 'ai_provider_status', provider })
          },
          { force: this.capabilityRefreshPending }
        )
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

    if (isRecord(decoded) && decoded.protocolVersion !== undefined) {
      const parsed = parseAgentClientEnvelope(decoded)
      if (!parsed.ok) {
        this.logger.error(
          `[sidecar] rejected protocol v2 browser command: ${parsed.developerMessage}`
        )
        this.send({
          type: 'error',
          message: 'EnvCAD rejected an invalid durable assistant command.'
        })
        return
      }
      void this.handleV2Message(parsed.value).catch((error) => {
        this.logger.error('[sidecar] protocol v2 command failed:', error)
        this.send({
          type: 'error',
          message:
            'The durable assistant command could not be completed safely.'
        })
      })
      return
    }

    const parsed = parseClientMessage(decoded)
    if (!parsed.ok) {
      this.reportProtocolError(parsed.error)
      return
    }
    this.handleMessage(parsed.value)
  }

  private async handleV2Message(message: AgentClientEnvelope): Promise<void> {
    switch (message.payload.type) {
      case 'submit_turn':
        await this.handleV2Submit(submitTurnEnvelopeSchema.parse(message))
        return
      case 'input_begin':
      case 'input_chunk':
      case 'input_commit':
      case 'input_abort':
        await this.handleInputCommand(message.sessionId, message.payload)
        return
      case 'resume_turn': {
        const result = await this.turnOrchestrator?.resume(
          message.payload.turnId,
          message.sessionId,
          message.payload.lastSequence
        )
        if (!result?.found) {
          this.send({
            type: 'error',
            message: 'The requested durable turn could not be found.'
          })
        }
        return
      }
      case 'cancel_turn':
        if (
          !this.turnOrchestrator?.cancel(
            message.payload.turnId,
            message.sessionId
          )
        ) {
          this.send({
            type: 'error',
            message: 'The requested turn is no longer active.'
          })
        }
        return
      case 'refresh_ai_capabilities':
        this.handleMessage({ type: 'refresh_ai_capabilities' })
        return
      case 'set_ai_configuration':
        this.handleMessage({
          type: 'set_ai_configuration',
          revision: message.payload.revision,
          configuration: message.payload.configuration
        })
        return
      case 'reset_conversation':
        this.handleMessage({
          type: 'reset',
          revision: message.payload.revision
        })
        return
      default:
        this.send({
          type: 'error',
          message:
            'This protocol v2 command is not available in the current incremental runtime.'
        })
    }
  }

  private async handleInputCommand(
    sessionId: string,
    command: InputIngestionCommand
  ): Promise<void> {
    const store = this.inputStore
    if (!store) {
      this.sendProtocolPayload(sessionId, {
        type: 'protocol_error',
        code: 'input-store-unavailable',
        inputId: command.inputId,
        message:
          'The local large-input store is unavailable. The composer draft remains unchanged.'
      })
      return
    }
    try {
      if (command.type === 'input_begin') {
        const progress = await store.begin(command)
        if (progress.committed) {
          this.sendProtocolPayload(sessionId, {
            type: 'input_committed',
            reference: progress.committed
          })
        } else {
          this.sendProtocolPayload(sessionId, {
            type: 'input_progress',
            inputId: command.inputId,
            receivedBytes: progress.receivedBytes,
            receivedChunks: progress.receivedChunks,
            status: 'receiving'
          })
        }
        return
      }
      if (command.type === 'input_chunk') {
        const progress = await store.append(command)
        this.sendProtocolPayload(sessionId, {
          type: 'input_progress',
          inputId: command.inputId,
          receivedBytes: progress.receivedBytes,
          receivedChunks: progress.receivedChunks,
          status: 'receiving'
        })
        return
      }
      if (command.type === 'input_commit') {
        const reference = await store.commit(command)
        this.sendProtocolPayload(sessionId, {
          type: 'input_progress',
          inputId: command.inputId,
          receivedBytes: reference.byteLength,
          receivedChunks: reference.chunkCount,
          status: 'indexing'
        })
        this.sendProtocolPayload(sessionId, {
          type: 'input_committed',
          reference
        })
        return
      }
      await store.abort(command.inputId)
      this.sendProtocolPayload(sessionId, {
        type: 'input_aborted',
        inputId: command.inputId
      })
    } catch (error) {
      const capacity = error instanceof InputStoreCapacityError
      this.logger.error(
        `[sidecar] local input ingestion failed for ${command.type}:`,
        error
      )
      this.sendProtocolPayload(sessionId, {
        type: 'protocol_error',
        code: capacity ? 'input-capacity-exhausted' : 'input-ingestion-failed',
        inputId: command.inputId,
        message: capacity
          ? 'EnvCAD cannot safely reserve enough local disk space for this input. The draft was not sent to a provider.'
          : 'EnvCAD could not verify and preserve this input. The draft was not sent to a provider.'
      })
    }
  }

  private async handleV2Submit(draft: SubmitTurnEnvelope): Promise<void> {
    if (!this.turnOrchestrator) {
      this.send({
        type: 'error',
        message: 'Durable turn storage is unavailable; the message was not accepted.'
      })
      return
    }
    if (this.capabilitiesBusy) {
      this.send({
        type: 'error',
        message:
          'AI capabilities are refreshing; the message remains unaccepted and can be retried.'
      })
      return
    }
    if (this.turnRunning) {
      this.send({
        type: 'error',
        message: 'Another assistant turn is already active.'
      })
      return
    }
    const configuration = this.appliedConfiguration
    const conversation = this.manager.conversation
    if (
      !configuration ||
      !conversation ||
      this.appliedRevision === undefined ||
      draft.payload.configurationRevision !== this.appliedRevision
    ) {
      this.send({
        type: 'error',
        message:
          'The selected provider configuration is not acknowledged; the message was not accepted.'
      })
      return
    }

    let skills: SkillInvocation
    let classificationText: string | undefined
    try {
      classificationText =
        draft.payload.text ??
        (draft.payload.instructionInputId
          ? await this.inputRetrieval?.classificationText(
              draft.payload.instructionInputId
            )
          : undefined)
      skills = this.skillRegistry.activate(
        draft.payload,
        new Date().toISOString(),
        classificationText
      )
    } catch (error) {
      this.logger.error('[sidecar] CAD skill activation failed:', error)
      this.send({
        type: 'error',
        message:
          'EnvCAD could not load the local skill catalog; the message was not accepted and remains available to retry.'
      })
      return
    }
    const selection = draft.payload.selectionSnapshot
    const turnSelectionSnapshot = {
      count: selection.count,
      units: selection.units,
      revision: {
        documentRevision: selection.revision.documentRevision,
        contentRevision: selection.revision.contentRevision
      }
    }
    const turnSheet = { ...draft.payload.sheet }
    const capability = this.providerCapability(configuration)
    const prompt =
      draft.payload.text &&
      !draft.payload.instructionInputId &&
      draft.payload.referenceInputIds.length === 0
        ? buildTurnPrompt(
            draft.payload.text,
            turnSelectionSnapshot,
            turnSheet,
            skills.promptFragment
          )
        : undefined
    this.contextBudget.beginTurn()
    try {
      if (prompt) this.contextBudget.registerPrompt(prompt)
    } catch (error) {
      this.contextBudget.endTurn()
      this.logger.error('[sidecar] provider context budget rejected turn:', error)
      this.send({
        type: 'error',
        message:
          'This message cannot safely fit the provider context window. It remains available to shorten or attach as a local reference.'
      })
      return
    }
    this.capabilityBroker.activate(skills)
    this.lastSelectionSnapshot = turnSelectionSnapshot
    this.lastSheet = turnSheet
    this.activeWorkspaceRevision = { ...selection.revision }
    this.activeDurableTurnId = draft.turnId
    this.activeInputIds = new Set([
      ...(draft.payload.instructionInputId
        ? [draft.payload.instructionInputId]
        : []),
      ...draft.payload.referenceInputIds
    ])
    this.operationOrdinal = 0
    this.activeTurnRevision = {
      documentRevision: selection.revision.documentRevision,
      contentRevision: selection.revision.contentRevision
    }
    const active: ActiveTurn = {
      startedAt: performance.now(),
      toolCalls: 0,
      mutationCalls: 0,
      retries: 0,
      committedReceipts: 0,
      verificationWarnings: [],
      visualEvidence: []
    }
    this.activeTurn = active
    this.turnRunning = true
    this.send({ type: 'status', state: 'thinking' })

    const running = this.turnOrchestrator
      .submit(draft, {
        provider: configuration.provider,
        ...(prompt
          ? { prompt }
          : {
              resolvePrompt: () =>
                this.resolveTurnPrompt(draft, skills.promptFragment)
            }),
        activeSkills: skills.activations,
        ...(classificationText
          ? {
              classificationText
            }
          : {}),
        conversation,
        recoverProvider: (failure, signal) =>
          this.manager.recreateConversation(
            this.providerToolBridge,
            failure,
            signal
          ),
        currentRevision: () => ({
          ...(this.activeWorkspaceRevision ?? selection.revision)
        }),
        toolMetrics: () => ({
          toolCalls: active.toolCalls,
          mutationCalls: active.mutationCalls,
          ...(active.firstToolCallMs !== undefined
            ? { firstToolCallMs: active.firstToolCallMs }
            : {})
        }),
        unresolvedMutation: () => active.unresolvedOperationId,
        performPrePlanningInspection: () =>
          this.performPrePlanningInspection(
            skills,
            active,
            configuration
          ),
        performVerification: () =>
          this.performTurnVerification(
            skills,
            active,
            configuration
          ),
        ...(capability?.discoveryMs !== undefined
          ? { providerReadyMs: capability.discoveryMs }
          : {}),
        ...(this.pendingConversationStartupMs !== undefined
          ? { conversationStartupMs: this.pendingConversationStartupMs }
          : {})
      })
      .then(() => undefined)
      .catch((error) => {
        this.logger.error('[sidecar] durable turn execution failed:', error)
        if (!this.closed) {
          this.ws.close(1011, 'Durable turn state unavailable')
        }
      })
      .finally(() => {
        this.pendingConversationStartupMs = undefined
        this.activeTurn = undefined
        this.activeTurnRevision = undefined
        this.activeWorkspaceRevision = undefined
        this.activeDurableTurnId = undefined
        this.activeInputIds = new Set()
        this.capabilityBroker.deactivate()
        this.contextBudget.endTurn()
        this.turnRunning = false
        this.send({ type: 'status', state: 'idle' })
        if (this.activeTurnPromise === running) {
          this.activeTurnPromise = undefined
        }
      })
    this.activeTurnPromise = running
    await running
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
        void this.resolveToolResult(
          message.callId,
          message.result,
          message.operationReceipt
        ).catch((error) => {
          this.logger.error('[sidecar] operation receipt handling failed:', error)
        })
        break
      case 'operation_status':
        this.resolveOperationStatus(message.requestId, message.result)
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
      const result = await this.manager.applyConfiguration(
        configuration,
        this.providerToolBridge
      )
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
      await this.manager.recreateConversation(this.providerToolBridge)
      this.pendingConversationStartupMs = performance.now() - startedAt
      this.appliedConfiguration = configuration
      this.appliedRevision = revision
      this.send({
        type: 'ai_configuration_applied',
        revision,
        configuration,
        newConversation: true
      })
    } catch (error) {
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
    const inputSpec = getInputToolSpec(name)
    if (inputSpec) return this.dispatchInputTool(inputSpec.name, input)
    const spec = getCadToolSpec(name)
    if (!spec) return Promise.resolve({ error: `Unknown CAD tool: ${name}` })
    const timeoutMs = this.toolTimeoutMs ?? spec.timeoutMs
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ error: `Browser connection is not open; cannot run ${name}` })
    }
    const turn = this.activeTurn
    if (turn) {
      turn.toolCalls += 1
      if (toolCallMayMutate(name, input)) turn.mutationCalls += 1
      turn.firstToolCallMs ??= performance.now() - turn.startedAt
    }
    const expectedRevision = turn
      ? this.activeTurnRevision
      : undefined
    if (turn && !expectedRevision) {
      return Promise.resolve({
        error: `Cannot run ${name}: the active AI turn has no drawing revision.`
      })
    }
    const browserInput =
      expectedRevision && isRecord(input)
        ? {
            ...input,
            [ENVCAD_TURN_REVISION_FIELD]: { ...expectedRevision }
          }
        : input
    const operation = this.createOperationRequest(
      name,
      input,
      timeoutMs
    )
    if (
      this.activeDurableTurnId &&
      toolCallMayMutate(name, input) &&
      !operation
    ) {
      return Promise.resolve({
        error:
          `EnvCAD could not create durable operation metadata for ${name}; no mutation was sent.`
      })
    }

    return new Promise((resolve) => {
      const callId = randomUUID()
      const timer = setTimeout(() => {
        const pending = this.pendingCalls.get(callId)
        if (pending?.operation) {
          void this.reconcileTimedOutOperation(callId)
          return
        }
        this.pendingCalls.delete(callId)
        resolve({
          error: `Timed out waiting for the browser to respond to ${name} after ${timeoutMs / 1000}s`
        })
      }, timeoutMs)
      timer.unref()
      this.pendingCalls.set(callId, {
        name,
        resolve,
        timer,
        ...(expectedRevision ? { expectedRevision: { ...expectedRevision } } : {}),
        ...(operation ? { operation } : {})
      })

      if (!this.send({
        type: 'tool_call',
        callId,
        name: spec.name,
        input: browserInput,
        ...(operation
          ? {
              turnId: operation.turnId,
              operation
            }
          : {})
      })) {
        clearTimeout(timer)
        this.pendingCalls.delete(callId)
        resolve({ error: `Failed to send ${name} to the browser` })
      }
    })
  }

  private async dispatchInputTool(
    name: InputToolName,
    input: unknown
  ): Promise<ToolResult> {
    const retrieval = this.inputRetrieval
    const spec = getInputToolSpec(name)
    const parsed = spec?.inputSchema.safeParse(input)
    if (!retrieval || !spec || !parsed?.success) {
      return {
        error: !retrieval
          ? 'The local input retrieval service is unavailable.'
          : `Invalid arguments for ${name}.`
      }
    }
    const request = parsed.data as {
      inputId: string
      chunkIndex?: number
      query?: string
      limit?: number
      byteStart?: number
      byteLength?: number
    }
    if (
      !this.activeDurableTurnId ||
      !this.activeInputIds.has(request.inputId)
    ) {
      return {
        error:
          'The requested local input is not attached to the active durable turn.'
      }
    }
    const turn = this.activeTurn
    if (turn) {
      turn.toolCalls += 1
      turn.firstToolCallMs ??= performance.now() - turn.startedAt
    }
    try {
      switch (name) {
        case 'get_input_metadata':
          return { data: await retrieval.metadata(request.inputId) }
        case 'get_input_outline':
          return { data: await retrieval.outline(request.inputId) }
        case 'search_input':
          return {
            data: await retrieval.search(
              request.inputId,
              request.query!,
              request.limit
            )
          }
        case 'read_input_chunk':
          return {
            data: await retrieval.readChunk(
              request.inputId,
              request.chunkIndex!
            )
          }
        case 'read_input_range':
          return {
            data: await retrieval.readRange(
              request.inputId,
              request.byteStart!,
              request.byteLength!
            )
          }
      }
    } catch (error) {
      this.logger.error(`[sidecar] ${name} failed:`, error)
      return {
        error:
          error instanceof InputRetrievalRequestError
            ? error.message
            : 'The requested local input range could not be verified and read.'
      }
    }
  }

  private async resolveTurnPrompt(
    draft: SubmitTurnEnvelope,
    skillPrompt: string
  ): Promise<string> {
    const retrieval = this.inputRetrieval
    if (!retrieval) throw new Error('Local input retrieval is unavailable.')
    const instructionId = draft.payload.instructionInputId
    const referenceIds = draft.payload.referenceInputIds
    const inputIds = [
      ...(instructionId ? [instructionId] : []),
      ...referenceIds
    ]
    const references = await Promise.all(
      inputIds.map((inputId) => retrieval.metadata(inputId))
    )
    const byId = new Map(
      references.map((reference) => [reference.inputId, reference])
    )
    const lines = [
      'Authoritative user content is preserved in EnvCAD’s local input store.',
      'Retrieve only required ranges with get_input_outline, search_input, read_input_chunk, and read_input_range.',
      'Cite input ids and exact byte ranges in summaries; summaries are never authoritative.',
      ...(instructionId
        ? [
            `Instruction input: ${formatInputReference(
              byId.get(instructionId)!
            )}. Read it before planning or acting.`
          ]
        : []),
      ...referenceIds.map(
        (inputId) =>
          `Reference input: ${formatInputReference(byId.get(inputId)!)}.`
      )
    ]
    const instruction = draft.payload.text
      ? `${draft.payload.text}\n\n<local-input-references>\n${lines.join('\n')}\n</local-input-references>`
      : `<local-authoritative-instruction>\n${lines.join('\n')}\n</local-authoritative-instruction>`
    const prompt = buildTurnPrompt(
      instruction,
      this.lastSelectionSnapshot,
      this.lastSheet,
      skillPrompt
    )
    this.contextBudget.registerPrompt(prompt)
    return prompt
  }

  private createOperationRequest(
    name: string,
    input: unknown,
    timeoutMs: number
  ): CadOperationRequest | undefined {
    if (!toolCallMayMutate(name, input)) return undefined
    const turnId = this.activeDurableTurnId
    const expectedRevision = this.activeWorkspaceRevision
    const parsedInput = toolInputJsonSchema.safeParse(input)
    if (!turnId || !expectedRevision || !parsedInput.success) return undefined
    this.operationOrdinal += 1
    const argumentsHash = createHash('sha256')
      .update(operationArgumentsPreimage(name, parsedInput.data), 'utf8')
      .digest('hex')
    const idempotencyKey = createHash('sha256')
      .update('envcad-operation-v2\0', 'utf8')
      .update(turnId, 'utf8')
      .update('\0', 'utf8')
      .update(String(this.operationOrdinal), 'utf8')
      .update('\0', 'utf8')
      .update(name, 'utf8')
      .update('\0', 'utf8')
      .update(argumentsHash, 'utf8')
      .digest('hex')
    return {
      turnId,
      operationId: `operation-${idempotencyKey.slice(0, 40)}`,
      operationGroupId: `turn-${createHash('sha256')
        .update(turnId, 'utf8')
        .digest('hex')
        .slice(0, 40)}`,
      idempotencyKey,
      toolName: name,
      argumentsHash,
      expectedRevision: { ...expectedRevision },
      deadline: new Date(Date.now() + timeoutMs + 30_000).toISOString()
    }
  }

  private async resolveToolResult(
    callId: string,
    result: ToolResult,
    operationReceipt?: OperationReceipt
  ): Promise<void> {
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
      operationReceipt &&
      (!pending.operation ||
        !receiptMatchesOperation(operationReceipt, pending.operation))
    ) {
      this.reportProtocolError(
        `tool_result operation receipt does not match callId "${callId}"`
      )
      pending.resolve({
        error: 'Browser returned a mismatched CAD operation receipt.'
      })
      return
    }
    if (
      pending.operation &&
      operationReceipt &&
      !committedReceiptMatchesResult(operationReceipt, validated.value)
    ) {
      this.reportProtocolError(
        `tool_result operation receipt evidence does not match callId "${callId}"`
      )
      if (this.activeTurn) {
        this.activeTurn.unresolvedOperationId = pending.operation.operationId
      }
      pending.resolve({
        error:
          'Browser returned conflicting CAD operation evidence. EnvCAD will not retry this mutation.'
      })
      return
    }
    if (pending.operation && !operationReceipt && !result.error) {
      this.reportProtocolError(
        `tool_result omitted the mutation receipt for callId "${callId}"`
      )
      pending.resolve({
        error: 'Browser omitted the durable CAD operation receipt.'
      })
      return
    }
    if (pending.operation && operationReceipt) {
      try {
        await this.turnOrchestrator?.recordOperationReceipt(
          pending.operation.turnId,
          operationReceipt
        )
      } catch (error) {
        if (this.activeTurn) {
          this.activeTurn.unresolvedOperationId =
            pending.operation.operationId
        }
        pending.resolve({
          error:
            `Operation ${pending.operation.operationId} reached ${operationReceipt.status}, ` +
            'but its turn journal could not be updated. Do not retry this mutation.'
        })
        throw error
      }
      if (
        this.activeTurn?.unresolvedOperationId ===
          pending.operation.operationId &&
        operationReceipt.status !== 'pending' &&
        operationReceipt.status !== 'unknown'
      ) {
        this.activeTurn.unresolvedOperationId = undefined
      }
      if (
        operationReceipt.status === 'committed' &&
        this.activeTurn
      ) {
        this.activeTurn.committedReceipts += 1
      }
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
    if (
      validated.value.image &&
      !this.recordVisualEvidence(validated.value)
    ) {
      this.reportProtocolError(
        `invalid ${pending.name} result: visual evidence metadata is missing or inconsistent`
      )
      pending.resolve({
        error: `Browser returned unbound visual evidence for ${pending.name}.`
      })
      return
    }
    if (pending.expectedRevision && !validated.value.error) {
      const revision = toolResultRevision(validated.value)
      if (
        !revision ||
        revision.documentRevision !== pending.expectedRevision.documentRevision ||
        revision.contentRevision < pending.expectedRevision.contentRevision
      ) {
        const message =
          `invalid ${pending.name} result: missing or stale drawing revision`
        this.reportProtocolError(message)
        pending.resolve({
          error: `Browser returned an invalid ${pending.name} drawing revision.`
        })
        return
      }
      this.activeTurnRevision = revision
      const workspaceRevision = toolResultWorkspaceRevision(validated.value)
      this.activeWorkspaceRevision = workspaceRevision
        ? { ...workspaceRevision }
        : this.activeWorkspaceRevision
          ? {
              ...this.activeWorkspaceRevision,
              documentRevision: revision.documentRevision,
              contentRevision: revision.contentRevision
            }
          : undefined
    }
    pending.resolve(validated.value)
  }

  private recordVisualEvidence(result: ToolResult): boolean {
    if (!result.image || !isRecord(result.data)) return !result.image
    const evidence = result.data.evidence
    if (!isRecord(evidence)) return false
    const revision = workspaceRevisionSchema.safeParse(
      evidence.workspaceRevision
    )
    if (
      typeof evidence.evidenceId !== 'string' ||
      evidence.evidenceId.length < 1 ||
      evidence.evidenceId.length > 200 ||
      evidence.imageDigest !== result.image.sha256 ||
      !revision.success
    ) {
      return false
    }
    const active = this.activeTurn
    if (!active) return true
    const previous = active.visualEvidence.findIndex(
      (item) => item.evidenceId === evidence.evidenceId
    )
    const item = {
      evidenceId: evidence.evidenceId,
      revision: { ...revision.data }
    }
    if (previous < 0) active.visualEvidence.push(item)
    else active.visualEvidence.splice(previous, 1, item)
    return true
  }

  private async performTurnVerification(
    skills: SkillInvocation,
    active: ActiveTurn,
    configuration: AgentConfiguration
  ): Promise<VerificationSummary> {
    const visualRequired = this.turnNeedsVisualEvidence(skills, active)
    const model = this.providerCapability(configuration)?.models.find(
      (candidate) =>
        candidate.invocationName === configuration.model ||
        candidate.id === configuration.model
    )
    const imageSupport = model
      ? modelImageInputSupport(model)
      : 'unknown'
    const warnings: string[] = [...active.verificationWarnings]

    if (visualRequired && imageSupport !== 'unsupported') {
      const current = this.activeWorkspaceRevision
      const hasCurrentEvidence =
        current &&
        active.visualEvidence.some((item) =>
          sameWorkspaceRevision(item.revision, current)
        )
      if (!hasCurrentEvidence) {
        const toolName =
          skills.intent === 'sheet-layout'
            ? 'inspect_sheet_preview'
            : 'inspect_model_view'
        const result = await this.capabilityBroker.callTool(
          toolName,
          toolName === 'inspect_sheet_preview' ? { view: 'full' } : {}
        )
        if (result.error) {
          warnings.push(
            `Visual verification could not run: ${result.error}`
          )
        }
      }
    } else if (visualRequired) {
      warnings.push(
        'The selected model cannot process images; verification is database-only.'
      )
    }

    const revision = {
      ...(this.activeWorkspaceRevision ??
        this.contextFreeWorkspaceRevision())
    }
    const evidenceIds = active.visualEvidence
      .filter((item) => sameWorkspaceRevision(item.revision, revision))
      .map((item) => item.evidenceId)
    if (visualRequired && evidenceIds.length === 0 && warnings.length === 0) {
      warnings.push(
        'No visual artifact was validated at the final workspace revision.'
      )
    }
    return {
      mode:
        evidenceIds.length > 0
          ? 'database-and-visual'
          : skills.intent === 'conversation-help'
            ? 'not-applicable'
            : 'database-only',
      databaseChecks:
        active.committedReceipts > 0
          ? [
              `${active.committedReceipts} committed operation receipt${active.committedReceipts === 1 ? '' : 's'} reconciled.`
            ]
          : skills.intent === 'conversation-help'
            ? []
            : ['Final drawing context is bound to the workspace revision.'],
      visualEvidenceIds: evidenceIds,
      warnings: [...new Set(warnings)],
      revision
    }
  }

  private async performPrePlanningInspection(
    skills: SkillInvocation,
    active: ActiveTurn,
    configuration: AgentConfiguration
  ): Promise<void> {
    if (!skills.activeSkillIds.has('visual-quality-assurance')) return
    const model = this.providerCapability(configuration)?.models.find(
      (candidate) =>
        candidate.invocationName === configuration.model ||
        candidate.id === configuration.model
    )
    if (model && modelImageInputSupport(model) === 'unsupported') {
      active.verificationWarnings.push(
        'The selected model cannot process images; pre-planning inspection was skipped.'
      )
      return
    }
    const toolName =
      skills.intent === 'sheet-layout'
        ? 'inspect_sheet_preview'
        : 'inspect_model_view'
    const result = await this.capabilityBroker.callTool(
      toolName,
      toolName === 'inspect_sheet_preview' ? { view: 'full' } : {}
    )
    if (result.error) {
      active.verificationWarnings.push(
        `Pre-planning visual inspection could not run: ${result.error}`
      )
    }
  }

  private turnNeedsVisualEvidence(
    skills: SkillInvocation,
    active: ActiveTurn
  ): boolean {
    if (
      skills.intent === 'visual-analysis' ||
      skills.intent === 'sheet-layout'
    ) {
      return true
    }
    if (active.mutationCalls === 0) return false
    return [
      'annotation',
      'layer-hygiene',
      'visual-quality-assurance'
    ].some((skillId) => skills.activeSkillIds.has(skillId))
  }

  private contextFreeWorkspaceRevision(): WorkspaceRevision {
    return {
      documentId: 'no-document',
      documentRevision: 0,
      contentRevision: 0,
      sheetRevision: 0,
      viewRevision: 0
    }
  }

  private async reconcileTimedOutOperation(callId: string): Promise<void> {
    while (true) {
      const pending = this.pendingCalls.get(callId)
      const operation = pending?.operation
      if (!pending || !operation) return
      const status = await this.requestOperationStatus(operation)
      if (this.pendingCalls.get(callId) !== pending) return
      const receipt = status.receipt
      if (
        receipt &&
        receiptMatchesOperation(receipt, operation) &&
        receipt.status !== 'pending'
      ) {
        if (receipt.status === 'unknown' && this.activeTurn) {
          this.activeTurn.unresolvedOperationId = operation.operationId
        }
        if (receipt.status === 'committed') {
          await delay(250)
          if (this.pendingCalls.get(callId) !== pending) return
        }
        clearTimeout(pending.timer)
        this.pendingCalls.delete(callId)
        try {
          await this.turnOrchestrator?.recordOperationReceipt(
            operation.turnId,
            receipt
          )
        } catch (error) {
          if (this.activeTurn) {
            this.activeTurn.unresolvedOperationId = operation.operationId
          }
          this.logger.error(
            '[sidecar] timed-out operation receipt journaling failed:',
            error
          )
        }
        pending.resolve({
          error:
            `CAD operation ${operation.operationId} is ${receipt.status}. ` +
            'EnvCAD will not repeat it automatically.'
        })
        return
      }
      if (Date.now() >= Date.parse(operation.deadline)) {
        if (this.activeTurn) {
          this.activeTurn.unresolvedOperationId = operation.operationId
        }
        clearTimeout(pending.timer)
        this.pendingCalls.delete(callId)
        pending.resolve({
          error:
            `CAD operation ${operation.operationId} did not reach a known status before its deadline. ` +
            'EnvCAD will not repeat it automatically.'
        })
        return
      }
      await delay(500)
    }
  }

  private requestOperationStatus(
    operation: CadOperationRequest
  ): Promise<OperationStatusResult> {
    const requestId = randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingOperationStatuses.delete(requestId)
        resolve({ operationId: operation.operationId })
      }, 2_000)
      timer.unref()
      this.pendingOperationStatuses.set(requestId, {
        operationId: operation.operationId,
        resolve,
        timer
      })
      if (
        !this.send({
          type: 'get_operation_status',
          turnId: operation.turnId,
          requestId,
          operationId: operation.operationId
        })
      ) {
        clearTimeout(timer)
        this.pendingOperationStatuses.delete(requestId)
        resolve({ operationId: operation.operationId })
      }
    })
  }

  private resolveOperationStatus(
    requestId: string,
    result: OperationStatusResult
  ): void {
    const pending = this.pendingOperationStatuses.get(requestId)
    if (!pending) {
      this.reportProtocolError(
        `operation_status references unknown requestId "${requestId}"`
      )
      return
    }
    clearTimeout(pending.timer)
    this.pendingOperationStatuses.delete(requestId)
    if (result.operationId !== pending.operationId) {
      this.reportProtocolError(
        `operation_status does not match requestId "${requestId}"`
      )
      pending.resolve({ operationId: pending.operationId })
      return
    }
    pending.resolve(result)
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
    const skills = this.skillRegistry.activate({
      type: 'submit_turn',
      text,
      referenceInputIds: [],
      configurationRevision: this.appliedRevision ?? 0,
      selectionSnapshot: {
        count: this.lastSelectionSnapshot?.count ?? 0,
        units: this.lastSelectionSnapshot?.units ?? 'Unknown',
        revision: {
          documentId: 'protocol-v1-active-document',
          documentRevision:
            this.lastSelectionSnapshot?.revision.documentRevision ?? 0,
          contentRevision:
            this.lastSelectionSnapshot?.revision.contentRevision ?? 0,
          sheetRevision: 0,
          viewRevision: 0
        }
      },
      sheet: {
        paper: this.lastSheet?.paper ?? 'Unknown',
        orientation: this.lastSheet?.orientation ?? 'landscape',
        scaleDenominator: this.lastSheet?.scaleDenominator ?? 1,
        drawingUnit: this.lastSheet?.drawingUnit ?? 'Unknown',
        ...(this.lastSheet?.templateId
          ? { templateId: this.lastSheet.templateId }
          : {}),
        ...(this.lastSheet?.fields ? { fields: this.lastSheet.fields } : {})
      }
    })
    this.capabilityBroker.activate(skills)

    const active: ActiveTurn = {
      startedAt: performance.now(),
      toolCalls: 0,
      mutationCalls: 0,
      retries: 0,
      committedReceipts: 0,
      verificationWarnings: [],
      visualEvidence: []
    }
    this.activeTurn = active
    this.activeTurnRevision = this.lastSelectionSnapshot
      ? { ...this.lastSelectionSnapshot.revision }
      : undefined
    this.turnRunning = true
    this.send({ type: 'status', state: 'thinking' })

    let resolvedModel =
      this.providerCapability(configuration)?.models.find(
        (model) => model.invocationName === configuration.model
      )?.resolvedModel
    let completed = false
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
      completed = true
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
      if (completed) {
        this.send({
          type: 'assistant_done',
          provider: configuration.provider,
          model: configuration.model,
          ...(resolvedModel ? { resolvedModel } : {}),
          ...(configuration.effort ? { effort: configuration.effort } : {}),
          metrics
        })
      }
      this.send({ type: 'status', state: 'idle' })
      this.activeTurn = undefined
      this.activeTurnRevision = undefined
      this.turnRunning = false
      this.capabilityBroker.deactivate()
    }
  }
}
