import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import {
  ENVCAD_TURN_REVISION_FIELD,
  parseClientMessage,
  type AgentConfiguration,
  type CadSessionRevisionSnapshot,
  type CadToolName,
  type ClientMessage,
  type ProviderCapability,
  type ServerMessage,
  type ToolResult
} from '../src/agent/protocol'
import {
  AGENT_PROTOCOL_VERSION,
  parseAgentClientEnvelope,
  type AgentClientEnvelope,
  type AgentServerEnvelope,
  type AgentServerPayload,
  type InputIngestionCommand,
  type InputReference,
  type SubmitTurnCommand,
  type TurnEvent,
  type TurnPhase,
  type WorkspaceRevision
} from '../shared/agent-contracts'

const WS_PORT = 8787
const CONTROL_PORT = 8788
const HOST = '127.0.0.1'
const MAX_SCRIPTED_MUTATION_ID_CHARACTERS = 12_000
const MAX_SCRIPTED_MUTATION_ENTITY_COUNT = 100

let webSocketServer: WebSocketServer | undefined
let nextCallId = 1
let userMessageCount = 0
let toolResultCount = 0
let completionDelayMs = 0
let visualResultMode: 'success' | 'failure' = 'success'
let currentScenario = 'ready'
interface FakeInputUpload {
  mediaType: string
  sourceName?: string
  declaredByteLength?: number
  chunks: Buffer[]
  reference?: InputReference
}

interface FakeDurableTurn {
  sessionId: string
  turnId: string
  messageId: string
  revision: WorkspaceRevision
  configuration: AgentConfiguration
  events: AgentServerEnvelope[]
  subscribers: Set<WebSocket>
  terminal: boolean
  cancelled: boolean
}

const inputUploads = new Map<string, FakeInputUpload>()
const durableTurns = new Map<string, FakeDurableTurn>()
let lastVisualResultEvidence:
  | {
      provider: AgentConfiguration['provider']
      model: string
      toolName: 'inspect_sheet_preview'
      success: boolean
      mimeType?: string
      width?: number
      height?: number
      byteLength?: number
      rasterSha256?: string
      svgSha256?: string
    }
  | undefined
let lastPromptEvidence:
  | {
      provider: AgentConfiguration['provider']
      characters: number
      utf8Bytes: number
      sha256: string
      hasBeginSentinel: boolean
      hasMiddleSentinel: boolean
      hasEndSentinel: boolean
    }
  | undefined
const readyProviders: ProviderCapability[] = [
  {
    id: 'claude-code' as const,
    displayName: 'Claude Code',
    status: 'ready' as const,
    statusMessage: 'Fake Claude Code is ready.',
    executableVersion: 'test',
    models: [
      {
        id: 'fake-claude',
        invocationName: 'fake-claude',
        displayName: 'Fake Claude',
        description: 'Deterministic E2E model',
        inputModalities: ['text', 'image'],
        supportedEfforts: [
          {
            value: 'low',
            displayName: 'Low',
            description: 'Fast fake Claude effort',
            isDefault: false
          },
          {
            value: 'high',
            displayName: 'High',
            description: 'Quality fake Claude effort',
            isDefault: true
          }
        ],
        defaultEffort: 'high',
        isDefault: true
      }
    ]
  },
  {
    id: 'openai-codex' as const,
    displayName: 'OpenAI Codex',
    status: 'ready' as const,
    statusMessage: 'Fake Codex is ready using ChatGPT login.',
    executableVersion: '0.145.0-test',
    models: [
      {
        id: 'fake-codex-balanced',
        invocationName: 'fake-codex-balanced',
        displayName: 'Fake Codex Balanced',
        description: 'Deterministic balanced E2E model',
        inputModalities: ['text', 'image'],
        supportedEfforts: [
          {
            value: 'low',
            displayName: 'Low',
            description: 'Fast fake Codex effort',
            isDefault: false
          },
          {
            value: 'medium',
            displayName: 'Medium',
            description: 'Balanced fake Codex effort',
            isDefault: true
          }
        ],
        defaultEffort: 'medium',
        isDefault: true
      },
      {
        id: 'fake-codex-fast',
        invocationName: 'fake-codex-fast',
        displayName: 'Fake Codex Fast',
        description: 'Deterministic fast E2E model',
        inputModalities: ['text', 'image'],
        supportedEfforts: [
          {
            value: 'low',
            displayName: 'Low',
            description: 'Only supported fake Codex effort',
            isDefault: true
          }
        ],
        defaultEffort: 'low',
        isDefault: false
      }
    ]
  }
]
let providers = readyProviders

