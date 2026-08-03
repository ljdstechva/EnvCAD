<script setup lang="ts">
import { ref, watch } from 'vue'
import type { InputReference } from '../../../shared/agent-contracts'

const props = defineProps<{
  disabled: boolean
  queueing: boolean
  selectionCount: number
  initialDraft: string
  onDraftChange: (text: string) => boolean
  onAttach: (file: File) => Promise<InputReference>
  onDeleteAttachment: (inputId: string) => Promise<void>
  onSend: (text: string, attachments?: InputReference[]) => Promise<boolean>
}>()

const text = ref(props.initialDraft)
const submitting = ref(false)
const attaching = ref(false)
const attachments = ref<InputReference[]>([])
const statusMessage = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

watch(text, (value) => {
  if (!props.onDraftChange(value)) {
    statusMessage.value =
      'This draft is still in the composer, but local persistence is full. Free disk space before closing EnvCAD.'
  } else if (statusMessage.value.includes('local persistence is full')) {
    statusMessage.value = ''
  }
})

async function submit() {
  if (props.disabled || submitting.value) return
  const value = text.value
  if (!value.trim()) return
  submitting.value = true
  statusMessage.value = ''
  try {
    if (await props.onSend(value, attachments.value)) {
      text.value = ''
      attachments.value = []
      statusMessage.value = props.queueing
        ? 'Follow-up preserved in the queue.'
        : ''
    }
  } finally {
    submitting.value = false
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void submit()
  }
}

async function onFilesSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  if (files.length === 0) return
  attaching.value = true
  statusMessage.value = 'Preserving attachment locally...'
  try {
    for (const file of files) {
      const reference = await props.onAttach(file)
      if (
        !attachments.value.some(
          (attachment) => attachment.inputId === reference.inputId
        )
      ) {
        attachments.value.push(reference)
      }
    }
    statusMessage.value =
      `${files.length} attachment${files.length === 1 ? '' : 's'} ` +
      'stored locally and ready to reference.'
  } catch (error) {
    statusMessage.value =
      error instanceof Error ? error.message : 'The attachment could not be stored.'
  } finally {
    attaching.value = false
  }
}

async function deleteAttachment(attachment: InputReference) {
  statusMessage.value = 'Deleting the local attachment copy...'
  try {
    await props.onDeleteAttachment(attachment.inputId)
    attachments.value = attachments.value.filter(
      (item) => item.inputId !== attachment.inputId
    )
    statusMessage.value = 'Local attachment copy deleted.'
  } catch (error) {
    statusMessage.value =
      error instanceof Error ? error.message : 'The attachment could not be deleted.'
  }
}
</script>

<template>
  <div class="chat-input-area">
    <div v-if="selectionCount > 0" class="selection-chip">
      {{ selectionCount }} object{{ selectionCount === 1 ? '' : 's' }}
      selected and frozen for this message
    </div>
    <div v-else class="selection-hint">
      Selection optional. Conversation works without an open drawing.
    </div>

    <ul v-if="attachments.length" class="attachment-list" aria-label="Attachments">
      <li v-for="attachment in attachments" :key="attachment.inputId">
        <span>
          {{ attachment.sourceName || 'Local text reference' }} ·
          {{ attachment.byteLength.toLocaleString() }} bytes
        </span>
        <button
          type="button"
          :aria-label="`Delete local copy of ${attachment.sourceName || 'attachment'}`"
          @click="deleteAttachment(attachment)"
        >
          Delete local copy
        </button>
      </li>
    </ul>

    <div class="input-row">
      <textarea
        v-model="text"
        class="chat-textarea"
        rows="3"
        aria-label="Assistant message"
        placeholder="Message the assistant... (Enter to send, Shift+Enter for newline)"
        @keydown="onKeydown"
      ></textarea>
      <div class="composer-actions">
        <input
          ref="fileInput"
          class="visually-hidden"
          type="file"
          multiple
          accept=".txt,.md,.csv,.json,.geojson,.dxf,text/*,application/json"
          @change="onFilesSelected"
        />
        <button
          class="attach-btn"
          type="button"
          :disabled="attaching"
          @click="fileInput?.click()"
        >
          {{ attaching ? 'Attaching...' : 'Attach text' }}
        </button>
        <button
          class="send-btn"
          type="button"
          :disabled="disabled || submitting || attaching || !text.trim()"
          @click="submit"
        >
          {{
            submitting
              ? 'Preserving...'
              : queueing
                ? 'Queue follow-up'
                : 'Send'
          }}
        </button>
      </div>
    </div>
    <p v-if="statusMessage" class="composer-status" role="status">
      {{ statusMessage }}
    </p>
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
  font-size: 12px;
}

.selection-hint,
.composer-status {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
}

.input-row {
  display: flex;
  gap: 6px;
  align-items: stretch;
}

.chat-textarea {
  flex: 1;
  min-width: 0;
  max-height: 180px;
  resize: vertical;
  background: var(--bg-input);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 7px 8px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.45;
}

.composer-actions {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 5px;
}

.attach-btn,
.send-btn,
.attachment-list button {
  flex-shrink: 0;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 6px 10px;
  color: var(--text-primary);
  background: var(--bg-button);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.send-btn {
  color: #fff;
  background: var(--accent);
  border-color: var(--accent-border);
}

.attach-btn:hover:not(:disabled),
.attachment-list button:hover:not(:disabled) {
  background: var(--bg-button-hover);
}

.send-btn:hover:not(:disabled) {
  background: var(--accent-border);
}

button:disabled {
  opacity: 0.55;
  cursor: default;
}

.chat-textarea:focus-visible,
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.attachment-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.attachment-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 4px 6px;
  font-size: 12px;
}

.attachment-list span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-list button {
  padding: 3px 6px;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 380px) {
  .input-row {
    flex-direction: column;
  }

  .composer-actions {
    flex-direction: row;
  }
}
</style>
