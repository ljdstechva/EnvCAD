import { reactive, ref, shallowRef, type Ref } from 'vue'
import {
  AcApDocManager,
  AcApOpenViewMode,
  AcEdOpenMode,
  eventBus,
  type AcEdSelectionEventArgs
} from '@mlightcad/cad-simple-viewer'
import { AcDbLayout, AcDbUnitsValue } from '@mlightcad/data-model'
import dxfParserWorkerUrl from '../../node_modules/@mlightcad/cad-simple-viewer/dist/dxf-parser-worker.js?url'
import dwgParserWorkerUrl from '../../node_modules/@mlightcad/cad-simple-viewer/dist/libredwg-parser-worker.js?url'
import mtextRendererWorkerUrl from '../../node_modules/@mlightcad/cad-simple-viewer/dist/mtext-renderer-worker.js?url'
import { pushToast } from '../toast/toastStore'
import { pushRecentFile } from '../autosave/autosave'

export interface LayerInfo {
  name: string
  colorCss: string
  isOff: boolean
}

export function useCadViewer() {
  const selectionCount = ref(0)
  const currentLayer = ref('0')
  const drawingUnit = ref('mm')
  const canUndo = ref(false)
  const canRedo = ref(false)
  const documentOpen = ref(false)
  const isDirty = ref(false)
  const fileName = ref('drawing.dxf')
  const layers: Ref<LayerInfo[]> = ref([])
  const docManager = shallowRef<AcApDocManager | null>(null)

  function markDirty() {
    isDirty.value = true
  }

  function refreshLayers() {
    const db = docManager.value?.curDocument?.database
    if (!db) {
      layers.value = []
      return
    }
    const result: LayerInfo[] = []
    for (const layer of db.tables.layerTable.newIterator()) {
      result.push({
        name: layer.name,
        colorCss: layer.color.cssColor ?? '#ffffff',
        isOff: layer.isOff
      })
    }
    layers.value = result
    currentLayer.value = db.clayer
    drawingUnit.value = AcDbUnitsValue[db.insunits as AcDbUnitsValue] ?? 'Unknown'
  }

  function refreshUndoRedo() {
    const tm = docManager.value?.curDocument?.database.transactionManager
    canUndo.value = tm?.canUndo() ?? false
    canRedo.value = tm?.canRedo() ?? false
  }

  function refreshAfterDatabaseEdit() {
    refreshLayers()
    refreshUndoRedo()
  }

  function ensureLayoutViews(manager: AcApDocManager) {
    const db = manager.curDocument.database
    let hasActiveLayout = false
    for (const layout of db.objects.layout.newIterator()) {
      manager.curView.addLayout(layout)
      hasActiveLayout ||= layout.blockTableRecordId === db.currentSpaceId
    }

    if (!hasActiveLayout) {
      const modelLayout = new AcDbLayout()
      modelLayout.layoutName = 'Model'
      modelLayout.blockTableRecordId = db.currentSpaceId
      manager.curView.addLayout(modelLayout)
    }
  }

  function init(container: HTMLElement) {
    const manager = AcApDocManager.createInstance({
      container,
      autoResize: true,
      baseUrl: 'https://cdn.jsdelivr.net/gh/mlightcad/cad-data@main/',
      webworkerFileUrls: {
        dxfParser: dxfParserWorkerUrl,
        dwgParser: dwgParserWorkerUrl,
        mtextRender: mtextRendererWorkerUrl
      }
    })
    if (!manager) {
      throw new Error('Failed to create AcApDocManager instance')
    }
    docManager.value = manager

    manager.curView.selectionSet.events.selectionAdded.addEventListener(
      (_args: AcEdSelectionEventArgs) => {
        selectionCount.value = manager.curView.selectionSet.count
      }
    )
    manager.curView.selectionSet.events.selectionRemoved.addEventListener(
      (_args: AcEdSelectionEventArgs) => {
        selectionCount.value = manager.curView.selectionSet.count
      }
    )

    manager.events.documentActivated.addEventListener(() => {
      // Minimal DXFs can rely on the database's pre-existing model layout
      // instead of emitting a layout-added event during parsing. Ensure the
      // corresponding view exists before AcApDocManager applies its initial
      // zoom immediately after this event.
      ensureLayoutViews(manager)
      documentOpen.value = true
      isDirty.value = false
      refreshLayers()
      refreshUndoRedo()
      selectionCount.value = manager.curView.selectionSet.count
    })

    // Undo/redo state must also refresh after edits made outside the
    // toolbar's own undo/redo/open calls (e.g. agent tool handlers editing
    // the database via acapRunDatabaseEdit, which emits this event).
    eventBus.on('undo-stack-changed', () => {
      refreshAfterDatabaseEdit()
      markDirty()
    })

    return manager
  }

  async function openFile(file: File) {
    const manager = docManager.value
    if (!manager) return
    try {
      const buffer = await file.arrayBuffer()
      await manager.openDocument(file.name, buffer, {
        mode: AcEdOpenMode.Write,
        openViewMode: AcApOpenViewMode.Extents
      })
      fileName.value = file.name
      pushRecentFile(file.name)
      refreshLayers()
      refreshUndoRedo()
    } catch (error) {
      pushToast(
        `Couldn't open ${file.name}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  async function openFromDxfText(name: string, dxfText: string) {
    const manager = docManager.value
    if (!manager) return
    try {
      const buffer = new TextEncoder().encode(dxfText).buffer
      await manager.openDocument(name, buffer, {
        mode: AcEdOpenMode.Write,
        openViewMode: AcApOpenViewMode.Extents
      })
      fileName.value = name
      refreshLayers()
      refreshUndoRedo()
    } catch (error) {
      pushToast(
        `Couldn't restore ${name}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  function currentDxfOut(): string | null {
    const manager = docManager.value
    if (!manager?.curDocument) return null
    const content = manager.curDocument.database.dxfOut(undefined, 6)
    return typeof content === 'string' ? content : new TextDecoder().decode(content)
  }

  function saveDxf(name?: string) {
    const manager = docManager.value
    if (!manager) return
    const content = manager.curDocument.database.dxfOut(undefined, 6)
    const blobPart: BlobPart =
      typeof content === 'string' ? content : new Uint8Array(content)
    const blob = new Blob([blobPart], { type: 'application/dxf;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name ?? fileName.value
    a.click()
    URL.revokeObjectURL(url)
    isDirty.value = false
  }

  function undo() {
    docManager.value?.curDocument.database.transactionManager.undo()
    refreshLayers()
    refreshUndoRedo()
    markDirty()
  }

  function redo() {
    docManager.value?.curDocument.database.transactionManager.redo()
    refreshLayers()
    refreshUndoRedo()
    markDirty()
  }

  function zoomExtents() {
    docManager.value?.curView.zoomToFitDrawing()
  }

  function setCanvasBackground(colorHex: number) {
    const view = docManager.value?.curView
    if (view) view.backgroundColor = colorHex
  }

  function toggleLayer(name: string) {
    const db = docManager.value?.curDocument?.database
    if (!db) return
    const layer = db.tables.layerTable.getAt(name)
    if (!layer) return
    layer.isOff = !layer.isOff
    docManager.value?.regen()
    refreshLayers()
    markDirty()
  }

  return reactive({
    selectionCount,
    currentLayer,
    drawingUnit,
    canUndo,
    canRedo,
    documentOpen,
    isDirty,
    fileName,
    layers,
    init,
    openFile,
    openFromDxfText,
    currentDxfOut,
    saveDxf,
    undo,
    redo,
    zoomExtents,
    toggleLayer,
    setCanvasBackground
  })
}

export type CadViewerApi = ReturnType<typeof useCadViewer>