function clonedCatalog(catalog: readonly ProviderCapability[]): ProviderCapability[] {
  return structuredClone([...catalog])
}

function setScenario(name: string): boolean {
  if (name === 'ready') {
    providers = clonedCatalog(readyProviders)
  } else if (name === 'codex-text-only') {
    providers = clonedCatalog(readyProviders).map((provider) =>
      provider.id === 'openai-codex'
        ? {
            ...provider,
            models: provider.models.map((model) => ({
              ...model,
              inputModalities: ['text']
            }))
          }
        : provider
    )
  } else if (name === 'codex-missing') {
    providers = clonedCatalog(readyProviders).map((provider) =>
      provider.id === 'openai-codex'
        ? {
            ...provider,
            status: 'missing',
            statusMessage:
              'Codex CLI was not found. Install Codex CLI, run "codex login", then refresh.',
            models: []
          }
        : provider
    )
  } else if (name === 'both-unavailable') {
    providers = clonedCatalog(readyProviders).map((provider) => ({
      ...provider,
      status: 'authentication-required',
      statusMessage:
        provider.id === 'claude-code'
          ? 'Claude Code is signed out. Run "claude auth login", then refresh.'
          : 'Codex CLI is signed out. Run "codex login", then refresh.',
      models: []
    }))
  } else {
    return false
  }
  currentScenario = name
  if (webSocketServer) {
    for (const client of webSocketServer.clients) {
      send(client, {
        type: 'ai_capabilities',
        providers,
        refreshing: false
      })
    }
  }
  return true
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

function sendEnvelope(
  socket: WebSocket,
  envelope: AgentServerEnvelope
): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(envelope))
  }
}

function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}:${turnId}`
}

function appendTurnEvent(
  socket: WebSocket,
  turn: FakeDurableTurn,
  payload: TurnEvent
): void {
  if (turn.terminal) return
  const envelope: AgentServerEnvelope = {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    sessionId: turn.sessionId,
    messageId: `fake-event-${turn.events.length + 1}`,
    turnId: turn.turnId,
    sequence: turn.events.length + 1,
    timestamp: new Date().toISOString(),
    payload
  }
  turn.events.push(envelope)
  if (payload.type === 'turn_finished') turn.terminal = true
  turn.subscribers.add(socket)
  for (const subscriber of turn.subscribers) {
    sendEnvelope(subscriber, envelope)
  }
}

function sendCommandResponse(
  socket: WebSocket,
  command: AgentClientEnvelope,
  payload: AgentServerPayload
): void {
  sendEnvelope(socket, {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    sessionId: command.sessionId,
    messageId: `fake-response-${command.sequence}`,
    ...(command.turnId ? { turnId: command.turnId } : {}),
    sequence: command.sequence,
    timestamp: new Date().toISOString(),
    payload
  })
}

function transition<P extends TurnPhase>(
  turn: FakeDurableTurn,
  phase: P,
  status: string
): {
  turnId: string
  phase: P
  revision: WorkspaceRevision
  revisionTransition: 'same-document'
  activeSkillIds: string[]
  provider: string
  elapsedMs: number
  status: string
} {
  return {
    turnId: turn.turnId,
    phase,
    revision: turn.revision,
    revisionTransition: 'same-document' as const,
    activeSkillIds: ['cad-core', 'dxf-core'],
    provider: turn.configuration.provider,
    elapsedMs: 1,
    status
  }
}

function waitForToolResult(socket: WebSocket, callId: string): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for tool_result ${callId}`))
    }, 15_000)

    const onMessage = (raw: Buffer) => {
      let decoded: unknown
      try {
        decoded = JSON.parse(raw.toString())
      } catch {
        return
      }
      const parsed = parseClientMessage(decoded)
      if (!parsed.ok || parsed.value.type !== 'tool_result') return
      if (parsed.value.callId !== callId) return
      toolResultCount += 1
      cleanup()
      resolve(parsed.value.result)
    }

    const onClose = () => {
      cleanup()
      reject(new Error(`Socket closed before tool_result ${callId}`))
    }

    const cleanup = () => {
      clearTimeout(timeout)
      socket.off('message', onMessage)
      socket.off('close', onClose)
    }

    socket.on('message', onMessage)
    socket.on('close', onClose)
  })
}

async function callBrowserTool(
  socket: WebSocket,
  name: CadToolName,
  input: Record<string, unknown>,
  revision: CadSessionRevisionSnapshot
): Promise<ToolResult> {
  const callId = `fake-call-${nextCallId++}`
  send(socket, {
    type: 'tool_call',
    callId,
    name,
    input: {
      ...input,
      [ENVCAD_TURN_REVISION_FIELD]: { ...revision }
    }
  })
  return waitForToolResult(socket, callId)
}

