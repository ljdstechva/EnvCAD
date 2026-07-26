import { ref } from 'vue'
import { agentBridge } from '../../agent/bridge'
import { captureSelectionSnapshot, captureSheetSnapshot } from '../../agent/context'
import type { ToolResult } from '../../agent/protocol'

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

export type ChatEntry = ChatTextEntry | ChatToolEntry | ChatErrorEntry

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

  function findToolEntry(callId: string): ChatToolEntry | undefined {
    for (let i = entries.value.length - 1; i >= 0; i--) {
      const entry = entries.value[i]
      if (entry.kind === 'tool' && entry.callId === callId) return entry
    }
    return undefined
  }

  const unsubscribe = agentBridge.subscribe((message) => {
    switch (message.type) {
      case 'assistant_text_delta': {
        if (!streamingEntry) {
          const entry: ChatAssistantEntry = {
            id: nextId(),
            kind: 'assistant',
            text: '',
            streaming: true
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
        if (streamingEntry) {
          streamingEntry.streaming = false
          if (!streamingEntry.text) {
            const finished = streamingEntry
            entries.value = entries.value.filter((entry) => entry.id !== finished.id)
          }
        }
        streamingEntry = null
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
    }
  })

  function sendMessage(rawText: string) {
    const text = rawText.trim()
    if (!text) return
    const selectionSnapshot = captureSelectionSnapshot()
    const sheet = captureSheetSnapshot()
    entries.value.push({
      id: nextId(),
      kind: 'user',
      text,
      attachedCount: selectionSnapshot.count
    })
    try {
      agentBridge.sendUserMessage(text, selectionSnapshot, sheet)
    } catch (err) {
      entries.value.push({
        id: nextId(),
        kind: 'error',
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }

  function interrupt() {
    agentBridge.interrupt()
  }

  function resetChat() {
    agentBridge.reset()
    entries.value = []
    streamingEntry = null
  }

  function dispose() {
    unsubscribe()
  }

  return { entries, sendMessage, interrupt, resetChat, dispose }
}
