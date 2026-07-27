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
import { clearAutosaveSnapshot, pushRecentFile } from '../autosave/autosave'

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

  /**
   * True when the drawing was last opened or saved with an empty undo stack,
   * which is the only clean state we can recognise again later: the
   * transaction manager exposes `canUndo()` but not the stack depth.
   */
  let cleanWithEmptyUndoStack = true
  /** Set by edits that leave no undo record, so undoing can't clear them. */
  let dirtyOutsideUndoStack = false

  function hasUndoRecords(): boolean {
    return docManager.value?.curDocument?.database.transactionManager.canUndo() ?? false
  }

  function markDirty() {
    dirtyOutsideUndoStack = true
    isDirty.value = true
  }

  function markClean() {
    dirtyOutsideUndoStack = false
    cleanWithEmptyUndoStack = !hasUndoRecords()
    isDirty.value = false
  }

  /**
   * Recomputes the dirty flag after the undo stack moves. Without a stack
   * depth only the unambiguous case can be recognised — a drawing whose clean
   * state had an empty undo stack is clean again once the stack is empty, i.e.
   * the user undid everything back to the file on disk. Everything else stays
   * dirty, which is the safe direction: autosave keeps a snapshot it may not
   * have needed rather than dropping real work.
   */
  function syncDirtyAfterUndoStackChange() {
    isDirty.value = dirtyOutsideUndoStack || !cleanWithEmptyUndoStack || hasUndoRecords()
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
      markClean()
      refreshLayers()
      refreshUndoRedo()
      selectionCount.value = manager.curView.selectionSet.count
    })

    // Undo/redo state must also refresh after edits made outside the
    // toolbar's own undo/redo/open calls (e.g. agent tool handlers editing
    // the database via acapRunDatabaseEdit, which emits this event).
    eventBus.on('undo-stack-changed', () => {
      refreshAfterDatabaseEdit()
      syncDirtyAfterUndoStackChange()
    })

    return manager
  }

  /**
   * `AcApDocManager.openDocument` catches parse failures itself and resolves
   * `false` instead of throwing, so the boolean — not just the catch — decides
   * whether the open succeeded. On failure nothing about the previous document
   * may change: it is still the one on screen.
   */
  async function openFile(file: File): Promise<boolean> {
    const manager = docManager.value
    if (!manager) return false
    try {
      const buffer = await file.arrayBuffer()
      const opened = await manager.openDocument(file.name, buffer, {
        mode: AcEdOpenMode.Write,
        openViewMode: AcApOpenViewMode.Extents
      })
      if (!opened) {
        pushToast(`Couldn't open ${file.name}. It may be corrupt or in an unsupported format.`)
        return false
      }
      fileName.value = file.name
      pushRecentFile(file.name)
      refreshLayers()
      refreshUndoRedo()
      return true
    } catch (error) {
      pushToast(
        `Couldn't open ${file.name}: ${error instanceof Error ? error.message : String(error)}`
      )
      return false
    }
  }

  async function openFromDxfText(name: string, dxfText: string): Promise<boolean> {
    const manager = docManager.value
    if (!manager) {
      pushToast(`Couldn't restore ${name}: the drawing view isn't ready yet.`)
      return false
    }
    try {
      const buffer = new TextEncoder().encode(dxfText).buffer
      const opened = await manager.openDocument(name, buffer, {
        mode: AcEdOpenMode.Write,
        openViewMode: AcApOpenViewMode.Extents
      })
      if (!opened) {
        pushToast(`Couldn't restore ${name}. The saved snapshot could not be read.`)
        return false
      }
      fileName.value = name
      refreshLayers()
      refreshUndoRedo()
      // Restored content only exists in the browser, so it counts as unsaved
      // work: autosave has to keep protecting it until the user saves.
      markDirty()
      return true
    } catch (error) {
      pushToast(
        `Couldn't restore ${name}: ${error instanceof Error ? error.message : String(error)}`
      )
      return false
    }
  }

  function currentDxfOut(): string | null {
    const manager = docManager.value
    if (!manager?.curDocument) return null
    const content = manager.curDocument.database.dxfOut(undefined, 6)
    return typeof content === 'string' ? content : new TextDecoder().decode(content)
  }

  /**
   * The Open dialog also accepts `.dwg`, but this always writes DXF text, so
   * the download always carries a `.dxf` extension — DXF content under a
   * `.dwg` name is rejected by AutoCAD and by EnvCAD itself, which picks its
   * parser from the extension.
   */
  function dxfDownloadName(name: string): string {
    const trimmed = name.trim()
    if (!trimmed) return 'drawing.dxf'
    return `${trimmed.replace(/\.[^./\\]*$/, '')}.dxf`
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
    a.download = dxfDownloadName(name ?? fileName.value)
    a.click()
    URL.revokeObjectURL(url)
    markClean()
    // The drawing is now on disk, so the pre-save snapshot must go: leaving it
    // would make the next launch offer stale work as if it were newer.
    clearAutosaveSnapshot()
  }

  function undo() {
    docManager.value?.curDocument.database.transactionManager.undo()
    refreshLayers()
    refreshUndoRedo()
    syncDirtyAfterUndoStackChange()
  }

  function redo() {
    docManager.value?.curDocument.database.transactionManager.redo()
    refreshLayers()
    refreshUndoRedo()
    syncDirtyAfterUndoStackChange()
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
