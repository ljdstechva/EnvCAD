import { AcApDocManager } from '@mlightcad/cad-simple-viewer'
import { sheetStore } from '../sheet/sheetStore'
import { agentBridge } from './bridge'
import { captureSelectionSnapshot, captureSheetSnapshot } from './context'
import { executeCadTool } from './handlers'
import type { CadToolName, ToolResult } from './protocol'
import {
  activeCadLayoutHasEntity,
  getCadSessionSnapshot,
  requireEditableCadSession
} from '../cad/session'

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
  renderedEntityIds(): string[]
  select(ids: string[]): number
  selectByLayer(layer: string): string[]
  clearSelection(): void
  selection(): string[]
  fileName(): string
  isDirty(): boolean
  sheet(): unknown
  session(): unknown
  viewState(): unknown
  textMaterialState(): unknown
  canUndo(): boolean
  canRedo(): boolean
  newDrawing(): Promise<boolean>
  openTextFile(name: string, text: string): Promise<boolean>
  /** Painted canvas background as a 24-bit RGB number, for theme checks. */
  canvasBackground(): number
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
    let db
    try {
      db = requireEditableCadSession().database
    } catch {
      return []
    }
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
    renderedEntityIds() {
      let view
      try {
        view = requireEditableCadSession().view
      } catch {
        return []
      }
      return listEntities()
        .filter((entity) => activeCadLayoutHasEntity(view, entity.id))
        .map((entity) => entity.id)
    },
    select(ids) {
      let selectionSet
      try {
        selectionSet = requireEditableCadSession().view.selectionSet
      } catch {
        return 0
      }
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
      try {
        requireEditableCadSession().view.selectionSet.clear()
      } catch {
        // Clearing an absent selection is already satisfied.
      }
    },
    selection() {
      try {
        return [...requireEditableCadSession().view.selectionSet.ids]
      } catch {
        return []
      }
    },
    fileName() {
      throw new Error('CAD viewer state is not ready')
    },
    isDirty() {
      throw new Error('CAD viewer state is not ready')
    },
    sheet() {
      return JSON.parse(JSON.stringify(sheetStore.current))
    },
    session() {
      return getCadSessionSnapshot()
    },
    viewState() {
      const { database, view } = requireEditableCadSession()
      const entities = Array.from(
        database.tables.blockTable.modelSpace.newIterator()
      ).filter((entity) => !entity.geometricExtents.isEmpty())
      const extents = entities.reduce(
        (combined, entity) => ({
          minX: Math.min(combined.minX, entity.geometricExtents.min.x),
          minY: Math.min(combined.minY, entity.geometricExtents.min.y),
          maxX: Math.max(combined.maxX, entity.geometricExtents.max.x),
          maxY: Math.max(combined.maxY, entity.geometricExtents.max.y)
        }),
        {
          minX: Number.POSITIVE_INFINITY,
          minY: Number.POSITIVE_INFINITY,
          maxX: Number.NEGATIVE_INFINITY,
          maxY: Number.NEGATIVE_INFINITY
        }
      )
      const camera = view.internalCamera
      const sceneBox = view.cadScene.box
      const corners = Number.isFinite(extents.minX)
        ? [
            { x: extents.minX, y: extents.minY },
            { x: extents.minX, y: extents.maxY },
            { x: extents.maxX, y: extents.minY },
            { x: extents.maxX, y: extents.maxY }
          ].map((point) => view.worldToScreen(point))
        : []
      return {
        width: view.width,
        height: view.height,
        extents,
        sceneExtents:
          sceneBox && !sceneBox.isEmpty()
            ? {
                minX: sceneBox.min.x,
                minY: sceneBox.min.y,
                maxX: sceneBox.max.x,
                maxY: sceneBox.max.y
              }
            : null,
        sceneStats: {
          layoutCount: view.stats.summary.layoutCount,
          entityCount: view.stats.summary.entityCount,
          sceneLayoutIds: Array.from(view.cadScene.layouts.keys()),
          layouts: view.stats.layouts.map((layout, index) => ({
            id: Array.from(view.cadScene.layouts.keys())[index],
            entityCount: layout.summary.entityCount,
            nonEmptyLayers: layout.layers
              .filter((layer) => layer.summary.entityCount > 0)
              .map((layer) => ({
                name: layer.name,
                entityCount: layer.summary.entityCount
              }))
          }))
        },
        databaseLayouts: Array.from(database.objects.layout.newIterator()).map(
          (layout) => ({
            id: layout.objectId,
            name: layout.layoutName,
            blockTableRecordId: layout.blockTableRecordId
          })
        ),
        spaces: {
          modelSpaceId: database.tables.blockTable.modelSpace.objectId,
          currentSpaceId: database.currentSpaceId,
          entityOwnerCounts: Array.from(
            entities.reduce((counts, entity) => {
              counts.set(entity.ownerId, (counts.get(entity.ownerId) ?? 0) + 1)
              return counts
            }, new Map<string, number>())
          )
        },
        layers: Array.from(database.tables.layerTable.newIterator()).map(
          (layer) => ({
            name: layer.name,
            color: layer.color.toString(),
            cssColor: layer.color.cssColor
          })
        ),
        corners,
        camera: {
          x: camera?.position.x,
          y: camera?.position.y,
          zoom: camera?.zoom,
          left: camera?.left,
          right: camera?.right,
          top: camera?.top,
          bottom: camera?.bottom
        }
      }
    },
    textMaterialState() {
      const { view } = requireEditableCadSession()
      const materials: Array<{
        objectType: string
        objectLayer?: string
        objectId?: string
        materialType: string
        color?: number
        uniformColor?: number
        layer?: string
        isForeground?: boolean
        isByLayerColor?: boolean
        materialKey?: string
      }> = []

      view.internalScene.traverse((object: {
        type: string
        userData: Record<string, unknown>
      }) => {
        const drawable = object as typeof object & {
          material?: {
            type?: string
            color?: { getHex(): number }
            uniforms?: { u_color?: { value?: { getHex?(): number } } }
            userData?: Record<string, unknown>
          } | Array<{
            type?: string
            color?: { getHex(): number }
            uniforms?: { u_color?: { value?: { getHex?(): number } } }
            userData?: Record<string, unknown>
          }>
        }
        if (!drawable.material) return

        const objectData = object.userData as Record<string, unknown>
        for (const material of Array.isArray(drawable.material)
          ? drawable.material
          : [drawable.material]) {
          const metadata = material.userData ?? {}
          const uniformValue = material.uniforms?.u_color?.value
          materials.push({
            objectType: object.type,
            objectLayer:
              typeof objectData.layerName === 'string'
                ? objectData.layerName
                : undefined,
            objectId:
              typeof objectData.objectId === 'string'
                ? objectData.objectId
                : undefined,
            materialType: material.type ?? 'unknown',
            color: material.color?.getHex(),
            uniformColor:
              typeof uniformValue?.getHex === 'function'
                ? uniformValue.getHex()
                : undefined,
            layer:
              typeof metadata.layer === 'string' ? metadata.layer : undefined,
            isForeground:
              typeof metadata.isForeground === 'boolean'
                ? metadata.isForeground
                : undefined,
            isByLayerColor:
              typeof metadata.isByLayerColor === 'boolean'
                ? metadata.isByLayerColor
                : undefined,
            materialKey:
              typeof metadata.materialKey === 'string'
                ? metadata.materialKey
                : undefined
          })
        }
      })

      return materials
    },
    canUndo() {
      try {
        return requireEditableCadSession().database.transactionManager.canUndo()
      } catch {
        return false
      }
    },
    canRedo() {
      try {
        return requireEditableCadSession().database.transactionManager.canRedo()
      } catch {
        return false
      }
    },
    newDrawing() {
      return Promise.reject(new Error('CAD viewer state is not ready'))
    },
    openTextFile() {
      return Promise.reject(new Error('CAD viewer state is not ready'))
    },
    canvasBackground() {
      return AcApDocManager.instance.curView.backgroundColor
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
  const e2eMode = import.meta.env.VITE_E2E === 'true'
  if (!import.meta.env.DEV && !e2eMode) return
  installCadTestApi()
  if (!import.meta.env.DEV) {
    console.log('[cadTest] window.__cadTest is ready for the E2E preview build')
    return
  }
  window.__agentTest = async (text: string) => {
    if (testRunning) throw new Error('An agent acceptance test is already running')
    if (agentBridge.state.connectionState !== 'online') {
      throw new Error('Agent sidecar is offline; wait for the bridge to reconnect before testing')
    }

    testRunning = true
    const selectionSnapshot = captureSelectionSnapshot()
    const sheet = captureSheetSnapshot()
    console.log('[agentTest] sending user_message:', {
      promptCharacters: text.length,
      selectionCount: selectionSnapshot.count,
      hasSheet: Boolean(sheet)
    })

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
            case 'durable_event': {
              const event = message.envelope.payload
              if (event.type === 'assistant_text_delta') {
                assistantText += event.text
              } else if (event.type === 'turn_finished') {
                if (
                  event.outcome === 'completed' ||
                  event.outcome === 'recovered'
                ) {
                  finish(() => resolve({ assistantText, toolCalls }))
                } else {
                  finish(() =>
                    reject(
                      new Error(
                        event.error?.userMessage ?? event.status
                      )
                    )
                  )
                }
              }
              break
            }
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
      console.log('[agentTest] completed:', {
        assistantCharacters: result.assistantText.length,
        tools: result.toolCalls.map((call) => ({
          name: call.name,
          succeeded: !call.result?.error,
          ...(call.result?.image
            ? {
                image: {
                  width: call.result.image.width,
                  height: call.result.image.height,
                  byteLength: call.result.image.byteLength,
                  sha256: call.result.image.sha256.slice(0, 12)
                }
              }
            : {})
        }))
      })
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
