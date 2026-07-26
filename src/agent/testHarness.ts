import { AcApDocManager } from '@mlightcad/cad-simple-viewer'
import { sheetStore } from '../sheet/sheetStore'
import { agentBridge } from './bridge'
import { captureSelectionSnapshot, captureSheetSnapshot } from './context'
import { executeCadTool } from './handlers'
import type { CadToolName, ToolResult } from './protocol'

export interface AgentTestResult {
  assistantText: string
  toolCalls: Array<{ callId: string; name: string; input: unknown; result?: ToolResult }>
}

export interface CadTestEntity {
  id: string
  type: string
  layer: string
  bbox: { minX: number; minY: number; maxX: number; maxY: number } | null
}

/**
 * Dev-only inspection and selection control, so the scripted dialogues in
 * docs/agent-test-plan.md can set up a deterministic selection instead of
 * clicking canvas pixels.
 */
export interface CadTestApi {
  entities(): CadTestEntity[]
  select(ids: string[]): number
  selectByLayer(layer: string): string[]
  clearSelection(): void
  selection(): string[]
  sheet(): unknown
  canUndo(): boolean
  callTool(name: CadToolName, input: unknown): Promise<ToolResult>
}

declare global {
  interface Window {
    __agentTest?: (text: string) => Promise<AgentTestResult>
    __cadTest?: CadTestApi
  }
}

function installCadTestApi() {
  const listEntities = (): CadTestEntity[] => {
    const db = AcApDocManager.instance.curDocument.database
    return Array.from(db.tables.blockTable.modelSpace.newIterator()).map((entity) => {
      const extents = entity.geometricExtents
      return {
        id: entity.objectId,
        type: entity.type,
        layer: entity.layer,
        bbox: extents.isEmpty()
          ? null
          : {
              minX: extents.min.x,
              minY: extents.min.y,
              maxX: extents.max.x,
              maxY: extents.max.y
            }
      }
    })
  }

  window.__cadTest = {
    entities: listEntities,
    select(ids) {
      const selectionSet = AcApDocManager.instance.curView.selectionSet
      selectionSet.clear()
      selectionSet.add(ids)
      return selectionSet.count
    },
    selectByLayer(layer) {
      const ids = listEntities()
        .filter((entity) => entity.layer === layer)
        .map((entity) => entity.id)
      window.__cadTest?.select(ids)
      return ids
    },
    clearSelection() {
      AcApDocManager.instance.curView.selectionSet.clear()
    },
    selection() {
      return [...AcApDocManager.instance.curView.selectionSet.ids]
    },
    sheet() {
      return JSON.parse(JSON.stringify(sheetStore.current))
    },
    canUndo() {
      return AcApDocManager.instance.curDocument.database.transactionManager.canUndo()
    },
    callTool(name, input) {
      return executeCadTool(name, input)
    }
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
  installCadTestApi()
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
  console.log('[agentTest] window.__agentTest(text) and window.__cadTest are ready')
}
