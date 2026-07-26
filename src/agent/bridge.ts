import { reactive } from 'vue'
import {
  parseClientMessage,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
  type SelectionSnapshot,
  type SheetSnapshot,
  type ToolResult
} from './protocol'

export type ConnectionState = 'connecting' | 'online' | 'offline'
export type AgentStatus = 'idle' | 'thinking'

export interface AgentChatMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface PendingToolCall {
  callId: string
  name: string
  input: unknown
}

interface AgentBridgeState {
  connectionState: ConnectionState
  status: AgentStatus
  messages: AgentChatMessage[]
  /** Text accumulated for the assistant turn currently streaming in, if any. */
  streamingText: string
  pendingToolCalls: PendingToolCall[]
}

export type ToolHandler = (input: unknown) => Promise<ToolResult> | ToolResult
export type AgentBridgeEvent =
  | ServerMessage
  | { type: 'tool_result'; callId: string; name: string; result: ToolResult }
export type AgentBridgeListener = (message: AgentBridgeEvent) => void

const WS_URL = 'ws://127.0.0.1:8787'
const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 5000

/**
 * Browser-side half of the sidecar bridge described in
 * docs/agent-protocol.md. Owns the WebSocket connection (with
 * auto-reconnect), a reactive store the UI can bind to, and dispatches
 * incoming tool_call messages to a registry of handlers.
 */
export class AgentBridge {
  readonly state: AgentBridgeState = reactive({
    connectionState: 'connecting',
    status: 'idle',
    messages: [],
    streamingText: '',
    pendingToolCalls: []
  })

  private ws: WebSocket | undefined
  private reconnectDelayMs = RECONNECT_MIN_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private handlers = new Map<string, ToolHandler>()
  private listeners = new Set<AgentBridgeListener>()
  private stopped = true
  /**
   * Serializes tool execution. Claude can emit several tool calls in one
   * assistant turn, and every database-mutating handler wraps its work in a
   * single undo transaction — running two of them concurrently would let
   * their edits land in one another's undo group, so one agent tool call
   * would no longer be exactly one undo step.
   */
  private toolQueue: Promise<void> = Promise.resolve()

  registerHandler(name: string, handler: ToolHandler) {
    this.handlers.set(name, handler)
  }

  subscribe(listener: AgentBridgeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  connect() {
    if (!this.stopped && this.ws?.readyState !== WebSocket.CLOSED) return
    this.stopped = false
    this.openSocket()
  }

  disconnect() {
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.ws?.close()
    this.state.connectionState = 'offline'
  }

  sendUserMessage(text: string, selectionSnapshot: SelectionSnapshot, sheet: SheetSnapshot) {
    const message: ClientMessage = { type: 'user_message', text, selectionSnapshot, sheet }
    if (!this.send(message)) {
      throw new Error('Agent sidecar is offline; the message was not sent.')
    }
    this.state.messages.push({ role: 'user', text })
  }

  interrupt() {
    if (!this.send({ type: 'interrupt' })) {
      console.error('[agent-bridge] cannot interrupt: sidecar is offline')
    }
  }

  reset() {
    if (!this.send({ type: 'reset' })) {
      console.error('[agent-bridge] cannot reset: sidecar is offline')
      return
    }
    this.state.messages = []
    this.state.streamingText = ''
  }

  private openSocket() {
    this.state.connectionState = 'connecting'
    let ws: WebSocket
    try {
      ws = new WebSocket(WS_URL)
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
      this.reconnectDelayMs = RECONNECT_MIN_MS
    })
    ws.addEventListener('message', (event) => {
      void this.handleServerMessage(String(event.data))
    })
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return
      this.ws = undefined
      this.state.connectionState = 'offline'
      if (!this.stopped) this.scheduleReconnect()
    })
    ws.addEventListener('error', (event) => {
      console.error('[agent-bridge] WebSocket connection error:', event)
      ws.close()
    })
  }

  private scheduleReconnect() {
    clearTimeout(this.reconnectTimer)
    const delay = this.reconnectDelayMs
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS)
    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped) this.openSocket()
    }, delay)
  }

  private send(message: ClientMessage): boolean {
    const parsed = parseClientMessage(message)
    if (!parsed.ok) {
      this.reportBridgeError(`Refusing to send invalid browser message: ${parsed.error}`)
      return false
    }
    if (import.meta.env.DEV) console.debug('[agent-bridge] ->', message)
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(message))
        return true
      } catch (error) {
        this.reportBridgeError(
          `Failed to send ${message.type}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    return false
  }

  private async handleServerMessage(raw: string) {
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
        if (this.state.streamingText) {
          this.state.messages.push({ role: 'assistant', text: this.state.streamingText })
        }
        this.state.streamingText = ''
        break
      case 'status':
        this.state.status = message.state
        break
      case 'error':
        console.error(`[agent-bridge] sidecar error: ${message.message}`)
        this.state.messages.push({ role: 'assistant', text: `[error] ${message.message}` })
        break
      case 'tool_call':
        this.emit(message)
        this.enqueueToolCall(message.callId, message.name, message.input)
        return
    }
    this.emit(message)
  }

  private enqueueToolCall(callId: string, name: string, input: unknown) {
    this.state.pendingToolCalls.push({ callId, name, input })
    this.toolQueue = this.toolQueue.then(() =>
      this.handleToolCall(callId, name, input).catch((error) => {
        this.reportBridgeError(
          `Tool dispatch for ${name} failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      })
    )
  }

  private async handleToolCall(callId: string, name: string, input: unknown) {
    const handler = this.handlers.get(name)
    let result: ToolResult
    try {
      result = handler ? await handler(input) : { error: `No browser handler registered for ${name}` }
    } catch (err) {
      result = { error: err instanceof Error ? err.message : String(err) }
    }
    this.state.pendingToolCalls = this.state.pendingToolCalls.filter((call) => call.callId !== callId)
    if (!this.send({ type: 'tool_result', callId, result })) {
      this.reportBridgeError(`Failed to return the result for ${name}; sidecar is offline`)
    }
    this.emit({ type: 'tool_result', callId, name, result })
  }

  private emit(message: AgentBridgeEvent) {
    for (const listener of this.listeners) {
      try {
        listener(message)
      } catch (error) {
        console.error('[agent-bridge] listener failed:', error)
      }
    }
  }

  private reportBridgeError(message: string) {
    console.error(`[agent-bridge] ${message}`)
    this.state.messages.push({ role: 'assistant', text: `[error] ${message}` })
  }
}

export const agentBridge = new AgentBridge()
