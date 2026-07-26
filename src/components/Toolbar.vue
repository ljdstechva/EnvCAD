<script setup lang="ts">
import { ref } from 'vue'
import type { CadViewerApi } from '../viewer/useCadViewer'
import { openPageSetup } from './sheet/pageSetupUiStore'

const props = defineProps<{
  viewer: CadViewerApi
  layersOpen: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle-layers'): void
}>()

const fileInput = ref<HTMLInputElement | null>(null)

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
    <span class="sep"></span>
    <button @click="viewer.undo()" :disabled="!viewer.canUndo">Undo</button>
    <button @click="viewer.redo()" :disabled="!viewer.canRedo">Redo</button>
    <span class="sep"></span>
    <button @click="viewer.zoomExtents()" :disabled="!viewer.documentOpen">Zoom Extents</button>
    <span class="sep"></span>
    <button :class="{ active: layersOpen }" @click="emit('toggle-layers')">Layers</button>
    <span class="sep"></span>
    <button @click="openPageSetup">Page Setup</button>
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

button:hover:not(:disabled) {
  background: #4a4a4a;
}

button:disabled {
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
</style>
