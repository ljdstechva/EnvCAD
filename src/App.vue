<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Toolbar from './components/Toolbar.vue'
import LayersPanel from './components/LayersPanel.vue'
import SidePanel from './components/SidePanel.vue'
import StatusBar from './components/StatusBar.vue'
import PageSetupDialog from './components/sheet/PageSetupDialog.vue'
import { useCadViewer } from './viewer/useCadViewer'

const viewer = useCadViewer()
const canvasContainer = ref<HTMLDivElement | null>(null)
const layersOpen = ref(false)
const sidePanelOpen = ref(true)

onMounted(() => {
  if (canvasContainer.value) {
    viewer.init(canvasContainer.value)
  }
  // The CAD view owns global Ctrl/Cmd+Z and redo shortcuts. Registering a
  // second application-level listener would apply two undo records per key.
})

function toggleLayers() {
  layersOpen.value = !layersOpen.value
}
</script>

<template>
  <div class="app-shell">
    <Toolbar :viewer="viewer" :layers-open="layersOpen" @toggle-layers="toggleLayers" />
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
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  background: #1e1e1e;
  color: #e0e0e0;
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
  background: #252525;
  border-right: 1px solid #1a1a1a;
  display: flex;
  flex-direction: column;
}

.dock-header {
  padding: 8px 10px;
  font-size: 12px;
  font-weight: 600;
  border-bottom: 1px solid #1a1a1a;
}

.canvas-host {
  flex: 1;
  min-width: 0;
  position: relative;
  background: #1a1a1a;
}

.side-dock {
  width: 280px;
  flex-shrink: 0;
  border-left: 1px solid #1a1a1a;
}

.side-toggle {
  position: absolute;
  right: 0;
  top: 8px;
  width: 18px;
  height: 32px;
  background: #3c3c3c;
  color: #ccc;
  border: 1px solid #4a4a4a;
  border-right: none;
  cursor: pointer;
  z-index: 2;
}
</style>
