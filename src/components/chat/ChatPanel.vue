<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import { agentBridge } from '../../agent/bridge'
import type { CadViewerApi } from '../../viewer/useCadViewer'
import { useChatTimeline } from './useChatTimeline'
import ChatMessageList from './ChatMessageList.vue'
import ChatInput from './ChatInput.vue'

const props = defineProps<{
  viewer: CadViewerApi
}>()

const { entries, sendMessage, interrupt, resetChat, dispose } = useChatTimeline()

onBeforeUnmount(dispose)

const bridgeState = agentBridge.state
const isOffline = computed(() => bridgeState.connectionState !== 'online')
const isStreaming = computed(() => bridgeState.status === 'thinking')

function onSend(text: string) {
  sendMessage(text)
}

function onNewChat() {
  if (entries.value.length === 0) return
  if (window.confirm('Start a new chat? This clears the current conversation.')) {
    resetChat()
  }
}
</script>

<template>
  <div class="chat-panel">
    <div v-if="isOffline" class="offline-banner">
      Assistant offline — sidecar not running (npm run dev starts it)
    </div>

    <div class="chat-toolbar">
      <span class="status-text">
        {{ isOffline ? 'Offline' : isStreaming ? 'Thinking…' : 'Idle' }}
      </span>
      <span class="grow"></span>
      <button v-if="isStreaming" class="stop-btn" @click="interrupt">Stop</button>
      <button class="new-chat-btn" :disabled="entries.length === 0" @click="onNewChat">New chat</button>
    </div>

    <ChatMessageList :entries="entries" />

    <ChatInput
      :disabled="isOffline"
      :selection-count="props.viewer.selectionCount"
      @send="onSend"
    />
  </div>
</template>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  min-height: 0;
}

.offline-banner {
  flex-shrink: 0;
  background: #4a3b12;
  color: #f0d080;
  border-bottom: 1px solid #6a551c;
  padding: 6px 10px;
  font-size: 11px;
  line-height: 1.4;
}

.chat-toolbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid #1a1a1a;
}

.status-text {
  font-size: 11px;
  color: #999;
}

.grow {
  flex: 1;
}

.stop-btn,
.new-chat-btn {
  background: #3c3c3c;
  color: #e0e0e0;
  border: 1px solid #4a4a4a;
  border-radius: 3px;
  padding: 4px 9px;
  font-size: 11px;
  cursor: pointer;
}

.stop-btn:hover,
.new-chat-btn:hover:not(:disabled) {
  background: #4a4a4a;
}

.stop-btn {
  background: #6a2626;
  border-color: #8a3232;
}

.stop-btn:hover {
  background: #8a3232;
}

.new-chat-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