function resultRevision(
  result: ToolResult,
  fallback: CadSessionRevisionSnapshot
): CadSessionRevisionSnapshot {
  const data =
    result.data && typeof result.data === 'object'
      ? (result.data as Record<string, unknown>)
      : undefined
  const revision =
    data?.revision && typeof data.revision === 'object'
      ? (data.revision as Record<string, unknown>)
      : undefined
  return Number.isSafeInteger(revision?.documentRevision) &&
    Number.isSafeInteger(revision?.contentRevision)
    ? {
        documentRevision: revision!.documentRevision as number,
        contentRevision: revision!.contentRevision as number
      }
    : fallback
}

function mutationIdBatches(ids: readonly string[]): string[][] {
  const batches: string[][] = []
  let batch: string[] = []
  for (const id of ids) {
    const candidate = [...batch, id]
    if (
      batch.length > 0 &&
      (candidate.length > MAX_SCRIPTED_MUTATION_ENTITY_COUNT ||
        JSON.stringify(candidate).length >
          MAX_SCRIPTED_MUTATION_ID_CHARACTERS)
    ) {
      batches.push(batch)
      batch = [id]
    } else {
      batch = candidate
    }
    if (JSON.stringify(batch).length > MAX_SCRIPTED_MUTATION_ID_CHARACTERS) {
      throw new Error(`Entity id is too large for a scripted mutation batch: ${id}`)
    }
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

async function runScriptedExchange(
  socket: WebSocket,
  message: Extract<ClientMessage, { type: 'user_message' }>,
  configuration: AgentConfiguration,
  durableTurn?: FakeDurableTurn
): Promise<void> {
  userMessageCount += 1
  lastPromptEvidence = {
    provider: configuration.provider,
    characters: message.text.length,
    utf8Bytes: Buffer.byteLength(message.text, 'utf8'),
    sha256: createHash('sha256').update(message.text, 'utf8').digest('hex'),
    hasBeginSentinel: message.text.includes('BEGIN-LONG-PROMPT-SENTINEL'),
    hasMiddleSentinel: message.text.includes('MIDDLE-LONG-PROMPT-SENTINEL'),
    hasEndSentinel: message.text.includes('END-LONG-PROMPT-SENTINEL')
  }
  const visualRequest = message.text.includes(
    'Inspect the current Sheet Preview.'
  )
  const conversationOnly =
    message.text.toLowerCase().includes('conversation only') ||
    message.text.toLowerCase().startsWith('hello')
  const drawingWideRequest =
    !conversationOnly && !visualRequest && message.selectionSnapshot.count === 0
  const openingText = conversationOnly
    ? 'I can discuss EnvCAD without an open drawing. '
    : visualRequest
      ? 'I will inspect the actual Sheet Preview image. '
      : drawingWideRequest
        ? 'I will inspect the drawing and its layers without requiring a selection. '
        : 'I will move the attached entities by exactly 5 drawing units. '
  if (durableTurn) {
    appendTurnEvent(socket, durableTurn, {
      type: 'assistant_text_delta',
      turnId: durableTurn.turnId,
      text: openingText
    })
  } else {
    send(socket, { type: 'status', state: 'thinking' })
    send(socket, { type: 'assistant_text_delta', text: openingText })
  }
  let toolCalls = 0
  let revision = { ...message.selectionSnapshot.revision }
  let result: ToolResult
  if (conversationOnly) {
    if (completionDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, completionDelayMs))
    }
    result = { data: { conversationOnly: true } }
  } else if (visualRequest) {
    result = await callBrowserTool(
      socket,
      'inspect_sheet_preview',
      { view: visualResultMode === 'success' ? 'full' : 'outside-page' },
      revision
    )
    toolCalls += 1
  } else if (drawingWideRequest) {
    const layers = await callBrowserTool(
      socket,
      'list_layers',
      { cursor: 0, pageSize: 100 },
      revision
    )
    toolCalls += 1
    if (layers.error) {
      result = layers
    } else {
      revision = resultRevision(layers, revision)
      result = await callBrowserTool(
        socket,
        'list_entities',
        { cursor: 0, pageSize: 500, detail: 'summary' },
        revision
      )
      toolCalls += 1
    }
  } else {
    const selectedIds: string[] = []
    let selectedCursor = 0
    let selectionFailure: ToolResult | undefined
    do {
      const selected = await callBrowserTool(
        socket,
        'get_selected_entities',
        { cursor: selectedCursor, pageSize: 500, detail: 'geometry' },
        revision
      )
      toolCalls += 1
      if (selected.error) {
        selectionFailure = selected
        break
      }
      revision = resultRevision(selected, revision)
      const selectedData = selected.data as {
        entities?: Array<{ id?: unknown }>
        hasMore?: unknown
        nextCursor?: unknown
        selectedCount?: unknown
      }
      selectedIds.push(
        ...(selectedData.entities ?? [])
          .map((entity) => entity.id)
          .filter((id): id is string => typeof id === 'string')
      )
      if (selectedData.hasMore !== true) break
      if (
        !Number.isSafeInteger(selectedData.nextCursor) ||
        (selectedData.nextCursor as number) <= selectedCursor
      ) {
        selectionFailure = {
          error:
            'The scripted provider received an invalid frozen-selection continuation cursor.'
        }
        break
      }
      selectedCursor = selectedData.nextCursor as number
    } while (true)

    if (selectionFailure) {
      result = selectionFailure
    } else if (
      selectedIds.length !== message.selectionSnapshot.count ||
      new Set(selectedIds).size !== selectedIds.length
    ) {
      result = {
        error:
          'The scripted provider did not receive the complete frozen selection.'
      }
    } else {
      if (completionDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, completionDelayMs))
      }
      result = { data: { entityIds: [] } }
      for (const batch of mutationIdBatches(selectedIds)) {
        result = await callBrowserTool(
          socket,
          'move_entities',
          { entityIds: batch, dx: 5, dy: 0 },
          revision
        )
        toolCalls += 1
        if (result.error) break
        revision = resultRevision(result, revision)
      }

      if (!result.error) {
        const verifiedIds: string[] = []
        let verificationCursor = 0
        do {
          result = await callBrowserTool(
            socket,
            'list_entities',
            {
              entityIds: selectedIds,
              cursor: verificationCursor,
              pageSize: 500,
              detail: 'geometry'
            },
            revision
          )
          toolCalls += 1
          if (result.error) break
          revision = resultRevision(result, revision)
          const data = result.data as {
            entities?: Array<{ id?: unknown }>
            hasMore?: unknown
            nextCursor?: unknown
          }
          verifiedIds.push(
            ...(data.entities ?? [])
              .map((entity) => entity.id)
              .filter((id): id is string => typeof id === 'string')
          )
          if (data.hasMore !== true) break
          if (
            !Number.isSafeInteger(data.nextCursor) ||
            (data.nextCursor as number) <= verificationCursor
          ) {
            result = {
              error:
                'The scripted provider received an invalid verification continuation cursor.'
            }
            break
          }
          verificationCursor = data.nextCursor as number
        } while (true)
        if (
          !result.error &&
          (verifiedIds.length !== selectedIds.length ||
            new Set(verifiedIds).size !== verifiedIds.length)
        ) {
          result = {
            error:
              'The scripted provider could not verify every edited entity.'
          }
        }
      }
    }
  }
  if (visualRequest) {
    const data =
      result.data && typeof result.data === 'object'
        ? (result.data as Record<string, unknown>)
        : undefined
    lastVisualResultEvidence = {
      provider: configuration.provider,
      model: configuration.model,
      toolName: 'inspect_sheet_preview',
      success: Boolean(result.image) && !result.error,
      ...(result.image
        ? {
            mimeType: result.image.mimeType,
            width: result.image.width,
            height: result.image.height,
            byteLength: result.image.byteLength,
            rasterSha256: result.image.sha256
          }
        : {}),
      ...(typeof data?.svgSha256 === 'string'
        ? { svgSha256: data.svgSha256 }
        : {})
    }
  }
  if (visualRequest && completionDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, completionDelayMs))
  }
  const completionText = result.error
      ? `${
          visualRequest || drawingWideRequest
            ? 'The inspection'
            : 'The move'
        } failed: ${result.error}`
      : conversationOnly
        ? 'The scripted conversation completed without using CAD tools.'
      : visualRequest
        ? 'The scripted visual inspection completed.'
        : drawingWideRequest
          ? 'The scripted drawing-wide inspection completed.'
          : 'The scripted move completed.'
  if (durableTurn) {
    appendTurnEvent(socket, durableTurn, {
      type: 'assistant_text_delta',
      turnId: durableTurn.turnId,
      text: completionText
    })
    const finalRevision: WorkspaceRevision = {
      ...durableTurn.revision,
      documentRevision: revision.documentRevision,
      contentRevision: revision.contentRevision
    }
    durableTurn.revision = finalRevision
    const data =
      result.data && typeof result.data === 'object'
        ? (result.data as Record<string, unknown>)
        : undefined
    const evidenceId =
      typeof data?.evidenceId === 'string'
        ? data.evidenceId
        : data?.evidence &&
            typeof data.evidence === 'object' &&
            typeof (data.evidence as Record<string, unknown>).evidenceId ===
              'string'
          ? ((data.evidence as Record<string, unknown>).evidenceId as string)
        : typeof data?.captureId === 'string'
          ? data.captureId
          : undefined
    appendTurnEvent(socket, durableTurn, {
      type: 'turn_finished',
      ...transition(durableTurn, 'completed', 'Completed safely.'),
      outcome: 'completed',
      finalRevision,
      verification: {
        mode: conversationOnly
          ? 'not-applicable'
          : visualRequest && evidenceId
            ? 'database-and-visual'
            : 'database-only',
        databaseChecks: conversationOnly
          ? []
          : [`Completed ${toolCalls} bounded browser tool calls.`],
        visualEvidenceIds: evidenceId ? [evidenceId] : [],
        warnings:
          visualRequest && !evidenceId
            ? ['Visual evidence was unavailable; no visual QA claim was made.']
            : [],
        revision: finalRevision
      },
      metrics: { totalMs: 1, toolCalls }
    })
  } else {
    send(socket, { type: 'assistant_text_delta', text: completionText })
    send(socket, {
      type: 'assistant_done',
      provider: configuration.provider,
      model: configuration.model,
      ...(configuration.effort ? { effort: configuration.effort } : {}),
      metrics: { totalMs: 1, toolCalls }
    })
    send(socket, { type: 'status', state: 'idle' })
  }
}

