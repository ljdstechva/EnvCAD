<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Toolbar from './components/Toolbar.vue'
import LayersPanel from './components/LayersPanel.vue'
import SidePanel from './components/SidePanel.vue'
import StatusBar from './components/StatusBar.vue'
import PageSetupDialog from './components/sheet/PageSetupDialog.vue'
import { useCadViewer } from './viewer/useCadViewer'
import { openPageSetup } from './components/sheet/pageSetupUiStore'
import { isEditableTarget } from './keyboard/shortcuts'
import ToastHost from './toast/ToastHost.vue'
import {
  clearAutosaveSnapshot,
  loadAutosaveSnapshot,
  startAutosave,
  type AutosaveSnapshot
} from './autosave/autosave'
import { CANVAS_BACKGROUND, theme, toggleTheme } from './theme/theme'

const viewer = useCadViewer()
const canvasContainer = ref<HTMLDivElement | null>(null)
const layersOpen = ref(false)
const sidePanelOpen = ref(true)
const toolbarRef = ref<InstanceType<typeof Toolbar> | null>(null)
const restoreSnapshot = ref<AutosaveSnapshot | null>(null)
let stopAutosave: (() => void) | null = null

function formatSavedAt(savedAt: number): string {
  try {
    return new Date(savedAt).toLocaleString()
  } catch {
    return ''
  }
}

async function restoreDrawing() {
  const snapshot = restoreSnapshot.value
  if (!snapshot) return
  restoreSnapshot.value = null
  await viewer.openFromDxfText(snapshot.fileName, snapshot.dxf)
  clearAutosaveSnapshot()
}

function discardSnapshot() {
  restoreSnapshot.value = null
  clearAutosaveSnapshot()
}

// The CAD view owns global Ctrl/Cmd+Z, Ctrl/Cmd+Y, Delete/Backspace, and
// Escape (see @mlightcad/cad-simple-viewer's key handler) and is already
// focus-aware. This listener only covers the shortcuts the library doesn't:
// Ctrl/Cmd+O, Ctrl/Cmd+S, F2.
function onGlobalKeydown(event: KeyboardEvent) {
  if (isEditableTarget(event)) return
  const primaryModifier = event.ctrlKey || event.metaKey
  if (primaryModifier && event.key.toLowerCase() === 'o') {
    event.preventDefault()
    toolbarRef.value?.triggerOpen()
  } else if (primaryModifier && event.key.toLowerCase() === 's') {
    event.preventDefault()
    if (viewer.documentOpen) viewer.saveDxf()
  } else if (event.key === 'F2') {
    event.preventDefault()
    openPageSetup()
  }
}

watch(theme, (mode) => {
  viewer.setCanvasBackground(CANVAS_BACKGROUND[mode])
})

onMounted(() => {
  if (canvasContainer.value) {
    viewer.init(canvasContainer.value)
    viewer.setCanvasBackground(CANVAS_BACKGROUND[theme.value])
  }
  window.addEventListener('keydown', onGlobalKeydown)
  restoreSnapshot.value = loadAutosaveSnapshot()
  stopAutosave = startAutosave({
    get documentOpen() {
      return viewer.documentOpen
    },
    get isDirty() {
      return viewer.isDirty
    },
    get fileName() {
      return viewer.fileName
    },
    dxfOut: () => viewer.currentDxfOut()
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  stopAutosave?.()
})

function toggleLayers() {
  layersOpen.value = !layersOpen.value
}
</script>

<template>
  <div class="app-shell">
    <Toolbar ref="toolbarRef" :viewer="viewer" :layers-open="layersOpen" @toggle-layers="toggleLayers" />
    <div v-if="restoreSnapshot" class="restore-banner">
      <span>
        Restore unsaved drawing "{{ restoreSnapshot.fileName }}" from
        {{ formatSavedAt(restoreSnapshot.savedAt) }}?
      </span>
      <button @click="restoreDrawing">Restore</button>
      <button @click="discardSnapshot">Discard</button>
    </div>
    <div class="main-row">
      <div v-if="layersOpen" class="layers-dock">
        <div class="dock-header">Layers</div>
        <LayersPanel :viewer="viewer" />
      </div>
      <div ref="canvasContainer" class="canvas-host">
        <button class="side-toggle" @click="sidePanelOpen = !sidePanelOpen">
          {{ sidePanelOpen ? '›' : '‹' }}
        </button>
      </div>
      <div v-if="sidePanelOpen" class="side-dock">
        <SidePanel :viewer="viewer" />
      </div>
    </div>
    <StatusBar :viewer="viewer" />
    <PageSetupDialog />
    <ToastHost />
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  background: var(--bg-app);
  color: var(--text-primary);
}

.main-row {
  flex: 1;
  display: flex;
  min-height: 0;
  position: relative;
}

.layers-dock {
  width: 220px;
  flex-shrink: 0;
  background: var(--bg-panel);
  border-right: 1px solid var(--border-strong);
  display: flex;
  flex-direction: column;
}

.dock-header {
  padding: 8px 10px;
  font-size: 12px;
  font-weight: 600;
  border-bottom: 1px solid var(--border-strong);
}

.canvas-host {
  flex: 1;
  min-width: 0;
  position: relative;
  background: var(--bg-canvas);
}

.side-dock {
  width: 280px;
  flex-shrink: 0;
  border-left: 1px solid var(--border-strong);
}

.restore-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  background: var(--info-bg);
  color: var(--info-text);
  border-bottom: 1px solid var(--info-border);
  font-size: 12px;
  flex-shrink: 0;
}

.restore-banner button {
  background: var(--bg-button);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: 3px;
  padding: 3px 9px;
  font-size: 11px;
  cursor: pointer;
}

.restore-banner button:hover {
  background: var(--bg-button-hover);
}

.side-toggle {
  position: absolute;
  right: 0;
  top: 8px;
  width: 18px;
  height: 32px;
  background: var(--bg-button);
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  border-right: none;
  cursor: pointer;
  z-index: 2;
}
</style>
