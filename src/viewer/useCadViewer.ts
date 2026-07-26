import { reactive, ref, shallowRef, type Ref } from 'vue'
import {
  AcApDocManager,
  AcEdOpenMode,
  type AcEdSelectionEventArgs
} from '@mlightcad/cad-simple-viewer'

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
  const layers: Ref<LayerInfo[]> = ref([])
  const docManager = shallowRef<AcApDocManager | null>(null)

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
  }

  function refreshUndoRedo() {
    const tm = docManager.value?.curDocument?.database.transactionManager
    canUndo.value = tm?.canUndo() ?? false
    canRedo.value = tm?.canRedo() ?? false
  }

  function init(container: HTMLElement) {
    const manager = AcApDocManager.createInstance({
      container,
      autoResize: true,
      baseUrl: 'https://cdn.jsdelivr.net/gh/mlightcad/cad-data@main/'
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
      documentOpen.value = true
      refreshLayers()
      refreshUndoRedo()
      selectionCount.value = manager.curView.selectionSet.count
    })

    return manager
  }

  async function openFile(file: File) {
    const manager = docManager.value
    if (!manager) return
    const buffer = await file.arrayBuffer()
    await manager.openDocument(file.name, buffer, { mode: AcEdOpenMode.Write })
    refreshLayers()
    refreshUndoRedo()
  }

  function saveDxf(fileName = 'drawing.dxf') {
    const manager = docManager.value
    if (!manager) return
    const content = manager.curDocument.database.dxfOut(undefined, 6)
    const blobPart: BlobPart =
      typeof content === 'string' ? content : new Uint8Array(content)
    const blob = new Blob([blobPart], { type: 'application/dxf;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.click()
    URL.revokeObjectURL(url)
  }

  function undo() {
    docManager.value?.curDocument.database.transactionManager.undo()
    refreshLayers()
    refreshUndoRedo()
  }

  function redo() {
    docManager.value?.curDocument.database.transactionManager.redo()
    refreshLayers()
    refreshUndoRedo()
  }

  function zoomExtents() {
    docManager.value?.curView.zoomToFitDrawing()
  }

  function toggleLayer(name: string) {
    const db = docManager.value?.curDocument?.database
    if (!db) return
    const layer = db.tables.layerTable.getAt(name)
    if (!layer) return
    layer.isOff = !layer.isOff
    docManager.value?.regen()
    refreshLayers()
  }

  return reactive({
    selectionCount,
    currentLayer,
    drawingUnit,
    canUndo,
    canRedo,
    documentOpen,
    layers,
    init,
    openFile,
    saveDxf,
    undo,
    redo,
    zoomExtents,
    toggleLayer
  })
}

export type CadViewerApi = ReturnType<typeof useCadViewer>
