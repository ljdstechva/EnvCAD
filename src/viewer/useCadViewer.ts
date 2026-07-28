import { computed, reactive, ref, shallowRef, type Ref } from 'vue'
import {
  AcApDocManager,
  AcApOpenViewMode,
  AcEdOpenMode,
  eventBus,
  type AcEdSelectionEventArgs
} from '@mlightcad/cad-simple-viewer'
import { AcDbUnitsValue } from '@mlightcad/data-model'
import { FontManager } from '@mlightcad/mtext-renderer'
import dxfParserWorkerUrl from '../../node_modules/@mlightcad/cad-simple-viewer/dist/dxf-parser-worker.js?url'
import dwgParserWorkerUrl from '../../node_modules/@mlightcad/cad-simple-viewer/dist/libredwg-parser-worker.js?url'
import mtextRendererWorkerUrl from '../../node_modules/@mlightcad/cad-simple-viewer/dist/mtext-renderer-worker.js?url'
import { pushToast } from '../toast/toastStore'
import { clearAutosaveSnapshot, pushRecentFile } from '../autosave/autosave'
import { drawingFileProblem, dxfFileName } from './drawingFile'
import { restoreDxfLayerTrueColors } from './dxfLayerColors'
import {
  activateCadDocument,
  beginCadDocumentOpen,
  beginCadDocumentReplacement,
  bindCadSession,
  cadSessionState,
  failCadDocumentOpen,
  markCadSessionDatabaseEdited,
  prepareCadDocumentView,
  refreshCadSessionMetrics,
  requireEditableCadSession,
  scheduleCadSessionRegeneration,
  setCadSessionDirty,
  setNoCadDocument
} from '../cad/session'
import { fitDrawingToScreen } from '../cad/fitDrawing'
import {
  activateSheetDocument,
  deactivateSheetDocument,
  restoreSheetDocument,
  sheetStore
} from '../sheet/sheetStore'
import type { SheetDefinition } from '../sheet/types'

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
  const documentOpen = computed(
    () => cadSessionState.status === 'active' && cadSessionState.editable
  )
  const editable = computed(() => cadSessionState.editable)
  const viewReady = computed(() => cadSessionState.viewReady)
  const sessionStatus = computed(() => cadSessionState.status)
  const hasRenderableGeometry = computed(
    () => cadSessionState.renderableGeometryCount > 0
  )
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
  /** Theme canvas colour, re-applied after each open (see applyCanvasBackground). */
  let canvasBackground: number | undefined
  /**
   * The upstream manager normally starts its default-font download without
   * awaiting it. A fast installed-app open can therefore render MTEXT before
   * any fallback glyphs exist, leaving Model space permanently textless until
   * another regeneration. Keep one explicit readiness promise and gate every
   * document-producing path on it.
   */
  let defaultFontsReady: Promise<void> = Promise.resolve()

  interface DocumentBackup {
    dxf: string
    fileName: string
    dirty: boolean
    sheet: SheetDefinition
  }

  function hasUndoRecords(): boolean {
    return docManager.value?.curDocument?.database.transactionManager.canUndo() ?? false
  }

  function markDirty() {
    dirtyOutsideUndoStack = true
    isDirty.value = true
    setCadSessionDirty(true)
  }

  function markClean() {
    dirtyOutsideUndoStack = false
    cleanWithEmptyUndoStack = !hasUndoRecords()
    isDirty.value = false
    setCadSessionDirty(false)
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
    refreshCadSessionMetrics()
  }

  function init(container: HTMLElement) {
    const manager = AcApDocManager.createInstance({
      container,
      autoResize: true,
      // Worker rendering keeps large annotated drawings responsive. Packaged
      // Model text is made deterministic by the awaited font gate below and
      // the renderer CSP's explicit CAD-data origin, not by blocking the UI
      // thread while hundreds of MTEXT entities are laid out.
      useMainThreadDraw: false,
      // EnvCAD owns the readiness promise below; do not let the library start
      // a second, fire-and-forget load that can race the first document open.
      notLoadDefaultFonts: true,
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
    // The library's minimal preset retains the default SimKai and CAD symbol
    // coverage without making every clean profile download the much larger
    // modern SimSun fallback before its first drawing can open. Fonts named by
    // a document are still loaded by the database reader as that file opens.
    FontManager.instance.setDefaultFonts('minimal')
    defaultFontsReady = manager.loadDefaultFonts()
    bindCadSession(manager, container, {
      markDirty,
      refreshUi: refreshAfterDatabaseEdit
    })

    manager.events.documentActivated.addEventListener(() => {
      prepareCadDocumentView(manager)
    })

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

    // Undo/redo state must also refresh after edits made outside the
    // toolbar's own undo/redo/open calls (e.g. agent tool handlers editing
    // the database via acapRunDatabaseEdit, which emits this event).
    eventBus.on('undo-stack-changed', () => {
      if (!documentOpen.value) return
      refreshAfterDatabaseEdit()
      syncDirtyAfterUndoStackChange()
      setCadSessionDirty(isDirty.value)
    })

    if (window.__cadTest) {
      window.__cadTest.fileName = () => fileName.value
      window.__cadTest.isDirty = () => isDirty.value
      window.__cadTest.canRedo = () =>
        documentOpen.value &&
        manager.curDocument.database.transactionManager.canRedo()
      window.__cadTest.newDrawing = () => newDrawing()
      window.__cadTest.openTextFile = (name, text) =>
        openFile(new File([text], name, { type: 'application/dxf' }))
    }

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
    const backup = captureDocumentBackup()
    let replacementStarted = false
    try {
      await defaultFontsReady
      const buffer = await file.arrayBuffer()
      const dxfText = /\.dxf$/i.test(file.name)
        ? new TextDecoder().decode(buffer)
        : undefined
      // Checked before openDocument, which clears the open drawing first.
      const problem = drawingFileProblem(file.name, buffer)
      if (problem) {
        pushToast(`Couldn't open ${file.name}: ${problem}.`)
        return false
      }
      if (backup) {
        beginCadDocumentReplacement()
        replacementStarted = true
      }
      beginCadDocumentOpen(file.name)
      replacementStarted = true
      const opened = await manager.openDocument(file.name, buffer, {
        mode: AcEdOpenMode.Write,
        openViewMode: AcApOpenViewMode.Extents
      })
      if (!opened) {
        const message = `Couldn't open ${file.name}. It may be corrupt or in an unsupported format.`
        await restoreAfterRejectedOpen(backup, file.name, message)
        pushToast(message)
        return false
      }
      if (
        dxfText &&
        restoreDxfLayerTrueColors(manager.curDocument.database, dxfText) > 0
      ) {
        manager.regen()
      }
      await activateCadDocument(file.name, false)
      fileName.value = file.name
      await activateSheetDocument(file.name, cadSessionState.databaseUnit)
      pushRecentFile(file.name)
      await applyCanvasBackground()
      refreshLayers()
      refreshUndoRedo()
      selectionCount.value = manager.curView.selectionSet.count
      markClean()
      return true
    } catch (error) {
      const message = `Couldn't open ${file.name}: ${
        error instanceof Error ? error.message : String(error)
      }`
      if (replacementStarted) {
        await recoverPreviousDocument(backup, file.name, message)
      }
      pushToast(message)
      return false
    }
  }

  async function newDrawing(): Promise<boolean> {
    const manager = docManager.value
    if (!manager) return false
    const name = 'Untitled.dxf'
    const backup = captureDocumentBackup()
    try {
      await defaultFontsReady
      if (backup) beginCadDocumentReplacement()
      beginCadDocumentOpen(name)
      const opened = await manager.newDocument({
        openViewMode: AcApOpenViewMode.Extents
      })
      if (!opened) {
        const message = "Couldn't create a new drawing from the supported ISO template."
        await recoverPreviousDocument(backup, name, message)
        pushToast(message)
        return false
      }
      await activateCadDocument(name, false)
      fileName.value = name
      await activateSheetDocument(name, cadSessionState.databaseUnit)
      await applyCanvasBackground()
      refreshLayers()
      refreshUndoRedo()
      selectionCount.value = manager.curView.selectionSet.count
      markClean()
      return true
    } catch (error) {
      const message = `Couldn't create a new drawing: ${
        error instanceof Error ? error.message : String(error)
      }`
      await recoverPreviousDocument(backup, name, message)
      pushToast(message)
      return false
    }
  }

  async function openFromDxfText(name: string, dxfText: string): Promise<boolean> {
    const manager = docManager.value
    if (!manager) {
      pushToast(`Couldn't restore ${name}: the drawing view isn't ready yet.`)
      return false
    }
    const backup = captureDocumentBackup()
    try {
      await defaultFontsReady
      const buffer = new TextEncoder().encode(dxfText).buffer
      // Snapshot bodies are always DXF text, but the library picks its parser
      // from the extension — a drawing opened from site.dwg must not be handed
      // back under that name or the DWG parser rejects it.
      if (backup) beginCadDocumentReplacement()
      beginCadDocumentOpen(name)
      const opened = await manager.openDocument(dxfFileName(name), buffer, {
        mode: AcEdOpenMode.Write,
        openViewMode: AcApOpenViewMode.Extents
      })
      if (!opened) {
        const message = `Couldn't restore ${name}. The saved snapshot could not be read.`
        await restoreAfterRejectedOpen(backup, name, message)
        pushToast(message)
        return false
      }
      if (
        restoreDxfLayerTrueColors(manager.curDocument.database, dxfText) > 0
      ) {
        manager.regen()
      }
      await activateCadDocument(name, true)
      fileName.value = name
      await activateSheetDocument(name, cadSessionState.databaseUnit)
      await applyCanvasBackground()
      refreshLayers()
      refreshUndoRedo()
      // Restored content only exists in the browser, so it counts as unsaved
      // work: autosave has to keep protecting it until the user saves.
      markDirty()
      return true
    } catch (error) {
      const message = `Couldn't restore ${name}: ${
        error instanceof Error ? error.message : String(error)
      }`
      await recoverPreviousDocument(backup, name, message)
      pushToast(message)
      return false
    }
  }

  function currentDxfOut(): string | null {
    if (!documentOpen.value) return null
    const { database } = requireEditableCadSession()
    const content = database.dxfOut(undefined, 6)
    return typeof content === 'string' ? content : new TextDecoder().decode(content)
  }

  function saveDxf(name?: string) {
    const { database } = requireEditableCadSession()
    const content = database.dxfOut(undefined, 6)
    const blobPart: BlobPart =
      typeof content === 'string' ? content : new Uint8Array(content)
    const blob = new Blob([blobPart], { type: 'application/dxf;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = dxfFileName(name ?? fileName.value)
    a.click()
    URL.revokeObjectURL(url)
    markClean()
    // The drawing is now on disk, so the pre-save snapshot must go: leaving it
    // would make the next launch offer stale work as if it were newer.
    clearAutosaveSnapshot()
  }

  function undo() {
    requireEditableCadSession().database.transactionManager.undo()
    refreshLayers()
    refreshUndoRedo()
    syncDirtyAfterUndoStackChange()
    setCadSessionDirty(isDirty.value)
    scheduleCadSessionRegeneration()
  }

  function redo() {
    requireEditableCadSession().database.transactionManager.redo()
    refreshLayers()
    refreshUndoRedo()
    syncDirtyAfterUndoStackChange()
    setCadSessionDirty(isDirty.value)
    scheduleCadSessionRegeneration()
  }

  async function fitDrawing() {
    try {
      return await fitDrawingToScreen()
    } catch (error) {
      pushToast(
        `Fit Drawing failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return null
    }
  }

  /**
   * Opening a drawing overwrites the canvas background: AcApDocManager
   * dispatches documentActivated and only then calls
   * AcTrView2d.syncDisplaySysVars, which re-reads the drawing's MODELBKCOLOR
   * (black for most files). The requested theme colour is therefore kept here
   * and re-applied after each open, once the library has had its say.
   */
  function applyCanvasBackground(): void {
    if (canvasBackground === undefined) return
    const view = docManager.value?.curView
    if (!view) return
    view.backgroundColor = canvasBackground
  }

  async function setCanvasBackground(colorHex: number): Promise<void> {
    canvasBackground = colorHex
    try {
      await applyCanvasBackground()
    } catch (error) {
      pushToast(
        `Couldn't refresh drawing colours for the selected theme: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  function toggleLayer(name: string) {
    const db = requireEditableCadSession().database
    const layer = db.tables.layerTable.getAt(name)
    if (!layer) return
    layer.isOff = !layer.isOff
    refreshLayers()
    markCadSessionDatabaseEdited()
  }

  function captureDocumentBackup(): DocumentBackup | null {
    if (!documentOpen.value) return null
    const dxf = currentDxfOut()
    if (dxf === null) return null
    return {
      dxf,
      fileName: fileName.value,
      dirty: isDirty.value,
      sheet: JSON.parse(JSON.stringify(sheetStore.current)) as SheetDefinition
    }
  }

  async function recoverPreviousDocument(
    backup: DocumentBackup | null,
    attemptedName: string,
    failureMessage: string
  ): Promise<void> {
    const manager = docManager.value
    if (!manager || !backup) {
      failCadDocumentOpen(attemptedName, failureMessage)
      deactivateSheetDocument()
      return
    }
    try {
      beginCadDocumentOpen(backup.fileName)
      const buffer = new TextEncoder().encode(backup.dxf).buffer
      const restored = await manager.openDocument(
        dxfFileName(backup.fileName),
        buffer,
        {
          mode: AcEdOpenMode.Write,
          openViewMode: AcApOpenViewMode.Extents
        }
      )
      if (!restored) throw new Error('the previous drawing backup could not be reopened')
      await activateCadDocument(backup.fileName, backup.dirty)
      fileName.value = backup.fileName
      restoreSheetDocument(backup.fileName, backup.sheet)
      await applyCanvasBackground()
      refreshLayers()
      refreshUndoRedo()
      if (backup.dirty) markDirty()
      else markClean()
    } catch (error) {
      setNoCadDocument()
      deactivateSheetDocument()
      failCadDocumentOpen(
        attemptedName,
        `${failureMessage} Recovery also failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  /**
   * `AcApDocManager.openDocument()` parses into a secondary document and
   * returns `false` before replacing the current context when parsing is
   * rejected. In that branch the authoritative database, renderer, selection,
   * and undo stack are still intact, so reparsing the DXF backup would be both
   * unnecessary and lossy. Re-establish only EnvCAD's lifecycle/sheet state.
   */
  async function restoreAfterRejectedOpen(
    backup: DocumentBackup | null,
    attemptedName: string,
    failureMessage: string
  ): Promise<void> {
    const manager = docManager.value
    if (!manager || !backup) {
      failCadDocumentOpen(attemptedName, failureMessage)
      deactivateSheetDocument()
      return
    }
    try {
      beginCadDocumentOpen(backup.fileName)
      await activateCadDocument(backup.fileName, backup.dirty)
      fileName.value = backup.fileName
      restoreSheetDocument(backup.fileName, backup.sheet)
      await applyCanvasBackground()
      refreshLayers()
      refreshUndoRedo()
      selectionCount.value = manager.curView.selectionSet.count
      if (backup.dirty) markDirty()
      else markClean()
    } catch {
      await recoverPreviousDocument(
        backup,
        attemptedName,
        failureMessage
      )
    }
  }

  return reactive({
    selectionCount,
    currentLayer,
    drawingUnit,
    canUndo,
    canRedo,
    documentOpen,
    editable,
    viewReady,
    sessionStatus,
    hasRenderableGeometry,
    isDirty,
    fileName,
    layers,
    init,
    newDrawing,
    openFile,
    openFromDxfText,
    currentDxfOut,
    saveDxf,
    undo,
    redo,
    fitDrawing,
    toggleLayer,
    setCanvasBackground
  })
}

export type CadViewerApi = ReturnType<typeof useCadViewer>