function committedInputText(inputId: string): string | undefined {
  const upload = inputUploads.get(inputId)
  if (!upload?.reference) return undefined
  return Buffer.concat(upload.chunks).toString('utf8')
}

async function handleInputCommand(
  socket: WebSocket,
  envelope: AgentClientEnvelope,
  command: InputIngestionCommand
): Promise<void> {
  if (command.type === 'input_begin') {
    const existing = inputUploads.get(command.inputId)
    if (existing?.reference) {
      sendCommandResponse(socket, envelope, {
        type: 'input_committed',
        reference: existing.reference
      })
      return
    }
    const upload = existing ?? {
      mediaType: command.mediaType,
      ...(command.sourceName ? { sourceName: command.sourceName } : {}),
      ...(command.declaredByteLength !== undefined
        ? { declaredByteLength: command.declaredByteLength }
        : {}),
      chunks: []
    }
    inputUploads.set(command.inputId, upload)
    sendCommandResponse(socket, envelope, {
      type: 'input_progress',
      inputId: command.inputId,
      receivedBytes: upload.chunks.reduce(
        (total, chunkBytes) => total + chunkBytes.byteLength,
        0
      ),
      receivedChunks: upload.chunks.length,
      status: 'receiving'
    })
    return
  }
  if (command.type === 'input_abort') {
    inputUploads.delete(command.inputId)
    sendCommandResponse(socket, envelope, {
      type: 'input_aborted',
      inputId: command.inputId
    })
    return
  }
  const upload = inputUploads.get(command.inputId)
  if (!upload) {
    sendCommandResponse(socket, envelope, {
      type: 'protocol_error',
      code: 'INPUT_NOT_FOUND',
      message: 'The fake local input upload does not exist.',
      inputId: command.inputId
    })
    return
  }
  if (command.type === 'input_chunk') {
    const bytes = Buffer.from(command.bytesBase64, 'base64')
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== command.sha256 || command.chunkIndex > upload.chunks.length) {
      sendCommandResponse(socket, envelope, {
        type: 'protocol_error',
        code: 'INPUT_CHUNK_REJECTED',
        message: 'The fake local input chunk failed integrity or ordering.',
        inputId: command.inputId
      })
      return
    }
    const existing = upload.chunks[command.chunkIndex]
    if (existing && !existing.equals(bytes)) {
      sendCommandResponse(socket, envelope, {
        type: 'protocol_error',
        code: 'INPUT_CHUNK_CONFLICT',
        message: 'A resumed fake input chunk does not match its stored bytes.',
        inputId: command.inputId
      })
      return
    }
    if (!existing) upload.chunks.push(bytes)
    sendCommandResponse(socket, envelope, {
      type: 'input_progress',
      inputId: command.inputId,
      receivedBytes: upload.chunks.reduce(
        (total, chunkBytes) => total + chunkBytes.byteLength,
        0
      ),
      receivedChunks: upload.chunks.length,
      status: 'receiving'
    })
    return
  }
  const bytes = Buffer.concat(upload.chunks)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (
    digest !== command.sha256 ||
    (upload.declaredByteLength !== undefined &&
      upload.declaredByteLength !== bytes.byteLength)
  ) {
    sendCommandResponse(socket, envelope, {
      type: 'protocol_error',
      code: 'INPUT_COMMIT_REJECTED',
      message: 'The fake local input failed complete integrity validation.',
      inputId: command.inputId
    })
    return
  }
  upload.reference = {
    inputId: command.inputId,
    sha256: digest,
    mediaType: upload.mediaType,
    byteLength: bytes.byteLength,
    characterLength: Array.from(bytes.toString('utf8')).length,
    chunkCount: upload.chunks.length,
    ...(upload.sourceName ? { sourceName: upload.sourceName } : {})
  }
  sendCommandResponse(socket, envelope, {
    type: 'input_committed',
    reference: upload.reference
  })
}

