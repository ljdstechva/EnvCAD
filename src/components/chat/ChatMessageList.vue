<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { RecoveryActionKind } from '../../../shared/agent-contracts'
import type { ChatEntry } from './useChatTimeline'
import ToolCallChip from './ToolCallChip.vue'
import TurnActivityCard from './TurnActivityCard.vue'

const props = defineProps<{
  entries: ChatEntry[]
}>()
const emit = defineEmits<{
  recoveryAction: [kind: RecoveryActionKind]
}>()

const scrollEl = ref<HTMLDivElement | null>(null)
const isAtBottom = ref(true)
const windowStart = ref(0)
const BOTTOM_THRESHOLD_PX = 40
const WINDOW_SIZE = 250
const visibleEntries = computed(() => props.entries.slice(windowStart.value))
const hiddenCount = computed(() => windowStart.value)

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
  (length, previousLength) => {
    if (isAtBottom.value) {
      windowStart.value = Math.max(0, length - WINDOW_SIZE)
      nextTick(() => scrollToBottom())
    } else if (length < previousLength) {
      windowStart.value = Math.max(0, length - WINDOW_SIZE)
    }
  }
)

// Streaming text grows an existing entry without changing entries.length.
watch(
  () => {
    const last = props.entries.at(-1)
    return last?.kind === 'assistant' ? last.text.length : 0
  },
  () => {
    if (isAtBottom.value) nextTick(() => scrollToBottom())
  }
)

watch(
  () => {
    const last = props.entries.at(-1)
    return last?.kind === 'activity' &&
      last.activity === 'terminal' &&
      last.terminal?.phase === 'failed'
      ? last.id
      : undefined
  },
  (failedId) => {
    if (!failedId) return
    nextTick(() => {
      scrollEl.value
        ?.querySelector<HTMLElement>('[data-recovery-card="true"]')
        ?.focus()
    })
  }
)

onMounted(() => {
  windowStart.value = Math.max(0, props.entries.length - WINDOW_SIZE)
  nextTick(() => scrollToBottom())
})

const showJumpButton = computed(() => !isAtBottom.value)

function loadEarlier() {
  windowStart.value = Math.max(0, windowStart.value - WINDOW_SIZE)
  nextTick(() => {
    const el = scrollEl.value
    if (el) el.scrollTop = 1
  })
}

function providerName(provider: string | undefined): string {
  if (provider === 'claude-code') return 'Claude Code'
  if (provider === 'openai-codex') return 'OpenAI Codex'
  return provider ?? 'AI'
}

function roundedMetric(value: number | undefined): string {
  return value === undefined ? 'n/a' : `${Math.round(value)} ms`
}

function metricsTitle(entry: Extract<ChatEntry, { kind: 'assistant' }>): string {
  const metrics = entry.metrics
  if (!metrics) return ''
  return [
    `Provider ready: ${roundedMetric(metrics.providerReadyMs)}`,
    `Conversation startup: ${roundedMetric(metrics.conversationStartupMs)}`,
    `First text: ${roundedMetric(metrics.firstTextMs)}`,
    `First tool call: ${roundedMetric(metrics.firstToolCallMs)}`,
    `Total: ${roundedMetric(metrics.totalMs)}`,
    `Tool calls: ${metrics.toolCalls}`,
    `Retries: ${metrics.retries ?? 0}`,
    `Input tokens: ${metrics.inputTokens ?? 'not reported'}`,
    `Output tokens: ${metrics.outputTokens ?? 'not reported'}`
  ].join('\n')
}

defineExpose({ scrollToBottom })
</script>

