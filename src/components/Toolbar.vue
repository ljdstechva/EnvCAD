<script setup lang="ts">
import { ref } from 'vue'
import type { CadViewerApi } from '../viewer/useCadViewer'
import { openPageSetup } from './sheet/pageSetupUiStore'
import { executeCadTool } from '../agent/handlers'

const props = defineProps<{
  viewer: CadViewerApi
  layersOpen: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle-layers'): void
}>()

const fileInput = ref<HTMLInputElement | null>(null)
const csvInput = ref<HTMLInputElement | null>(null)
const geojsonInput = ref<HTMLInputElement | null>(null)
const importMenu = ref<HTMLDetailsElement | null>(null)
const importStatus = ref('')

function onOpenClick() {
  fileInput.value?.click()
}

function onFileChosen(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) {
    props.viewer.openFile(file)
  }
  input.value = ''
}

async function onImportChosen(kind: 'csv' | 'geojson', event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  importStatus.value = `Importing ${file.name}…`
  try {
    const text = await file.text()
    const result = await executeCadTool(
      kind === 'csv' ? 'import_boundary_from_csv' : 'import_boundary_from_geojson',
      kind === 'csv' ? { csvText: text } : { geojsonText: text }
    )
    importMenu.value?.removeAttribute('open')
    if (result.error) {
      importStatus.value = `Import failed: ${result.error}`
      return
    }
    const data = result.data as Record<string, unknown>
    importStatus.value =
      kind === 'csv'
        ? `Imported boundary ${String(data.entityId)} — area ${String(data.area)}, perimeter ${String(data.perimeter)} ${String(data.units)}.`
        : `Imported ${String(data.importedCount)} GeoJSON geometries. CRS reprojection was not performed.`
  } catch (error) {
    importStatus.value = `Import failed: ${error instanceof Error ? error.message : String(error)}`
  }
}
</script>

<template>
  <div class="toolbar">
    <input
      ref="fileInput"
      type="file"
      accept=".dxf,.dwg"
      style="display: none"
      @change="onFileChosen"
    />
    <button @click="onOpenClick">Open</button>
    <button @click="viewer.saveDxf()" :disabled="!viewer.documentOpen">Save DXF</button>
    <details ref="importMenu" class="import-menu">
      <summary
        :class="{ disabled: !viewer.documentOpen }"
        @click="!viewer.documentOpen && $event.preventDefault()"
      >
        Import
      </summary>
      <div class="import-popover">
        <button :disabled="!viewer.documentOpen" @click="csvInput?.click()">CSV boundary</button>
        <button :disabled="!viewer.documentOpen" @click="geojsonInput?.click()">GeoJSON</button>
      </div>
    </details>
    <input
      ref="csvInput"
      type="file"
      accept=".csv,text/csv"
      style="display: none"
      @change="onImportChosen('csv', $event)"
    />
    <input
      ref="geojsonInput"
      type="file"
      accept=".geojson,.json,application/geo+json,application/json"
      style="display: none"
      @change="onImportChosen('geojson', $event)"
    />
    <span class="sep"></span>
    <button @click="viewer.undo()" :disabled="!viewer.canUndo">Undo</button>
    <button @click="viewer.redo()" :disabled="!viewer.canRedo">Redo</button>
    <span class="sep"></span>
    <button @click="viewer.zoomExtents()" :disabled="!viewer.documentOpen">Zoom Extents</button>
    <span class="sep"></span>
    <button :class="{ active: layersOpen }" @click="emit('toggle-layers')">Layers</button>
    <span class="sep"></span>
    <button @click="openPageSetup">Page Setup</button>
    <span v-if="importStatus" class="import-status" role="status">{{ importStatus }}</span>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: #2b2b2b;
  border-bottom: 1px solid #1a1a1a;
  height: 36px;
  flex-shrink: 0;
}

button {
  background: #3c3c3c;
  color: #e0e0e0;
  border: 1px solid #4a4a4a;
  border-radius: 3px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}

summary {
  list-style: none;
  background: #3c3c3c;
  color: #e0e0e0;
  border: 1px solid #4a4a4a;
  border-radius: 3px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}

summary::-webkit-details-marker {
  display: none;
}

button:hover:not(:disabled) {
  background: #4a4a4a;
}

button:disabled,
summary.disabled {
  opacity: 0.4;
  cursor: default;
}

button.active {
  background: #0e639c;
  border-color: #1177bb;
}

.sep {
  width: 1px;
  height: 20px;
  background: #4a4a4a;
  margin: 0 4px;
}

.import-menu {
  position: relative;
}

.import-popover {
  position: absolute;
  z-index: 10;
  top: calc(100% + 4px);
  left: 0;
  min-width: 130px;
  padding: 5px;
  display: grid;
  gap: 4px;
  background: #2b2b2b;
  border: 1px solid #4a4a4a;
  border-radius: 4px;
  box-shadow: 0 4px 12px #0008;
}

.import-popover button {
  text-align: left;
  white-space: nowrap;
}

.import-status {
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #b8d7f0;
  font-size: 11px;
}
</style>
