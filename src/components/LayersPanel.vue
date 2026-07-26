<script setup lang="ts">
import type { CadViewerApi } from '../viewer/useCadViewer'

const props = defineProps<{
  viewer: CadViewerApi
}>()
</script>

<template>
  <div class="layers-panel">
    <div v-if="viewer.layers.length === 0" class="empty">No layers loaded</div>
    <div v-for="layer in viewer.layers" :key="layer.name" class="layer-row">
      <input
        type="checkbox"
        :checked="!layer.isOff"
        @change="props.viewer.toggleLayer(layer.name)"
      />
      <span class="swatch" :style="{ backgroundColor: layer.colorCss }"></span>
      <span class="name">{{ layer.name }}</span>
    </div>
  </div>
</template>

<style scoped>
.layers-panel {
  padding: 8px;
  overflow-y: auto;
  height: 100%;
}

.empty {
  color: #888;
  font-style: italic;
  padding: 8px;
}

.layer-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 4px;
}

.layer-row:hover {
  background: #333;
}

.swatch {
  width: 12px;
  height: 12px;
  border: 1px solid #555;
  flex-shrink: 0;
}

.name {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
