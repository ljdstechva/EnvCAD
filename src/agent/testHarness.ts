import { agentBridge } from './bridge'
import { captureSelectionSnapshot, captureSheetSnapshot } from './context'
import type { ToolResult } from './protocol'

export interface AgentTestResult {
  assistantText: string
  toolCalls: Array<{ callId: string; name: string; input: unknown; result?: ToolResult }>
}

declare global {
  interface Window {
    __agentTest?: (text: string) => Promise<AgentTestResult>
  }
}

const TEST_TIMEOUT_MS = 180_000
let testRunning = false

/**
 * Dev-only harness for exercising the agent bridge before there is a chat
 * UI. From the browser console: window.__agentTest("draw a line from 0,0 to 20,0")
 * Protocol traffic is already logged by src/agent/bridge.ts (console.debug,
 * gated on import.meta.env.DEV) whenever a message crosses the WebSocket.
 */
export function installAgentTestHarness() {
  if (!import.meta.env.DEV) return
  window.__agentTest = async (text: string) => {
    if (testRunning) throw new Error('An agent acceptance test is already running')
    if (agentBridge.state.connectionState !== 'online') {
      throw new Error('Agent sidecar is offline; wait for the bridge to reconnect before testing')
    }

    testRunning = true
    const selectionSnapshot = captureSelectionSnapshot()
    const sheet = captureSheetSnapshot()
    console.log('[agentTest] sending user_message:', { text, selectionSnapshot, sheet })

    try {
      const result = await new Promise<AgentTestResult>((resolve, reject) => {
        let assistantText = ''
        const toolCalls: AgentTestResult['toolCalls'] = []
        let settled = false

        const finish = (callback: () => void) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          unsubscribe()
          callback()
        }

        const unsubscribe = agentBridge.subscribe((message) => {
          switch (message.type) {
            case 'assistant_text_delta':
              assistantText += message.text
              break
            case 'tool_call':
              toolCalls.push({
                callId: message.callId,
                name: message.name,
                input: message.input
              })
              break
            case 'tool_result': {
              const call = toolCalls.find((candidate) => candidate.callId === message.callId)
              if (call) call.result = message.result
              break
            }
            case 'error':
              finish(() => reject(new Error(message.message)))
              break
            case 'assistant_done':
              finish(() => resolve({ assistantText, toolCalls }))
              break
          }
        })

        const timer = setTimeout(() => {
          finish(() =>
            reject(new Error(`Agent acceptance test timed out after ${TEST_TIMEOUT_MS / 1000}s`))
          )
        }, TEST_TIMEOUT_MS)

        try {
          agentBridge.sendUserMessage(text, selectionSnapshot, sheet)
        } catch (error) {
          finish(() => reject(error))
        }
      })
      console.log('[agentTest] completed:', result)
      return result
    } catch (error) {
      console.error('[agentTest] failed:', error)
      throw error
    } finally {
      testRunning = false
    }
  }
  console.log('[agentTest] window.__agentTest(text) is ready')
}