async function handleSubmitTurn(
  socket: WebSocket,
  envelope: AgentClientEnvelope,
  command: SubmitTurnCommand,
  configuration: AgentConfiguration
): Promise<void> {
  const turnId = envelope.turnId!
  const key = turnKey(envelope.sessionId, turnId)
  const existing = durableTurns.get(key)
  if (existing) {
    existing.subscribers.add(socket)
    for (const event of existing.events) sendEnvelope(socket, event)
    return
  }
  const text = command.text ?? committedInputText(command.instructionInputId!)
  if (!text) {
    sendCommandResponse(socket, envelope, {
      type: 'protocol_error',
      code: 'INPUT_REFERENCE_MISSING',
      message: 'The fake sidecar cannot resolve the local instruction reference.'
    })
    return
  }
  const turn: FakeDurableTurn = {
    sessionId: envelope.sessionId,
    turnId,
    messageId: envelope.messageId,
    revision: { ...command.selectionSnapshot.revision },
    configuration: { ...configuration },
    events: [],
    subscribers: new Set([socket]),
    terminal: false,
    cancelled: false
  }
  durableTurns.set(key, turn)
  appendTurnEvent(socket, turn, {
    type: 'turn_accepted',
    ...transition(turn, 'accepted', 'Accepted and journaled.'),
    messageId: envelope.messageId
  })
  for (const [skillId, name] of [
    ['cad-core', 'CAD Core'],
    ['dxf-core', 'DXF Core']
  ] as const) {
    appendTurnEvent(socket, turn, {
      type: 'skill_activated',
      turnId,
      skill: {
        skillId,
        name,
        version: 'e2e-pinned',
        integrity: 'verified',
        activatedAt: new Date().toISOString()
      }
    })
  }
  appendTurnEvent(socket, turn, {
    type: 'instruction_breakdown',
    turnId,
    breakdown: {
      objective: text.slice(0, 500),
      inputs: command.referenceInputIds.length
        ? [`${command.referenceInputIds.length} local references`]
        : ['Inline user instruction'],
      constraints: ['Use only EnvCAD-brokered tools.'],
      requiredDrawingContext:
        command.selectionSnapshot.count > 0
          ? ['Frozen selection']
          : ['Current drawing context when needed'],
      plannedToolCategories: ['read', 'mutate', 'verify'],
      expectedOutput: 'A verified assistant response.',
      riskLevel: command.selectionSnapshot.count > 0 ? 'medium' : 'low'
    }
  })
  appendTurnEvent(socket, turn, {
    type: 'turn_progress',
    ...transition(turn, 'planning', 'Planning with verified skills.')
  })
  await runScriptedExchange(
    socket,
    {
      type: 'user_message',
      text,
      configurationRevision: command.configurationRevision,
      selectionSnapshot: {
        count: command.selectionSnapshot.count,
        units: command.selectionSnapshot.units,
        revision: {
          documentRevision: command.selectionSnapshot.revision.documentRevision,
          contentRevision: command.selectionSnapshot.revision.contentRevision
        }
      },
      sheet: command.sheet
    },
    configuration,
    turn
  )
}