<template>
  <div class="message-list-wrap">
    <div
      ref="scrollEl"
      class="message-list"
      role="log"
      aria-label="Assistant conversation"
      aria-live="polite"
      aria-relevant="additions text"
      @scroll="checkAtBottom"
    >
      <div v-if="entries.length === 0" class="empty-state">
        Ask a question at any time. Open a drawing only when you want the
        assistant to inspect or edit CAD content.
      </div>
      <button
        v-if="hiddenCount > 0"
        class="load-earlier"
        type="button"
        @click="loadEarlier"
      >
        Load {{ Math.min(WINDOW_SIZE, hiddenCount) }} earlier events
        ({{ hiddenCount.toLocaleString() }} hidden)
      </button>
      <template v-for="entry in visibleEntries" :key="entry.id">
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
            <div v-if="entry.provider && entry.model" class="response-meta">
              <span>{{ providerName(entry.provider) }}</span>
              <span
                :title="
                  entry.resolvedModel
                    ? `Resolved model: ${entry.resolvedModel}`
                    : 'Provider-reported model'
                "
              >
                {{ entry.model }}
              </span>
              <span>{{ entry.effort || 'Default' }}</span>
              <span
                v-if="entry.metrics"
                class="turn-metrics"
                :title="metricsTitle(entry)"
                :data-provider-ready-ms="entry.metrics.providerReadyMs"
                :data-conversation-startup-ms="
                  entry.metrics.conversationStartupMs
                "
                :data-first-text-ms="entry.metrics.firstTextMs"
                :data-first-tool-call-ms="entry.metrics.firstToolCallMs"
                :data-total-ms="entry.metrics.totalMs"
                :data-tool-calls="entry.metrics.toolCalls"
                :data-retries="entry.metrics.retries || 0"
                :data-input-tokens="entry.metrics.inputTokens"
                :data-output-tokens="entry.metrics.outputTokens"
              >
                {{ Math.round(entry.metrics.totalMs) }} ms ·
                {{ entry.metrics.toolCalls }} tool{{
                  entry.metrics.toolCalls === 1 ? '' : 's'
                }}
              </span>
            </div>
            <div class="bubble-text">{{ entry.text }}<span v-if="entry.streaming" class="caret"></span></div>
          </div>
        </div>
        <div v-else-if="entry.kind === 'tool'" class="bubble-row assistant">
          <ToolCallChip :entry="entry" />
        </div>
        <div v-else-if="entry.kind === 'activity'" class="bubble-row assistant">
          <TurnActivityCard
            :entry="entry"
            @action="emit('recoveryAction', $event)"
          />
        </div>
        <div v-else-if="entry.kind === 'boundary'" class="conversation-boundary">
          <span>New conversation</span>
          <small>{{ entry.label }}</small>
        </div>
        <div v-else class="bubble-row assistant">
          <div class="bubble error">{{ entry.message }}</div>
        </div>
      </template>
    </div>
    <button
      v-if="showJumpButton"
      class="jump-to-bottom"
      type="button"
      aria-label="Jump to new messages"
      @click="scrollToBottom(true)"
    >
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
  color: var(--text-muted);
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
  background: var(--accent);
  color: #ffffff;
  border-bottom-right-radius: 2px;
}

.bubble.assistant {
  background: var(--bg-button);
  color: var(--text-primary);
  border-bottom-left-radius: 2px;
}

.response-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 5px;
}

.response-meta span {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 1px 5px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.3;
}

.conversation-boundary {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: 12px;
}

.conversation-boundary::before,
.conversation-boundary::after {
  content: '';
  flex: 1;
  border-top: 1px solid var(--border-color);
}

.conversation-boundary small {
  max-width: 48%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.bubble.error {
  background: var(--error-bg);
  color: var(--error-text);
  border: 1px solid var(--error-border);
}

.attach-note {
  margin-top: 4px;
  font-size: 12px;
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
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 12px;
  padding: 5px 12px;
  font-size: 12px;
  cursor: pointer;
  box-shadow: 0 2px 8px var(--shadow-color);
}

.jump-to-bottom:hover {
  background: var(--accent-border);
}

.load-earlier {
  align-self: center;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  background: var(--bg-button);
  color: var(--text-primary);
  padding: 5px 10px;
  font: inherit;
  cursor: pointer;
}

.load-earlier:focus-visible,
.jump-to-bottom:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .caret {
    animation: none;
  }
}
</style>
