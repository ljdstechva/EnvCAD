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
const chatPanel = ref<InstanceType<typeof ChatPanel> | null>(null)

async function inspectSheetWithAi(): Promise<boolean> {
  const sent = chatPanel.value
    ? await chatPanel.value.sendMessage(
        'Inspect the current Sheet Preview. State whether it is blank, clipped, unreadable, low-contrast, or overlapping, and describe only what you can actually see.'
      )
    : false
  if (sent) activeTab.value = 'ai'
  return sent
}
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
      <ChatPanel
        v-show="activeTab === 'ai'"
        ref="chatPanel"
        :viewer="props.viewer"
      />
      <SheetPreviewPanel
        v-show="activeTab === 'sheet'"
        :inspect-with-ai="inspectSheetWithAi"
      />
    </div>
  </div>
</template>

<style scoped>
.side-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  background: var(--bg-panel);
}

.tab-bar {
  display: flex;
  border-bottom: 1px solid var(--border-strong);
  flex-shrink: 0;
}

.tab-bar button {
  flex: 1;
  background: transparent;
  color: var(--text-secondary);
  border: none;
  padding: 8px 6px;
  font-size: 12px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}

.tab-bar button.active {
  color: var(--text-primary);
  border-bottom-color: var(--accent);
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
