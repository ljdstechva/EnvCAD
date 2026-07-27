import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import {
  query,
  type Query,
  type SDKRateLimitInfo,
  type SDKResultError,
  type SDKSystemMessage
} from '@anthropic-ai/claude-agent-sdk'
import { SYSTEM_PROMPT } from './systemPrompt'
import { createCadMcpServer } from './cadTools'
import type {
  ClientMessage,
  SelectionSnapshot,
  ServerMessage,
  SheetSnapshot,
  ToolResult
} from '../../src/agent/protocol'
import { parseClientMessage } from '../../src/agent/protocol'

const TOOL_TIMEOUT_MS = 30_000

interface PendingCall {
  name: string
  resolve: (result: ToolResult) => void
  timer: ReturnType<typeof setTimeout>
}

export interface BridgeSessionOptions {
  claudeExecutablePath: string
  queryFactory?: typeof query
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

function formatResultError(result: SDKResultError): string {
  const details = result.errors.map((error) => error.trim()).filter(Boolean)
  const detail = details.length > 0 ? `: ${details.join('; ')}` : ''
  return `Claude agent error (${result.subtype})${detail}`
}

function formatRateLimitError(info: SDKRateLimitInfo): string {
  const limitType = info.rateLimitType ?? 'subscription'
  if (!info.resetsAt) return `Claude ${limitType} usage limit reached`

  const resetMilliseconds = info.resetsAt < 1_000_000_000_000 ? info.resetsAt * 1000 : info.resetsAt
  const resetDate = new Date(resetMilliseconds)
  const resetDetail = Number.isNaN(resetDate.getTime())
    ? ''
    : `; resets at ${resetDate.toISOString()}`
  return `Claude ${limitType} usage limit reached${resetDetail}`
}

function assertSubscriptionAuthentication(message: SDKSystemMessage): 'oauth' | 'none' {
  // Claude Code 2.1.220 reports the subscription path as "none" when no API
  // key source exists, although the Agent SDK declaration currently omits
  // that runtime value from ApiKeySource.
  const source = message.apiKeySource as string
  if (source !== 'oauth' && source !== 'none') {
    throw new Error(
      `Claude authentication source must be the Claude Code subscription login, but the Agent SDK reported "${source}". ` +
        'EnvCAD requires the existing Claude Code subscription login and does not permit API-key authentication.'
    )
  }
  return source
}

/**
 * One BridgeSession per WebSocket connection. Owns a single Claude Agent SDK
 * conversation (by session id) and forwards its CAD tool calls to the
 * browser over the WebSocket, awaiting each tool_result. See
 * docs/agent-protocol.md for the full wire protocol this class implements.
 */
export class BridgeSession {
  private sessionId: string | undefined
  private currentQuery: Query | undefined
  private pendingCalls = new Map<string, PendingCall>()
  private lastSelectionSnapshot: SelectionSnapshot | undefined
  private lastSheet: SheetSnapshot | undefined
  private resetGeneration = 0
  private turnRunning = false
  private closed = false
  private readonly queryFactory: typeof query
  private readonly toolTimeoutMs: number
  private readonly logger: Pick<Console, 'log' | 'error'>
  private readonly mcpServer: ReturnType<typeof createCadMcpServer>
  private readonly claudeExecutablePath: string

  constructor(
    private ws: WebSocket,
    options: BridgeSessionOptions
  ) {
    this.claudeExecutablePath = options.claudeExecutablePath
    this.queryFactory = options.queryFactory ?? query
    this.toolTimeoutMs = options.toolTimeoutMs ?? TOOL_TIMEOUT_MS
    this.logger = options.logger ?? console
    this.mcpServer = createCadMcpServer({
      callTool: (name, input) => this.callTool(name, input),
      getSelectionSnapshot: () => this.lastSelectionSnapshot
    })
    ws.on('message', (raw) => this.handleRawMessage(raw))
    ws.on('close', () => this.cleanup('Browser connection closed'))
    ws.on('error', (error) => {
      this.logger.error('[sidecar] browser WebSocket error:', error)
    })
  }

  private cleanup(reason: string) {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pendingCalls.values()) {
      clearTimeout(pending.timer)
      pending.resolve({ error: `${reason} while waiting for ${pending.name}` })
    }
    this.pendingCalls.clear()
    this.currentQuery?.close()
  }

  close(reason = 'Sidecar session closed') {
    this.cleanup(reason)
  }

