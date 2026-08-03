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
const WORKBENCH_MIN_WIDTH = 340
const WORKBENCH_MAX_WIDTH = 560
const WORKBENCH_DEFAULT_WIDTH = 400
const WORKBENCH_WIDTH_KEY = 'envcad.assistant-workbench.width'
const sidePanelWidth = ref(loadWorkbenchWidth())
const toolbarRef = ref<InstanceType<typeof Toolbar> | null>(null)
const restoreSnapshot = ref<AutosaveSnapshot | null>(null)
const restoring = ref(false)
let stopAutosave: (() => void) | null = null
let resizeStartX = 0
let resizeStartWidth = WORKBENCH_DEFAULT_WIDTH

function loadWorkbenchWidth(): number {
  try {
    const persisted = localStorage.getItem(WORKBENCH_WIDTH_KEY)
    if (persisted === null) return WORKBENCH_DEFAULT_WIDTH
    const stored = Number(persisted)
    return Number.isFinite(stored)
      ? Math.min(WORKBENCH_MAX_WIDTH, Math.max(WORKBENCH_MIN_WIDTH, stored))
      : WORKBENCH_DEFAULT_WIDTH
  } catch {
    return WORKBENCH_DEFAULT_WIDTH
  }
}

function setWorkbenchWidth(width: number) {
  sidePanelWidth.value = Math.min(
    WORKBENCH_MAX_WIDTH,
    Math.max(WORKBENCH_MIN_WIDTH, Math.round(width))
  )
  try {
    localStorage.setItem(WORKBENCH_WIDTH_KEY, String(sidePanelWidth.value))
  } catch {
    // The current width still works for this session.
  }
}

function beginWorkbenchResize(event: PointerEvent) {
  resizeStartX = event.clientX
  resizeStartWidth = sidePanelWidth.value
  window.addEventListener('pointermove', resizeWorkbench)
  window.addEventListener('pointerup', endWorkbenchResize, { once: true })
}

function resizeWorkbench(event: PointerEvent) {
  setWorkbenchWidth(resizeStartWidth + resizeStartX - event.clientX)
}

function endWorkbenchResize() {
  window.removeEventListener('pointermove', resizeWorkbench)
}

function resizeWorkbenchWithKeyboard(event: KeyboardEvent) {
  const step = event.shiftKey ? 40 : 16
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    setWorkbenchWidth(sidePanelWidth.value + step)
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    setWorkbenchWidth(sidePanelWidth.value - step)
  } else if (event.key === 'Home') {
    event.preventDefault()
    setWorkbenchWidth(WORKBENCH_MIN_WIDTH)
  } else if (event.key === 'End') {
    event.preventDefault()
    setWorkbenchWidth(WORKBENCH_MAX_WIDTH)
  }
}

function openDrawingFromAssistant() {
  toolbarRef.value?.triggerOpen()
}

function formatSavedAt(savedAt: number): string {
  try {
    return new Date(savedAt).toLocaleString()
  } catch {
    return ''
  }
}

// The snapshot is the only copy of the user's unsaved work, so it is deleted
// only once the restore has actually succeeded — a failed restore keeps both
// the banner and the stored snapshot so the attempt can be repeated.
async function restoreDrawing() {
  const snapshot = restoreSnapshot.value
  if (!snapshot || restoring.value) return
  restoring.value = true
  try {
    if (!(await viewer.openFromDxfText(snapshot.fileName, snapshot.dxf))) return
    restoreSnapshot.value = null
    clearAutosaveSnapshot()
  } finally {
    restoring.value = false
  }
}

function discardSnapshot() {
  restoreSnapshot.value = null
  clearAutosaveSnapshot()
}

// The CAD view owns global Ctrl/Cmd+Z, Ctrl/Cmd+Y, Delete/Backspace, and
// Escape (see @mlightcad/cad-simple-viewer's key handler) and is already
// focus-aware. This listener only covers the shortcuts the library doesn't:
// Ctrl/Cmd+O, Ctrl/Cmd+S, F2, and Home.
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
    if (viewer.documentOpen) openPageSetup()
  } else if (event.key === 'Home' && viewer.documentOpen) {
    event.preventDefault()
    void viewer.fitDrawing()
  }
}

