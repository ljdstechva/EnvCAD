<script setup lang="ts">
import { ref } from 'vue'
import SheetPreviewPanel from './sheet/SheetPreviewPanel.vue'
import ChatPanel from './chat/ChatPanel.vue'
import type { CadViewerApi } from '../viewer/useCadViewer'

const props = defineProps<{
  viewer: CadViewerApi
}>()

type TabId = 'ai' | 'sheet'

const activeTab = ref<TabId>('ai')
</script>

<template>
  <div class="side-panel">
    <div class="tab-bar">
      <button :class="{ active: activeTab === 'ai' }" @click="activeTab = 'ai'">
        AI Assistant
      </button>
      <button :class="{ active: activeTab === 'sheet' }" @click="activeTab = 'sheet'">
        Sheet Preview
      </button>
    </div>
    <div class="tab-content" :class="{ chat: activeTab === 'ai' }">
      <ChatPanel v-if="activeTab === 'ai'" :viewer="props.viewer" />
      <SheetPreviewPanel v-else />
    </div>
  </div>
</template>

<style scoped>
.side-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  background: #252525;
}

.tab-bar {
  display: flex;
  border-bottom: 1px solid #1a1a1a;
  flex-shrink: 0;
}

.tab-bar button {
  flex: 1;
  background: transparent;
  color: #b0b0b0;
  border: none;
  padding: 8px 6px;
  font-size: 12px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}

.tab-bar button.active {
  color: #ffffff;
  border-bottom-color: #0e639c;
}

.tab-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.tab-content.chat {
  overflow: hidden;
}
</style>
