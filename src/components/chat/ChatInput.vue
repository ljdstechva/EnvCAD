<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  disabled: boolean
  selectionCount: number
  onSend: (text: string) => boolean
}>()

const text = ref('')
const textareaEl = ref<HTMLTextAreaElement | null>(null)

function submit() {
  if (props.disabled) return
  const value = text.value
  if (!value.trim()) return
  if (props.onSend(value)) text.value = ''
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    submit()
  }
}
</script>

<template>
  <div class="chat-input-area">
    <div v-if="selectionCount > 0" class="selection-chip">
      {{ selectionCount }} object{{ selectionCount === 1 ? '' : 's' }} will be attached
    </div>
    <div class="input-row">
      <textarea
        ref="textareaEl"
        v-model="text"
        class="chat-textarea"
        rows="2"
        :disabled="disabled"
        :placeholder="disabled ? 'Assistant offline' : 'Message the assistant… (Enter to send, Shift+Enter for newline)'"
        @keydown="onKeydown"
      ></textarea>
      <button class="send-btn" :disabled="disabled || !text.trim()" @click="submit">Send</button>
    </div>
  </div>
</template>

<style scoped>
.chat-input-area {
  flex-shrink: 0;
  border-top: 1px solid var(--border-strong);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.selection-chip {
  align-self: flex-start;
  background: var(--info-bg);
  color: var(--info-text);
  border-radius: 10px;
  padding: 3px 9px;
  font-size: 11px;
}

.input-row {
  display: flex;
  gap: 6px;
  align-items: flex-end;
}

.chat-textarea {
  flex: 1;
  min-width: 0;
  resize: vertical;
  background: var(--bg-input);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 6px 8px;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.4;
}

.chat-textarea:focus {
  outline: none;
  border-color: var(--accent);
}

.chat-textarea:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.send-btn {
  flex-shrink: 0;
  background: var(--accent);
  color: #fff;
  border: 1px solid var(--accent-border);
  border-radius: 4px;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
}

.send-btn:hover:not(:disabled) {
  background: var(--accent-border);
}

.send-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
