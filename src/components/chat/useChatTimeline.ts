import { ref, toRaw } from 'vue'
import { agentBridge } from '../../agent/bridge'
import { captureSelectionSnapshot, captureSheetSnapshot } from '../../agent/context'
import type {
  ProviderId,
  ToolResult,
  TurnMetrics
} from '../../agent/protocol'
import type {
  InputReference,
  InstructionBreakdown,
  OperationReceipt,
  SkillActivation,
  TurnFinished
} from '../../../shared/agent-contracts'

export interface ChatUserEntry {
  id: number
  kind: 'user'
  text: string
  /** Selection count frozen at send time. */
  attachedCount?: number
}

export interface ChatAssistantEntry {
  id: number
  kind: 'assistant'
  text: string
  /** True while this entry is still receiving text deltas. */
  streaming?: boolean
  provider?: ProviderId
  model?: string
  resolvedModel?: string
  effort?: string
  metrics?: TurnMetrics
}

export type ChatTextEntry = ChatUserEntry | ChatAssistantEntry

export interface ChatToolEntry {
  id: number
  kind: 'tool'
  callId: string
  name: string
  input: unknown
  result?: ToolResult
}

export interface ChatErrorEntry {
  id: number
  kind: 'error'
  message: string
}

export interface ChatBoundaryEntry {
  id: number
  kind: 'boundary'
  label: string
}

export interface ChatActivityEntry {
  id: number
  kind: 'activity'
  turnId: string
  activity:
    | 'progress'
    | 'breakdown'
    | 'skills'
    | 'receipt'
    | 'terminal'
  phase?: string
  status?: string
  breakdown?: InstructionBreakdown
  skills?: SkillActivation[]
  receipt?: OperationReceipt
  terminal?: TurnFinished
}

export type ChatEntry =
  | ChatTextEntry
  | ChatToolEntry
  | ChatErrorEntry
  | ChatBoundaryEntry
  | ChatActivityEntry

/**
 * Vue exposes nested values from a reactive object as proxies. Browser
 * structuredClone deliberately rejects proxies, so cross the UI boundary
 * through Vue's raw object before making a detached timeline copy.
 */
function cloneReactiveContract<T>(value: T): T {
  return structuredClone(toRaw(value))
}

/**
 * Builds a UI-friendly timeline (text turns interleaved with tool-call
 * chips) from raw agent-bridge events, since AgentBridge's own state only
 * keeps a flat message list and drops resolved tool calls.
 */
