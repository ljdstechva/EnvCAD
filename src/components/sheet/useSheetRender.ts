import { onBeforeUnmount, onMounted, toRefs, watch } from 'vue'
import { AcApDocManager } from '@mlightcad/cad-simple-viewer'
import type { AcDbDatabase } from '@mlightcad/data-model'
import {
  cadSessionState,
  requireEditableCadSession
} from '../../cad/session'
import { sheetPreviewService } from '../../sheet/previewService'
import { sheetStore } from '../../sheet/sheetStore'

const RENDER_DEBOUNCE_MS = 500
const MANAGER_POLL_MS = 300

export function useSheetRender() {
  const {
    svg,
    svgSha256,
    warnings,
    rendering,
    renderError,
    diagnostics,
    renderRevision
  } = toRefs(sheetPreviewService.state)

  let debounceHandle: ReturnType<typeof setTimeout> | null = null
  let pollHandle: ReturnType<typeof setInterval> | null = null
  let boundDatabase: AcDbDatabase | null = null
  let managerBound = false
  let pendingForce = false

  const onDbChanged = () => {
    sheetPreviewService.invalidate()
    scheduleRender()
  }
  const onDocumentActivated = () => {
    bindDatabaseEvents(getCurrentDatabase())
    sheetPreviewService.invalidate()
    scheduleRender()
  }

  function getCurrentDatabase(): AcDbDatabase | null {
    try {
      return requireEditableCadSession().database
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

  function scheduleRender(force = false) {
    pendingForce ||= force
    if (debounceHandle) clearTimeout(debounceHandle)
    debounceHandle = setTimeout(() => {
      debounceHandle = null
      const shouldForce = pendingForce
      pendingForce = false
      void doRender(shouldForce)
    }, RENDER_DEBOUNCE_MS)
  }

  async function doRender(force = false) {
    if (
      cadSessionState.status !== 'active' ||
      !cadSessionState.editable ||
      !cadSessionState.viewReady
    ) {
      sheetPreviewService.clearVisiblePreview()
      return
    }
    try {
      await sheetPreviewService.render(force)
    } catch {
      // The shared service records the bounded UI error and preview status.
    }
  }

  const stopSheetWatch = watch(
    () => sheetStore.current,
    () => scheduleRender(),
    {
      deep: true
    }
  )
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
    svgSha256,
    renderRevision,
    refresh: () => scheduleRender(true)
  }
}