watch(theme, (mode) => {
  void viewer.setCanvasBackground(CANVAS_BACKGROUND[mode])
})

onMounted(() => {
  if (canvasContainer.value) {
    viewer.init(canvasContainer.value)
    void viewer.setCanvasBackground(CANVAS_BACKGROUND[theme.value])
  }
  window.addEventListener('keydown', onGlobalKeydown)
  window.addEventListener('envcad:open-drawing', openDrawingFromAssistant)
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
  window.removeEventListener('envcad:open-drawing', openDrawingFromAssistant)
  window.removeEventListener('pointermove', resizeWorkbench)
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
      <button :disabled="restoring" @click="restoreDrawing">
        {{ restoring ? 'Restoring…' : 'Restore' }}
      </button>
      <button :disabled="restoring" @click="discardSnapshot">Discard</button>
    </div>
    <div class="main-row">
      <div v-if="layersOpen" class="layers-dock">
        <div class="dock-header">Layers</div>
        <LayersPanel :viewer="viewer" />
      </div>
      <div ref="canvasContainer" class="canvas-host">
        <div
          v-if="!viewer.documentOpen"
          class="canvas-empty-state"
          role="status"
        >
          <strong>No drawing is open.</strong>
          <span>Choose New Drawing or Open.</span>
        </div>
        <button
          class="side-toggle"
          type="button"
          :aria-label="
            sidePanelOpen
              ? 'Hide Assistant Workbench'
              : 'Open Assistant Workbench'
          "
          @click="sidePanelOpen = !sidePanelOpen"
        >
          {{ sidePanelOpen ? '›' : '‹' }}
          <span>{{ sidePanelOpen ? 'Hide AI' : 'Open AI' }}</span>
        </button>
      </div>
      <div
        v-if="sidePanelOpen"
        class="workbench-resizer"
        role="separator"
        aria-label="Resize Assistant Workbench"
        aria-orientation="vertical"
        :aria-valuemin="WORKBENCH_MIN_WIDTH"
        :aria-valuemax="WORKBENCH_MAX_WIDTH"
        :aria-valuenow="sidePanelWidth"
        tabindex="0"
        @pointerdown.prevent="beginWorkbenchResize"
        @keydown="resizeWorkbenchWithKeyboard"
      ></div>
      <div
        v-if="sidePanelOpen"
        class="side-dock"
        role="complementary"
        aria-label="Assistant Workbench"
        :style="{ width: `${sidePanelWidth}px` }"
      >
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
  flex-shrink: 0;
  border-left: 1px solid var(--border-strong);
}

.workbench-resizer {
  width: 7px;
  flex: none;
  cursor: col-resize;
  background: var(--bg-panel);
  border-left: 1px solid var(--border-color);
  border-right: 1px solid var(--border-color);
  touch-action: none;
}

.workbench-resizer:hover,
.workbench-resizer:focus-visible {
  background: var(--accent);
  outline: 2px solid var(--accent);
  outline-offset: -2px;
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

.restore-banner button:hover:not(:disabled) {
  background: var(--bg-button-hover);
}

.restore-banner button:disabled {
  opacity: 0.5;
  cursor: default;
}

.side-toggle {
  position: absolute;
  right: 0;
  top: 8px;
  min-width: 56px;
  height: 32px;
  background: var(--bg-button);
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  border-right: none;
  border-radius: 4px 0 0 4px;
  padding: 0 7px;
  font-size: 0;
  cursor: pointer;
  z-index: 2;
}

.side-toggle span {
  font-size: 12px;
}

.side-toggle:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.canvas-empty-state {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 6px;
  pointer-events: none;
  color: var(--text-muted);
  font-size: 13px;
  text-align: center;
}

.canvas-empty-state strong {
  color: var(--text-secondary);
  font-size: 15px;
}
</style>
