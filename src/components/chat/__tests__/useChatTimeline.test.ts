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
  captureSelectionSnapshot: () => ({
    ids: [],
    count: 0,
    units: 'Meters',
    revision: { documentRevision: 2, contentRevision: 5 }
  }),
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
    mocks.sendUserMessage.mockImplementation(() => undefined)
  })

  it('preserves prompt formatting and adds the user turn only after local acceptance', async () => {
    const timeline = useChatTimeline()
    const text = '  BEGIN\r\nUnicode 🌏\nEND  '

    await expect(timeline.sendMessage(text)).resolves.toBe(true)
    expect(mocks.sendUserMessage).toHaveBeenCalledWith(
      text,
      {
        ids: [],
        count: 0,
        units: 'Meters',
        revision: { documentRevision: 2, contentRevision: 5 }
      },
      expect.objectContaining({ paper: 'A3' })
    )
    expect(timeline.entries.value).toEqual([
      expect.objectContaining({ kind: 'user', text })
    ])
    timeline.dispose()
  })

  it('does not add a false user turn when local payload validation rejects the request', async () => {
    mocks.sendUserMessage.mockImplementation(() => {
      throw new Error(
        "The complete AI request exceeds EnvCAD's 2 MiB transport capacity."
      )
    })
    const timeline = useChatTimeline()

    await expect(timeline.sendMessage('preserve this draft')).resolves.toBe(
      false
    )
    expect(timeline.entries.value).toEqual([
      expect.objectContaining({
        kind: 'error',
        message: expect.stringContaining('2 MiB transport capacity')
      })
    ])
    timeline.dispose()
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

  it('keeps the transcript until the matching reset acknowledgement', async () => {
    const timeline = useChatTimeline()
    await timeline.sendMessage('Keep this until reset is confirmed.')

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
