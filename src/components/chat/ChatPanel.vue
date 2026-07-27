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
const offlineMessage = computed(
  () =>
    bridgeState.offlineReason ||
    'Assistant offline — sidecar not running (npm run dev starts it)'
)
const canOpenLogs = Boolean(window.envcadDesktop)

function onSend(text: string) {
  sendMessage(text)
}

function onNewChat() {
  if (entries.value.length === 0) return
  if (window.confirm('Start a new chat? This clears the current conversation.')) {
    resetChat()
  }
}

function openLogs() {
  void window.envcadDesktop?.openLogFolder()
}
</script>

<template>
  <div class="chat-panel">
    <div v-if="isOffline" class="offline-banner">
      <span>{{ offlineMessage }}</span>
      <button v-if="canOpenLogs" type="button" @click="openLogs">Open logs</button>
    </div>

    <div class="chat-toolbar">
      <span class="status-text">
        {{
          bridgeState.connectionState === 'connecting'
            ? 'Connecting…'
            : isOffline
              ? 'Offline'
              : isStreaming
                ? 'Thinking…'
                : 'Idle'
        }}
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
  background: var(--warn-bg);
  color: var(--warn-text);
  border-bottom: 1px solid var(--warn-border);
  padding: 6px 10px;
  font-size: 11px;
  line-height: 1.4;
  display: flex;
  align-items: center;
  gap: 8px;
}

.offline-banner span {
  flex: 1;
}

.offline-banner button {
  flex: none;
  border: 1px solid var(--warn-border);
  border-radius: 3px;
  background: var(--bg-button);
  color: var(--text-primary);
  padding: 3px 7px;
  font-size: 10px;
  cursor: pointer;
}

.chat-toolbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-strong);
}

.status-text {
  font-size: 11px;
  color: var(--text-muted);
}

.grow {
  flex: 1;
}

.stop-btn,
.new-chat-btn {
  background: var(--bg-button);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: 3px;
  padding: 4px 9px;
  font-size: 11px;
  cursor: pointer;
}

.stop-btn:hover,
.new-chat-btn:hover:not(:disabled) {
  background: var(--bg-button-hover);
}

.stop-btn {
  background: var(--danger-bg);
  border-color: var(--danger-border);
}

.stop-btn:hover {
  background: var(--danger-bg-hover);
}

.new-chat-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