function cancelDurableTurn(
  socket: WebSocket,
  envelope: AgentClientEnvelope,
  turnId: string
): void {
  const turn = durableTurns.get(turnKey(envelope.sessionId, turnId))
  if (!turn || turn.terminal) return
  turn.cancelled = true
  appendTurnEvent(socket, turn, {
    type: 'turn_finished',
    ...transition(turn, 'cancelled', 'Cancelled by the user.'),
    outcome: 'cancelled',
    finalRevision: turn.revision,
    verification: {
      mode: 'database-only',
      databaseChecks: ['Committed operation receipts remain authoritative.'],
      visualEvidenceIds: [],
      warnings: [],
      revision: turn.revision
    },
    metrics: { totalMs: 1, toolCalls: 0 }
  })
}

function handleSocket(socket: WebSocket): void {
  let busy = false
  let configuration: AgentConfiguration = {
    provider: 'claude-code',
    model: 'fake-claude'
  }
  send(socket, {
    type: 'ai_capabilities',
    providers,
    refreshing: false
  })
  socket.on('message', (raw) => {
    let decoded: unknown
    try {
      decoded = JSON.parse(raw.toString())
    } catch {
      send(socket, { type: 'error', message: 'Malformed browser JSON' })
      return
    }
    const durable = parseAgentClientEnvelope(decoded)
    if (durable.ok) {
      const envelope = durable.value
      const command = envelope.payload
      if (
        command.type === 'input_begin' ||
        command.type === 'input_chunk' ||
        command.type === 'input_commit' ||
        command.type === 'input_abort'
      ) {
        void handleInputCommand(socket, envelope, command)
        return
      }
      if (command.type === 'resume_turn') {
        const turn = durableTurns.get(
          turnKey(envelope.sessionId, command.turnId)
        )
        if (turn) {
          turn.subscribers.add(socket)
          for (const event of turn.events) {
            if (event.sequence > command.lastSequence) {
              sendEnvelope(socket, event)
            }
          }
        } else {
          sendCommandResponse(socket, envelope, {
            type: 'protocol_error',
            code: 'TURN_NOT_FOUND',
            message: 'The fake durable turn journal has no matching turn.'
          })
        }
        return
      }
      if (command.type === 'cancel_turn') {
        cancelDurableTurn(socket, envelope, command.turnId)
        return
      }
      if (command.type === 'submit_turn') {
        const existing = durableTurns.get(
          turnKey(envelope.sessionId, envelope.turnId!)
        )
        if (busy && !existing) {
          sendCommandResponse(socket, envelope, {
            type: 'protocol_error',
            code: 'TURN_BUSY',
            message: 'A scripted durable turn is already running.'
          })
          return
        }
        busy = true
        void handleSubmitTurn(socket, envelope, command, configuration)
          .catch((error) => {
            const turn = durableTurns.get(
              turnKey(envelope.sessionId, envelope.turnId!)
            )
            if (turn && !turn.terminal) {
              appendTurnEvent(socket, turn, {
                type: 'turn_finished',
                ...transition(
                  turn,
                  'failed',
                  'The scripted turn failed safely.'
                ),
                outcome: 'failed',
                finalRevision: turn.revision,
                error: {
                  kind: 'transient-provider',
                  code: 'FAKE_SCRIPT_FAILURE',
                  userMessage:
                    'The scripted provider stopped. Retry after the fake sidecar is ready.',
                  developerMessage:
                    error instanceof Error ? error.message : String(error),
                  retryable: true,
                  recoveryActions: [
                    {
                      id: 'retry-fake-turn',
                      kind: 'retry',
                      label: 'Retry turn',
                      enabled: true
                    },
                    {
                      id: 'export-fake-diagnostics',
                      kind: 'export-diagnostics',
                      label: 'Export diagnostics',
                      enabled: true
                    }
                  ]
                },
                verification: {
                  mode: 'database-only',
                  databaseChecks: [
                    'The fake turn journal preserved its terminal outcome.'
                  ],
                  visualEvidenceIds: [],
                  warnings: [],
                  revision: turn.revision
                },
                metrics: { totalMs: 1, toolCalls: 0 }
              })
            }
          })
          .finally(() => {
            busy = false
          })
        return
      }
      if (command.type === 'refresh_ai_capabilities') {
        sendCommandResponse(socket, envelope, {
          type: 'ai_capabilities',
          providers,
          refreshing: false
        })
        return
      }
      return
    }
    const parsed = parseClientMessage(decoded)
    if (!parsed.ok) {
      send(socket, { type: 'error', message: parsed.error })
      return
    }

    if (parsed.value.type === 'set_ai_configuration') {
      const newConversation =
        configuration.provider !== parsed.value.configuration.provider ||
        configuration.model !== parsed.value.configuration.model ||
        configuration.effort !== parsed.value.configuration.effort
      configuration = { ...parsed.value.configuration }
      send(socket, {
        type: 'ai_configuration_applied',
        revision: parsed.value.revision,
        configuration,
        newConversation
      })
    } else if (parsed.value.type === 'refresh_ai_capabilities') {
      send(socket, {
        type: 'ai_capabilities',
        providers,
        refreshing: false
      })
    } else if (parsed.value.type === 'user_message') {
      if (busy) {
        send(socket, { type: 'error', message: 'A scripted turn is already running' })
        return
      }
      busy = true
      void runScriptedExchange(socket, parsed.value, configuration)
        .catch((error) => {
          send(socket, {
            type: 'error',
            message: error instanceof Error ? error.message : String(error)
          })
          send(socket, { type: 'status', state: 'idle' })
        })
        .finally(() => {
          busy = false
        })
    } else if (parsed.value.type === 'interrupt') {
      send(socket, { type: 'status', state: 'idle' })
    } else if (parsed.value.type === 'reset') {
      send(socket, {
        type: 'ai_configuration_applied',
        revision: parsed.value.revision,
        configuration,
        newConversation: true
      })
    }
  })
}

