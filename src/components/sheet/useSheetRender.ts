import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AcApDocManager } from '@mlightcad/cad-simple-viewer'
import type { AcDbDatabase } from '@mlightcad/data-model'
import {
  cadSessionState,
  recordSheetPreview,
  requireEditableCadSession
} from '../../cad/session'
import { sheetRenderer } from '../../sheet/renderSheet'
import { sheetStore } from '../../sheet/sheetStore'
import type {
  SheetRenderDiagnostics,
  SheetRenderResult
} from '../../sheet/types'

const RENDER_DEBOUNCE_MS = 500
const MANAGER_POLL_MS = 300

export function useSheetRender() {
  const svg = ref('')
  const warnings = ref<string[]>([])
  const rendering = ref(false)
  const renderError = ref<string | null>(null)
  const diagnostics = ref<SheetRenderDiagnostics | null>(null)

  let debounceHandle: ReturnType<typeof setTimeout> | null = null
  let pollHandle: ReturnType<typeof setInterval> | null = null
  let boundDatabase: AcDbDatabase | null = null
  let renderToken = 0
  let managerBound = false

  const onDbChanged = () => scheduleRender()
  const onDocumentActivated = () => {
    bindDatabaseEvents(getCurrentDatabase())
    scheduleRender()
  }

  function getCurrentDatabase(): AcDbDatabase | null {
    try {
      return requireEditableCadSession().database
    } catch {
      return null
    }
  }

  function getCurrentDocument(): unknown {
    try {
      return requireEditableCadSession().manager.curDocument
    } catch {
      return null
    }
  }

  function bindDatabaseEvents(db: AcDbDatabase | null) {
    if (boundDatabase === db) return
    if (boundDatabase) {
      boundDatabase.events.entityAppended.removeEventListener(onDbChanged)
      boundDatabase.events.entityModified.removeEventListener(onDbChanged)
      boundDatabase.events.entityErased.removeEventListener(onDbChanged)
      boundDatabase.events.layerAppended.removeEventListener(onDbChanged)
      boundDatabase.events.layerModified.removeEventListener(onDbChanged)
      boundDatabase.events.layerErased.removeEventListener(onDbChanged)
    }
    boundDatabase = db
    if (boundDatabase) {
      boundDatabase.events.entityAppended.addEventListener(onDbChanged)
      boundDatabase.events.entityModified.addEventListener(onDbChanged)
      boundDatabase.events.entityErased.addEventListener(onDbChanged)
      boundDatabase.events.layerAppended.addEventListener(onDbChanged)
      boundDatabase.events.layerModified.addEventListener(onDbChanged)
      boundDatabase.events.layerErased.addEventListener(onDbChanged)
    }
  }

  function tryAttachManagerEvents(): boolean {
    if (managerBound) return true
    let manager: AcApDocManager
    try {
      manager = AcApDocManager.instance
    } catch {
      return false
    }
    manager.events.documentActivated.addEventListener(onDocumentActivated)
    manager.events.documentCreated.addEventListener(onDocumentActivated)
    bindDatabaseEvents(getCurrentDatabase())
    managerBound = true
    return true
  }

  function scheduleRender() {
    if (debounceHandle) clearTimeout(debounceHandle)
    debounceHandle = setTimeout(() => {
      debounceHandle = null
      void doRender()
    }, RENDER_DEBOUNCE_MS)
  }

  async function doRender() {
    const token = ++renderToken
    rendering.value = true
    renderError.value = null
    if (
      cadSessionState.status !== 'active' ||
      !cadSessionState.editable ||
      !cadSessionState.viewReady
    ) {
      svg.value = ''
      warnings.value = []
      diagnostics.value = null
      rendering.value = false
      recordSheetPreview({
        status: 'unavailable',
        entityCount: 0,
        visibleEntityCount: 0,
        drawableElementCount: 0,
        warnings: [],
        unitMismatch: false,
        clipping: false
      })
      return
    }
    recordSheetPreview({
      status: 'rendering',
      entityCount: cadSessionState.entityCount,
      visibleEntityCount: cadSessionState.visibleEntityCount,
      drawableElementCount: 0,
      warnings: [],
      unitMismatch: false,
      clipping: false
    })
    try {
      const doc = getCurrentDocument()
      const result: SheetRenderResult = await sheetRenderer.render(
        doc,
        sheetStore.current
      )
      if (token !== renderToken) return
      svg.value = result.svg
      warnings.value = result.warnings
      diagnostics.value = result.diagnostics
      recordSheetPreview({
        status: result.warnings.length > 0 ? 'warning' : 'ready',
        entityCount: result.diagnostics.entityCount,
        visibleEntityCount: result.diagnostics.visibleEntityCount,
        drawableElementCount: result.diagnostics.drawableElementCount,
        warnings: result.warnings,
        unitMismatch: result.diagnostics.unitMismatch,
        clipping: result.diagnostics.clipping
      })
    } catch (err) {
      if (token !== renderToken) return
      renderError.value = err instanceof Error ? err.message : String(err)
      diagnostics.value = null
      recordSheetPreview({
        status: 'error',
        entityCount: cadSessionState.entityCount,
        visibleEntityCount: cadSessionState.visibleEntityCount,
        drawableElementCount: 0,
        warnings: [],
        unitMismatch:
          cadSessionState.databaseUnit !== 'unknown' &&
          cadSessionState.databaseUnit !== sheetStore.current.drawingUnit,
        clipping: false,
        error: renderError.value
      })
    } finally {
      if (token === renderToken) rendering.value = false
    }
  }

  const stopSheetWatch = watch(() => sheetStore.current, scheduleRender, {
    deep: true
  })
  const stopSessionWatch = watch(
    () => [
      cadSessionState.status,
      cadSessionState.documentName,
      cadSessionState.entityCount,
      cadSessionState.visibleEntityCount
    ],
    () => {
      bindDatabaseEvents(getCurrentDatabase())
      scheduleRender()
    }
  )

  onMounted(() => {
    if (!tryAttachManagerEvents()) {
      pollHandle = setInterval(() => {
        if (tryAttachManagerEvents()) {
          if (pollHandle) {
            clearInterval(pollHandle)
            pollHandle = null
          }
          scheduleRender()
        }
      }, MANAGER_POLL_MS)
    }
    scheduleRender()
  })

  onBeforeUnmount(() => {
    stopSheetWatch()
    stopSessionWatch()
    if (debounceHandle) clearTimeout(debounceHandle)
    if (pollHandle) clearInterval(pollHandle)
    bindDatabaseEvents(null)
    if (managerBound) {
      try {
        const manager = AcApDocManager.instance
        manager.events.documentActivated.removeEventListener(onDocumentActivated)
        manager.events.documentCreated.removeEventListener(onDocumentActivated)
      } catch {
        // manager already gone
      }
    }
  })

  return {
    svg,
    warnings,
    rendering,
    renderError,
    diagnostics,
    refresh: scheduleRender
  }
}
