<script setup lang="ts">
import type { CadViewerApi } from '../viewer/useCadViewer'

defineProps<{
  viewer: CadViewerApi
}>()
</script>

<template>
  <div class="status-bar">
    <template v-if="viewer.documentOpen">
      <span>Units: {{ viewer.drawingUnit }}</span>
      <span class="sep"></span>
      <span>Layer: {{ viewer.currentLayer }}</span>
      <span class="sep"></span>
      <span>{{ viewer.selectionCount }} selected</span>
    </template>
    <span v-else>No document</span>
  </div>
</template>

<style scoped>
.status-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 10px;
  height: 24px;
  background: var(--statusbar-bg);
  color: var(--statusbar-text);
  font-size: 11px;
  flex-shrink: 0;
}

.sep {
  width: 1px;
  height: 14px;
  background: rgba(255, 255, 255, 0.4);
}
</style>
