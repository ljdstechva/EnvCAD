<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { ChatEntry } from './useChatTimeline'
import ToolCallChip from './ToolCallChip.vue'

const props = defineProps<{
  entries: ChatEntry[]
}>()

const scrollEl = ref<HTMLDivElement | null>(null)
const isAtBottom = ref(true)
const BOTTOM_THRESHOLD_PX = 40

function checkAtBottom() {
  const el = scrollEl.value
  if (!el) return
  isAtBottom.value =
    el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX
}

function scrollToBottom(smooth = false) {
  const el = scrollEl.value
  if (!el) return
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  isAtBottom.value = true
}

watch(
  () => props.entries.length,
  () => {
    if (isAtBottom.value) nextTick(() => scrollToBottom())
  }
)

// Streaming text grows an existing entry without changing entries.length.
watch(
  () => props.entries.map((entry) => (entry.kind === 'assistant' ? entry.text.length : 0)).join(','),
  () => {
    if (isAtBottom.value) nextTick(() => scrollToBottom())
  }
)

onMounted(() => nextTick(() => scrollToBottom()))

const showJumpButton = computed(() => !isAtBottom.value)

defineExpose({ scrollToBottom })
</script>

<template>
  <div class="message-list-wrap">
    <div ref="scrollEl" class="message-list" @scroll="checkAtBottom">
      <div v-if="entries.length === 0" class="empty-state">
        Ask the assistant to inspect or edit the drawing. Select entities first if your
        request refers to "these" or "selected".
      </div>
      <template v-for="entry in entries" :key="entry.id">
        <div v-if="entry.kind === 'user'" class="bubble-row user">
          <div class="bubble user">
            <div class="bubble-text">{{ entry.text }}</div>
            <div v-if="entry.attachedCount" class="attach-note">
              {{ entry.attachedCount }} object{{ entry.attachedCount === 1 ? '' : 's' }} attached
            </div>
          </div>
        </div>
        <div v-else-if="entry.kind === 'assistant'" class="bubble-row assistant">
          <div class="bubble assistant">
            <div class="bubble-text">{{ entry.text }}<span v-if="entry.streaming" class="caret"></span></div>
          </div>
        </div>
        <div v-else-if="entry.kind === 'tool'" class="bubble-row assistant">
          <ToolCallChip :entry="entry" />
        </div>
        <div v-else class="bubble-row assistant">
          <div class="bubble error">{{ entry.message }}</div>
        </div>
      </template>
    </div>
    <button v-if="showJumpButton" class="jump-to-bottom" @click="scrollToBottom(true)">
      ↓ New messages
    </button>
  </div>
</template>

<style scoped>
.message-list-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}

.message-list {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.empty-state {
  color: #888;
  font-style: italic;
  padding: 16px 4px;
  font-size: 12px;
  line-height: 1.5;
}

.bubble-row {
  display: flex;
}

.bubble-row.user {
  justify-content: flex-end;
}

.bubble-row.assistant {
  justify-content: flex-start;
}

.bubble {
  max-width: 92%;
  border-radius: 8px;
  padding: 7px 10px;
  font-size: 12px;
  line-height: 1.5;
}

.bubble-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.bubble.user {
  background: #0e639c;
  color: #ffffff;
  border-bottom-right-radius: 2px;
}

.bubble.assistant {
  background: #333333;
  color: #e0e0e0;
  border-bottom-left-radius: 2px;
}

.bubble.error {
  background: #4a1414;
  color: #f0a0a0;
  border: 1px solid #6a1c1c;
}

.attach-note {
  margin-top: 4px;
  font-size: 10px;
  color: #cfe6f7;
  opacity: 0.85;
}

.caret {
  display: inline-block;
  width: 6px;
  height: 12px;
  margin-left: 2px;
  background: #9ac6e6;
  vertical-align: text-bottom;
  animation: blink 0.9s steps(1) infinite;
}

@keyframes blink {
  50% { opacity: 0; }
}

.jump-to-bottom {
  position: absolute;
  bottom: 10px;
  left: 50%;
  transform: translateX(-50%);
  background: #0e639c;
  color: #fff;
  border: none;
  border-radius: 12px;
  padding: 5px 12px;
  font-size: 11px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}

.jump-to-bottom:hover {
  background: #1177bb;
}
</style>
