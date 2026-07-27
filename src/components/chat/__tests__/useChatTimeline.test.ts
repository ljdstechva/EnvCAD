import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentBridgeListener } from '../../../agent/bridge'

const mocks = vi.hoisted(() => {
  let listener: AgentBridgeListener | undefined
  const state = {
    appliedConfiguration: {
      provider: 'openai-codex' as const,
      model: 'gpt-test',
      effort: 'low'
    },
    pendingRevision: 7
  }
  return {
    state,
    reset: vi.fn(() => true),
    sendUserMessage: vi.fn(),
    interrupt: vi.fn(),
    subscribe: vi.fn((next: AgentBridgeListener) => {
      listener = next
      return vi.fn()
    }),
    emit(message: Parameters<AgentBridgeListener>[0]) {
      listener?.(message)
    }
  }
})

vi.mock('../../../agent/bridge', () => ({
  agentBridge: {
    state: mocks.state,
    reset: mocks.reset,
    sendUserMessage: mocks.sendUserMessage,
    interrupt: mocks.interrupt,
    subscribe: mocks.subscribe
  }
}))

vi.mock('../../../agent/context', () => ({
  captureSelectionSnapshot: () => ({ ids: [], count: 0, units: 'Meters' }),
  captureSheetSnapshot: () => ({
    paper: 'A3',
    orientation: 'landscape',
    scaleDenominator: 500,
    drawingUnit: 'Meters'
  })
}))

import { useChatTimeline } from '../useChatTimeline'

describe('useChatTimeline', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.pendingRevision = 7
  })

  it('retains provider metadata and metrics for a tool-only completion', () => {
    const timeline = useChatTimeline()

    mocks.emit({
      type: 'assistant_done',
      provider: 'openai-codex',
      model: 'gpt-test',
      effort: 'low',
      metrics: { totalMs: 42, toolCalls: 1 }
    })

    expect(timeline.entries.value).toEqual([
      expect.objectContaining({
        kind: 'assistant',
        text: '',
        provider: 'openai-codex',
        model: 'gpt-test',
        effort: 'low',
        metrics: { totalMs: 42, toolCalls: 1 }
      })
    ])
    timeline.dispose()
  })

  it('keeps the transcript until the matching reset acknowledgement', () => {
    const timeline = useChatTimeline()
    timeline.sendMessage('Keep this until reset is confirmed.')

    timeline.resetChat()
    expect(timeline.entries.value).toHaveLength(1)

    mocks.emit({
      type: 'ai_configuration_applied',
      revision: 6,
      configuration: {
        provider: 'openai-codex',
        model: 'gpt-test',
        effort: 'low'
      },
      newConversation: true
    })
    expect(timeline.entries.value).toHaveLength(2)

    mocks.emit({
      type: 'ai_configuration_applied',
      revision: 7,
      configuration: {
        provider: 'openai-codex',
        model: 'gpt-test',
        effort: 'low'
      },
      newConversation: true
    })
    expect(timeline.entries.value).toHaveLength(0)
    timeline.dispose()
  })

  it('ends a partial assistant entry at a connection reset boundary', () => {
    const timeline = useChatTimeline()

    mocks.emit({ type: 'assistant_text_delta', text: 'Incomplete response' })
    mocks.emit({
      type: 'connection_reset',
      message: 'The sidecar disconnected during the active turn.'
    })
    mocks.emit({ type: 'assistant_text_delta', text: 'New conversation' })

    expect(timeline.entries.value).toEqual([
      expect.objectContaining({
        kind: 'assistant',
        text: 'Incomplete response',
        streaming: false
      }),
      expect.objectContaining({
        kind: 'error',
        message: 'The sidecar disconnected during the active turn.'
      }),
      expect.objectContaining({
        kind: 'assistant',
        text: 'New conversation',
        streaming: true
      })
    ])
    timeline.dispose()
  })
})
