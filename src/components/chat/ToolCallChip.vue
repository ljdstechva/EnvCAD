<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ChatToolEntry } from './useChatTimeline'

const props = defineProps<{
  entry: ChatToolEntry
}>()

const expanded = ref(false)

const status = computed<'pending' | 'ok' | 'error'>(() => {
  if (!props.entry.result) return 'pending'
  return props.entry.result.error ? 'error' : 'ok'
})

const inputSummary = computed(() => summarize(props.entry.input))

const affectedIds = computed<string[]>(() => {
  const data = props.entry.result?.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return []
  const record = data as Record<string, unknown>
  const ids = record.entityIds
  if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) return ids as string[]
  return []
})

function summarize(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? 'null'
  } catch {
    text = String(value)
  }
  return text.length > 90 ? `${text.slice(0, 90)}…` : text
}
</script>

<template>
  <div class="tool-chip" :class="status">
    <button class="chip-header" @click="expanded = !expanded">
      <span class="status-dot" :class="status"></span>
      <span class="tool-name">{{ entry.name }}</span>
      <span class="tool-input">{{ inputSummary }}</span>
      <span class="chevron" :class="{ open: expanded }">›</span>
    </button>
    <div v-if="affectedIds.length" class="affected-ids">
      <span class="affected-label">entities:</span>
      <span class="id-pill" v-for="id in affectedIds" :key="id">{{ id }}</span>
    </div>
    <div v-if="status === 'error'" class="tool-error">{{ entry.result?.error }}</div>
    <div v-if="expanded" class="tool-details">
      <div class="detail-block">
        <div class="detail-label">Input</div>
        <pre>{{ JSON.stringify(entry.input, null, 2) }}</pre>
      </div>
      <div v-if="entry.result" class="detail-block">
        <div class="detail-label">Result</div>
        <pre>{{ JSON.stringify(entry.result, null, 2) }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-chip {
  border: 1px solid #3c3c3c;
  border-radius: 6px;
  background: #2a2a2a;
  font-size: 11px;
  overflow: hidden;
  max-width: 100%;
}

.tool-chip.error {
  border-color: #6a2626;
}

.chip-header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  background: transparent;
  border: none;
  color: #d0d0d0;
  padding: 6px 8px;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  font-size: inherit;
}

.chip-header:hover {
  background: #333333;
}

.status-dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #666;
}

.status-dot.pending {
  background: #d9a441;
  animation: pulse 1.1s ease-in-out infinite;
}

.status-dot.ok {
  background: #4caf50;
}

.status-dot.error {
  background: #e05a5a;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.tool-name {
  flex-shrink: 0;
  font-weight: 600;
  color: #7fb8e6;
}

.tool-input {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #999;
}

.chevron {
  flex-shrink: 0;
  color: #888;
  transition: transform 0.12s ease;
}

.chevron.open {
  transform: rotate(90deg);
}

.affected-ids {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 8px 6px 8px;
}

.affected-label {
  color: #888;
}

.id-pill {
  background: #1e3a4a;
  color: #8fd0ff;
  border-radius: 3px;
  padding: 1px 5px;
  font-family: ui-monospace, 'SFMono-Regular', Consolas, monospace;
  font-size: 10px;
}

.tool-error {
  padding: 0 8px 6px 8px;
  color: #f0a0a0;
}

.tool-details {
  border-top: 1px solid #3c3c3c;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.detail-label {
  color: #888;
  margin-bottom: 2px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.tool-details pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  background: #1a1a1a;
  border-radius: 4px;
  padding: 6px;
  color: #c8c8c8;
  font-family: ui-monospace, 'SFMono-Regular', Consolas, monospace;
  font-size: 10px;
  max-height: 220px;
  overflow: auto;
}
</style>