  private send(message: ServerMessage): boolean {
    if (!this.closed && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(message))
        return true
      } catch (error) {
        this.logger.error(`[sidecar] failed to send ${message.type}:`, error)
      }
    } else {
      this.logger.error(`[sidecar] cannot send ${message.type}: browser WebSocket is not open`)
    }
    return false
  }

  private reportProtocolError(message: string) {
    this.logger.error(`[sidecar] rejected browser message: ${message}`)
    this.send({ type: 'error', message: `Invalid browser message: ${message}` })
  }

  private reportAgentError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    this.logger.error(`[sidecar] agent error: ${message}`)
    this.send({ type: 'error', message })
  }

  private handleRawMessage(raw: unknown) {
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

  private handleMessage(message: ClientMessage) {
    switch (message.type) {
      case 'user_message':
        if (this.turnRunning) {
          this.send({
            type: 'error',
            message: 'An agent turn is already in progress; wait for status "idle" before sending again.'
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
        this.interruptCurrent('interrupt')
        break
      case 'reset':
        this.resetGeneration += 1
        this.sessionId = undefined
        this.interruptCurrent('reset')
        break
    }
  }

  private interruptCurrent(action: 'interrupt' | 'reset') {
    const currentQuery = this.currentQuery
    if (!currentQuery) return
    void currentQuery.interrupt().catch((error) => {
      this.reportAgentError(
        new Error(
          `Failed to ${action} the current Claude agent turn: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      )
    })
  }

  /** Forwards a CAD tool call to the browser and awaits its tool_result (or timeout). */
  callTool(name: string, input: unknown): Promise<ToolResult> {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ error: `Browser connection is not open; cannot run ${name}` })
    }

    return new Promise((resolve) => {
      const callId = randomUUID()
      const timer = setTimeout(() => {
        this.pendingCalls.delete(callId)
        resolve({
          error: `Timed out waiting for the browser to respond to ${name} after ${this.toolTimeoutMs / 1000}s`
        })
      }, this.toolTimeoutMs)
      this.pendingCalls.set(callId, { name, resolve, timer })

      if (!this.send({ type: 'tool_call', callId, name, input })) {
        clearTimeout(timer)
        this.pendingCalls.delete(callId)
        resolve({ error: `Failed to send ${name} to the browser` })
      }
    })
  }

  private resolveToolResult(callId: string, result: ToolResult) {
    const pending = this.pendingCalls.get(callId)
    if (!pending) {
      this.reportProtocolError(`tool_result references unknown callId "${callId}"`)
      return
    }
    clearTimeout(pending.timer)
    this.pendingCalls.delete(callId)
    pending.resolve(result)
  }

  private async runTurn(text: string) {
    const generation = this.resetGeneration
    this.turnRunning = true
    this.send({ type: 'status', state: 'thinking' })

    let activeQuery: Query | undefined
    let rateLimitError: string | undefined
    try {
      const prompt = buildTurnPrompt(text, this.lastSelectionSnapshot, this.lastSheet)
      activeQuery = this.queryFactory({
        prompt,
        options: {
          model: 'sonnet',
          systemPrompt: SYSTEM_PROMPT,
          mcpServers: { cad: this.mcpServer },
          allowedTools: ['mcp__cad__*'],
          // Removes every built-in tool (Bash/Read/Write/Edit/Glob/Grep/WebSearch/
          // WebFetch) from Claude's context; only the CAD MCP tools remain.
          tools: [],
          permissionMode: 'dontAsk',
          pathToClaudeCodeExecutable: this.claudeExecutablePath,
          ...(this.sessionId ? { resume: this.sessionId } : {})
        }
      })
      this.currentQuery = activeQuery

      for await (const message of activeQuery) {
        if (message.type === 'system' && message.subtype === 'init') {
          const authSource = assertSubscriptionAuthentication(message)
          this.logger.log(
            authSource === 'oauth'
              ? '[sidecar] Claude authentication source: oauth (Claude Code login)'
              : '[sidecar] Claude authentication source: none (Claude Code login; no API key)'
          )
          if (message.session_id && generation === this.resetGeneration) {
            this.sessionId = message.session_id
          }
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
              this.send({ type: 'assistant_text_delta', text: block.text })
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
          if (message.session_id && generation === this.resetGeneration) {
            this.sessionId = message.session_id
          }
          if (message.subtype !== 'success') {
            const resultError = formatResultError(message)
            throw new Error(rateLimitError ? `${rateLimitError}; ${resultError}` : resultError)
          }
        }
      }
      if (rateLimitError) throw new Error(rateLimitError)
    } catch (error) {
      activeQuery?.close()
      this.reportAgentError(error)
    } finally {
      this.send({ type: 'assistant_done' })
      this.send({ type: 'status', state: 'idle' })
      if (this.currentQuery === activeQuery) this.currentQuery = undefined
      this.turnRunning = false
    }
  }
}