export function useChatTimeline() {
  const entries = ref<ChatEntry[]>([])
  let idCounter = 0
  const nextId = () => ++idCounter

  let streamingEntry: ChatAssistantEntry | null = null
  let pendingResetRevision: number | undefined

  function findActivity(
    turnId: string,
    activity: ChatActivityEntry['activity'],
    predicate?: (entry: ChatActivityEntry) => boolean
  ): ChatActivityEntry | undefined {
    for (let i = entries.value.length - 1; i >= 0; i--) {
      const entry = entries.value[i]
      if (
        entry.kind === 'activity' &&
        entry.turnId === turnId &&
        entry.activity === activity &&
        (!predicate || predicate(entry))
      ) {
        return entry
      }
    }
    return undefined
  }

  function hydrateDurableState() {
    const state = agentBridge.state
    for (const message of state.messages ?? []) {
      entries.value.push(
        message.role === 'user'
          ? {
              id: nextId(),
              kind: 'user',
              text: message.text
            }
          : {
              id: nextId(),
              kind: 'assistant',
              text: message.text,
              provider: message.provider,
              model: message.model,
              resolvedModel: message.resolvedModel,
              effort: message.effort,
              metrics: message.metrics
            }
      )
    }
    const turnId = state.activeTurnId
    if (!turnId) return
    if (state.instructionBreakdown) {
      entries.value.push({
        id: nextId(),
        kind: 'activity',
        turnId,
        activity: 'breakdown',
        breakdown: cloneReactiveContract(state.instructionBreakdown)
      })
    }
    if (state.activeSkills?.length) {
      entries.value.push({
        id: nextId(),
        kind: 'activity',
        turnId,
        activity: 'skills',
        skills: cloneReactiveContract(state.activeSkills)
      })
    }
    if (state.turnPhase || state.turnStatus) {
      entries.value.push({
        id: nextId(),
        kind: 'activity',
        turnId,
        activity: 'progress',
        phase: state.turnPhase,
        status: state.turnStatus
      })
    }
    for (const receipt of state.operationReceipts ?? []) {
      entries.value.push({
        id: nextId(),
        kind: 'activity',
        turnId,
        activity: 'receipt',
        receipt: cloneReactiveContract(receipt)
      })
    }
    if (state.streamingText) {
      entries.value.push({
        id: nextId(),
        kind: 'assistant',
        text: state.streamingText,
        streaming: true,
        provider: state.appliedConfiguration?.provider,
        model: state.appliedConfiguration?.model,
        effort: state.appliedConfiguration?.effort
      })
      streamingEntry = entries.value.at(-1) as ChatAssistantEntry
    }
  }

  hydrateDurableState()

  function findToolEntry(callId: string): ChatToolEntry | undefined {
    for (let i = entries.value.length - 1; i >= 0; i--) {
      const entry = entries.value[i]
      if (entry.kind === 'tool' && entry.callId === callId) return entry
    }
    return undefined
  }

  const unsubscribe = agentBridge.subscribe((message) => {
    switch (message.type) {
      case 'durable_event': {
        const event = message.envelope.payload
        if (event.type === 'turn_accepted' || event.type === 'turn_progress') {
          const progress =
            findActivity(event.turnId, 'progress') ??
            ({
              id: nextId(),
              kind: 'activity',
              turnId: event.turnId,
              activity: 'progress'
            } satisfies ChatActivityEntry)
          progress.phase = event.phase
          progress.status = event.status
          if (!entries.value.includes(progress)) entries.value.push(progress)
        } else if (event.type === 'instruction_breakdown') {
          const entry =
            findActivity(event.turnId, 'breakdown') ??
            ({
              id: nextId(),
              kind: 'activity',
              turnId: event.turnId,
              activity: 'breakdown'
            } satisfies ChatActivityEntry)
          entry.breakdown = structuredClone(event.breakdown)
          if (!entries.value.includes(entry)) entries.value.push(entry)
        } else if (event.type === 'skill_activated') {
          const entry =
            findActivity(event.turnId, 'skills') ??
            ({
              id: nextId(),
              kind: 'activity',
              turnId: event.turnId,
              activity: 'skills',
              skills: []
            } satisfies ChatActivityEntry)
          entry.skills ??= []
          const skillIndex = entry.skills.findIndex(
            (skill) => skill.skillId === event.skill.skillId
          )
          if (skillIndex < 0) entry.skills.push(structuredClone(event.skill))
          else entry.skills.splice(skillIndex, 1, structuredClone(event.skill))
          if (!entries.value.includes(entry)) entries.value.push(entry)
        } else if (event.type === 'operation_receipt') {
          const entry =
            findActivity(
              event.turnId,
              'receipt',
              (candidate) =>
                candidate.receipt?.operationId === event.receipt.operationId
            ) ??
            ({
              id: nextId(),
              kind: 'activity',
              turnId: event.turnId,
              activity: 'receipt'
            } satisfies ChatActivityEntry)
          entry.receipt = structuredClone(event.receipt)
          if (!entries.value.includes(entry)) entries.value.push(entry)
        } else if (event.type === 'assistant_text_delta') {
          if (!streamingEntry) {
            entries.value.push({
              id: nextId(),
              kind: 'assistant',
              text: '',
              streaming: true,
              ...(agentBridge.state.appliedConfiguration
                ? {
                    provider:
                      agentBridge.state.appliedConfiguration.provider,
                    model: agentBridge.state.appliedConfiguration.model,
                    ...(agentBridge.state.appliedConfiguration.effort
                      ? {
                          effort:
                            agentBridge.state.appliedConfiguration.effort
                        }
                      : {})
                  }
                : {})
            })
            streamingEntry = entries.value[
              entries.value.length - 1
            ] as ChatAssistantEntry
          }
          streamingEntry.text += event.text
        } else if (event.type === 'turn_finished') {
          const safeMessage = event.error?.userMessage
          if (!streamingEntry) {
            entries.value.push({
              id: nextId(),
              kind: 'assistant',
              text: safeMessage ?? event.status,
              streaming: false,
              provider:
                event.provider === 'claude-code' ||
                event.provider === 'openai-codex'
                  ? event.provider
                  : undefined,
              metrics: event.metrics
            })
          } else {
            if (safeMessage) {
              streamingEntry.text += `\n\n${safeMessage}`
            }
            streamingEntry.streaming = false
            streamingEntry.metrics = event.metrics
          }
          streamingEntry = null
          entries.value.push({
            id: nextId(),
            kind: 'activity',
            turnId: event.turnId,
            activity: 'terminal',
            phase: event.phase,
            status: event.status,
            terminal: structuredClone(event)
          })
        }
        break
      }
      case 'assistant_text_delta': {
        if (!streamingEntry) {
          const entry: ChatAssistantEntry = {
            id: nextId(),
            kind: 'assistant',
            text: '',
            streaming: true,
            ...(agentBridge.state.appliedConfiguration
              ? {
                  provider:
                    agentBridge.state.appliedConfiguration.provider,
                  model: agentBridge.state.appliedConfiguration.model,
                  ...(agentBridge.state.appliedConfiguration.effort
                    ? {
                        effort:
                          agentBridge.state.appliedConfiguration.effort
                      }
                    : {})
                }
              : {})
          }
          entries.value.push(entry)
          // Keep the reactive proxy from the ref array. Mutating the raw
          // object after insertion does not reliably trigger a Vue update.
          streamingEntry = entries.value[entries.value.length - 1] as ChatAssistantEntry
        }
        streamingEntry.text += message.text
        break
      }
      case 'assistant_done': {
        if (!streamingEntry) {
          entries.value.push({
            id: nextId(),
            kind: 'assistant',
            text: '',
            streaming: false,
            provider: message.provider,
            model: message.model,
            resolvedModel: message.resolvedModel,
            effort: message.effort,
            metrics: message.metrics
          })
        } else {
          streamingEntry.streaming = false
          streamingEntry.provider = message.provider
          streamingEntry.model = message.model
          streamingEntry.resolvedModel = message.resolvedModel
          streamingEntry.effort = message.effort
          streamingEntry.metrics = message.metrics
        }
        streamingEntry = null
        break
      }
      case 'ai_configuration_applied': {
        if (message.revision === pendingResetRevision) {
          entries.value = []
          streamingEntry = null
          pendingResetRevision = undefined
        } else if (message.newConversation && entries.value.length > 0) {
          entries.value.push({
            id: nextId(),
            kind: 'boundary',
            label:
              `${message.configuration.provider} / ${message.configuration.model}` +
              (message.configuration.effort
                ? ` / ${message.configuration.effort}`
                : ' / Default')
          })
        }
        break
      }
      case 'ai_configuration_rejected': {
        if (message.revision === pendingResetRevision) {
          pendingResetRevision = undefined
        }
        break
      }
      case 'tool_call': {
        // Text before and after a tool call belongs on opposite sides of the
        // tool chip in the timeline.
        if (streamingEntry) {
          streamingEntry.streaming = false
          streamingEntry = null
        }
        entries.value.push({
          id: nextId(),
          kind: 'tool',
          callId: message.callId,
          name: message.name,
          input: message.input
        })
        break
      }
      case 'tool_result': {
        const entry = findToolEntry(message.callId)
        if (entry) entry.result = message.result
        break
      }
      case 'error': {
        entries.value.push({ id: nextId(), kind: 'error', message: message.message })
        break
      }
      case 'connection_reset': {
        if (streamingEntry) {
          streamingEntry.streaming = false
          streamingEntry = null
        }
        entries.value.push({ id: nextId(), kind: 'error', message: message.message })
        break
      }
    }
  })

  async function sendMessage(
    text: string,
    attachments: InputReference[] = []
  ): Promise<boolean> {
    if (!text.trim()) return false
    const selectionSnapshot = captureSelectionSnapshot()
    const sheet = captureSheetSnapshot()
    try {
      const request =
        attachments.length > 0
          ? agentBridge.sendUserMessage(
              text,
              selectionSnapshot,
              sheet,
              attachments.map((attachment) => attachment.inputId)
            )
          : agentBridge.sendUserMessage(text, selectionSnapshot, sheet)
      const displayText = (await request) ?? text
      entries.value.push({
        id: nextId(),
        kind: 'user',
        text: displayText,
        attachedCount: selectionSnapshot.count
      })
    } catch (err) {
      entries.value.push({
        id: nextId(),
        kind: 'error',
        message: err instanceof Error ? err.message : String(err)
      })
      return false
    }
    return true
  }

  function interrupt() {
    agentBridge.interrupt()
  }

  function resetChat() {
    if (!agentBridge.reset()) return
    pendingResetRevision = agentBridge.state.pendingRevision
  }

  function dispose() {
    unsubscribe()
  }

  async function retryLastMessage(): Promise<boolean> {
    const lastUser = [...entries.value]
      .reverse()
      .find((entry): entry is ChatUserEntry => entry.kind === 'user')
    return lastUser ? sendMessage(lastUser.text) : false
  }

  return {
    entries,
    sendMessage,
    retryLastMessage,
    interrupt,
    resetChat,
    dispose
  }
}