async function startWebSocketServer(): Promise<void> {
  if (webSocketServer) return
  await new Promise<void>((resolve, reject) => {
    const server = new WebSocketServer({ host: HOST, port: WS_PORT })
    server.once('listening', () => {
      webSocketServer = server
      console.log(`[fake-sidecar] WebSocket listening on ws://${HOST}:${WS_PORT}`)
      resolve()
    })
    server.once('error', reject)
    server.on('connection', handleSocket)
  })
}

async function stopWebSocketServer(): Promise<void> {
  const server = webSocketServer
  if (!server) return
  webSocketServer = undefined
  for (const client of server.clients) client.close(1001, 'Fake sidecar paused by E2E test')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  console.log('[fake-sidecar] WebSocket listener stopped')
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function handleControl(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const requestUrl = new URL(request.url ?? '/', `http://${HOST}:${CONTROL_PORT}`)
  if (request.method === 'GET' && requestUrl.pathname === '/health') {
    json(response, 200, { ok: true, wsRunning: Boolean(webSocketServer) })
    return
  }
  if (request.method === 'GET' && requestUrl.pathname === '/stats') {
    json(response, 200, {
      wsRunning: Boolean(webSocketServer),
      userMessageCount,
      toolResultCount,
      scenario: currentScenario,
      completionDelayMs,
      visualResultMode,
      lastPromptEvidence,
      lastVisualResultEvidence
    })
    return
  }
  if (request.method === 'POST' && requestUrl.pathname === '/start') {
    await startWebSocketServer()
    json(response, 200, { wsRunning: true })
    return
  }
  if (request.method === 'POST' && requestUrl.pathname === '/stop') {
    await stopWebSocketServer()
    json(response, 200, { wsRunning: false })
    return
  }
  if (request.method === 'POST' && requestUrl.pathname === '/reset-stats') {
    userMessageCount = 0
    toolResultCount = 0
    lastPromptEvidence = undefined
    lastVisualResultEvidence = undefined
    inputUploads.clear()
    durableTurns.clear()
    nextCallId = 1
    json(response, 200, { ok: true })
    return
  }
  if (request.method === 'POST' && requestUrl.pathname === '/scenario') {
    const name = requestUrl.searchParams.get('name') ?? ''
    if (!setScenario(name)) {
      json(response, 400, { error: `Unknown scenario ${name}` })
      return
    }
    json(response, 200, { ok: true, name })
    return
  }
  if (request.method === 'POST' && requestUrl.pathname === '/delay') {
    const value = Number(requestUrl.searchParams.get('ms'))
    if (!Number.isSafeInteger(value) || value < 0 || value > 5_000) {
      json(response, 400, { error: 'Delay must be an integer from 0 to 5000 ms' })
      return
    }
    completionDelayMs = value
    json(response, 200, { ok: true, completionDelayMs })
    return
  }
  if (request.method === 'POST' && requestUrl.pathname === '/visual-result') {
    const mode = requestUrl.searchParams.get('mode')
    if (mode !== 'success' && mode !== 'failure') {
      json(response, 400, { error: 'Visual result mode must be success or failure' })
      return
    }
    visualResultMode = mode
    json(response, 200, { ok: true, visualResultMode })
    return
  }
  json(response, 404, { error: 'Not found' })
}

const controlServer = createServer((request, response) => {
  void handleControl(request, response).catch((error) => {
    json(response, 500, { error: error instanceof Error ? error.message : String(error) })
  })
})

async function shutdown(): Promise<void> {
  await stopWebSocketServer()
  await new Promise<void>((resolve) => controlServer.close(() => resolve()))
}

process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)))
process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)))

await startWebSocketServer()
controlServer.listen(CONTROL_PORT, HOST, () => {
  console.log(`[fake-sidecar] Control API listening on http://${HOST}:${CONTROL_PORT}`)
})
