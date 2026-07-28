<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import { agentBridge } from '../../agent/bridge'
import type {
  EffortCapability,
  ModelCapability,
  ProviderId
} from '../../agent/protocol'
import type { CadViewerApi } from '../../viewer/useCadViewer'
import { useChatTimeline } from './useChatTimeline'
import ChatMessageList from './ChatMessageList.vue'
import ChatInput from './ChatInput.vue'

const props = defineProps<{
  viewer: CadViewerApi
}>()

const { entries, sendMessage, interrupt, resetChat, dispose } =
  useChatTimeline()

onBeforeUnmount(dispose)

const bridgeState = agentBridge.state
const isOffline = computed(() => bridgeState.connectionState !== 'online')
const isStreaming = computed(() => bridgeState.status === 'thinking')
const selectedProvider = computed(() =>
  agentBridge.selectedProviderCapability()
)
const selectedModel = computed(() => agentBridge.selectedModelCapability())
const modelOptions = computed(() => selectedProvider.value?.models ?? [])
const effortOptions = computed(
  () => selectedModel.value?.supportedEfforts ?? []
)
const configurationPending = computed(
  () => bridgeState.pendingRevision !== undefined
)
const inputDisabled = computed(
  () =>
    isOffline.value ||
    isStreaming.value ||
    bridgeState.refreshingCapabilities ||
    !bridgeState.configurationReady
)
const providerStatusClass = computed(() => {
  const status = selectedProvider.value?.status
  return status === 'ready'
    ? 'ready'
    : status === 'checking'
      ? 'checking'
      : 'unavailable'
})
const providerMessage = computed(() => {
  if (configurationPending.value) {
    return 'Confirming the selected AI configuration...'
  }
  if (bridgeState.configurationError) return bridgeState.configurationError
  return (
    selectedProvider.value?.statusMessage ??
    'Checking provider availability...'
  )
})
const nextPromptCompany = computed(
  () => selectedProvider.value?.displayName ?? 'the selected provider'
)
const offlineMessage = computed(
  () =>
    bridgeState.offlineReason ||
    'Assistant offline - sidecar not running (npm run dev starts it)'
)
const canOpenLogs = Boolean(window.envcadDesktop)

function onSend(text: string) {
  return sendMessage(text)
}

function onNewChat() {
  if (!bridgeState.configurationReady || isStreaming.value) return
  if (
    window.confirm(
      'Start a new chat? This clears the current conversation.'
    )
  ) {
    resetChat()
  }
}

function onProviderChange(event: Event) {
  agentBridge.selectProvider(
    (event.target as HTMLSelectElement).value as ProviderId
  )
}

function onModelChange(event: Event) {
  agentBridge.selectModel((event.target as HTMLSelectElement).value)
}

function onEffortChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  agentBridge.selectEffort(value || undefined)
}

function recommendedForSelectedProvider() {
  return bridgeState.recommendedConfigurations?.[
    bridgeState.selectedProvider
  ]
}

function isRecommendedModel(model: ModelCapability): boolean {
  const recommendation = recommendedForSelectedProvider()
  return Boolean(
    recommendation &&
      (recommendation.model === model.id ||
        recommendation.model === model.invocationName)
  )
}

function isRecommendedEffort(
  effort: EffortCapability | undefined
): boolean {
  const recommendation = recommendedForSelectedProvider()
  const model = selectedModel.value
  if (
    !recommendation ||
    !model ||
    (recommendation.model !== model.id &&
      recommendation.model !== model.invocationName)
  ) {
    return false
  }
  return effort
    ? recommendation.effort === effort.value
    : recommendation.effort === undefined
}

function refreshCapabilities() {
  agentBridge.refreshCapabilities()
}

function openLogs() {
  void window.envcadDesktop?.openLogFolder()
}
</script>

<template>
  <div class="chat-panel">
    <div v-if="isOffline" class="offline-banner">
      <span>{{ offlineMessage }}</span>
      <button v-if="canOpenLogs" type="button" @click="openLogs">
        Open logs
      </button>
    </div>

    <div class="ai-selector" aria-label="AI provider configuration">
      <label class="selector-field">
        <span>Provider</span>
        <select
          :value="bridgeState.selectedProvider"
          :disabled="
            isStreaming ||
            configurationPending ||
            bridgeState.refreshingCapabilities
          "
          aria-label="AI provider"
          @change="onProviderChange"
        >
          <option
            v-for="provider in bridgeState.providers"
            :key="provider.id"
            :value="provider.id"
            :data-status="provider.status"
            :data-version="provider.executableVersion"
            :data-discovery-ms="provider.discoveryMs"
          >
            {{ provider.displayName }}
          </option>
        </select>
      </label>

      <label class="selector-field">
        <span>Model</span>
        <select
          :value="bridgeState.selectedModelId"
          :disabled="
            isStreaming ||
            configurationPending ||
            bridgeState.refreshingCapabilities ||
            selectedProvider?.status !== 'ready' ||
            modelOptions.length === 0
          "
          :title="selectedModel?.description || providerMessage"
          aria-label="AI model"
          @change="onModelChange"
        >
          <option
            v-for="model in modelOptions"
            :key="model.id"
            :value="model.id"
            :title="model.description"
            :data-invocation-name="model.invocationName"
            :data-resolved-model="model.resolvedModel"
            :data-default-effort="model.defaultEffort"
            :data-is-default="model.isDefault"
          >
            {{ model.displayName
            }}{{ isRecommendedModel(model) ? ' · Recommended' : '' }}
          </option>
        </select>
      </label>

      <label class="selector-field effort-field">
        <span>Effort</span>
        <select
          :value="bridgeState.selectedEffort || ''"
          :disabled="
            isStreaming ||
            configurationPending ||
            bridgeState.refreshingCapabilities ||
            selectedProvider?.status !== 'ready' ||
            !selectedModel
          "
          :title="
            effortOptions.find(
              (effort) => effort.value === bridgeState.selectedEffort
            )?.description || 'Use the provider-reported default effort'
          "
          aria-label="Reasoning effort"
          @change="onEffortChange"
        >
          <option value="">
            Default{{ isRecommendedEffort(undefined) ? ' · Recommended' : '' }}
          </option>
          <option
            v-for="effort in effortOptions"
            :key="effort.value"
            :value="effort.value"
            :title="effort.description"
            :data-is-default="effort.isDefault"
          >
            {{ effort.displayName
            }}{{ isRecommendedEffort(effort) ? ' · Recommended' : '' }}
          </option>
        </select>
      </label>

      <button
        class="refresh-btn"
        type="button"
        :disabled="
          isStreaming ||
          configurationPending ||
          isOffline ||
          bridgeState.refreshingCapabilities
        "
        title="Refresh models and provider status"
        aria-label="Refresh models and provider status"
        @click="refreshCapabilities"
      >
        Refresh
      </button>

      <div class="selector-status">
        <span
          class="readiness-badge"
          :class="providerStatusClass"
          :title="providerMessage"
        >
          {{ selectedProvider?.status || 'checking' }}
        </span>
        <span class="next-provider">
          Next prompt: {{ nextPromptCompany }}
        </span>
      </div>
    </div>

    <div
      v-if="
        !isOffline &&
        (selectedProvider?.status !== 'ready' ||
          configurationPending ||
          bridgeState.configurationError)
      "
      class="provider-message"
    >
      {{ providerMessage }}
    </div>

    <div class="chat-toolbar">
      <span class="status-text">
        {{
          bridgeState.connectionState === 'connecting'
            ? 'Connecting...'
            : isOffline
              ? 'Offline'
              : isStreaming
                ? 'Thinking...'
                : bridgeState.refreshingCapabilities
                  ? 'Refreshing...'
                : configurationPending
                  ? 'Configuring...'
                  : 'Idle'
        }}
      </span>
      <span class="grow"></span>
      <button v-if="isStreaming" class="stop-btn" @click="interrupt">
        Stop
      </button>
      <button
        class="new-chat-btn"
        :disabled="
          !bridgeState.configurationReady ||
          isStreaming ||
          bridgeState.refreshingCapabilities
        "
        @click="onNewChat"
      >
        New chat
      </button>
    </div>

    <ChatMessageList :entries="entries" />

    <ChatInput
      :disabled="inputDisabled"
      :selection-count="props.viewer.selectionCount"
      :on-send="onSend"
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

.ai-selector {
  flex-shrink: 0;
  display: grid;
  grid-template-columns:
    minmax(0, 1.1fr) minmax(0, 1.25fr) minmax(0, 0.9fr)
    auto;
  gap: 5px;
  align-items: end;
  padding: 7px 8px 5px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-panel);
}

.selector-field {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: var(--text-muted);
  font-size: 9px;
}

.selector-field select {
  width: 100%;
  min-width: 0;
  height: 25px;
  padding: 2px 4px;
  border: 1px solid var(--border-color);
  border-radius: 3px;
  background: var(--bg-input);
  color: var(--text-primary);
  font: inherit;
  font-size: 10px;
  text-overflow: ellipsis;
}

.selector-field select:focus-visible,
.refresh-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.selector-field select:disabled,
.refresh-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.refresh-btn {
  height: 25px;
  border: 1px solid var(--border-color);
  border-radius: 3px;
  padding: 2px 6px;
  background: var(--bg-button);
  color: var(--text-primary);
  font-size: 9px;
  cursor: pointer;
}

.selector-status {
  grid-column: 1 / -1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: 9px;
}

.readiness-badge {
  flex: none;
  max-width: 38%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 1px 6px;
  text-transform: capitalize;
}

.readiness-badge.ready {
  border-color: #3d8056;
  color: #8bd7a5;
}

.readiness-badge.checking {
  border-color: var(--warn-border);
  color: var(--warn-text);
}

.readiness-badge.unavailable {
  border-color: var(--error-border);
  color: var(--error-text);
}

.next-provider {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-message {
  flex-shrink: 0;
  padding: 5px 8px;
  border-bottom: 1px solid var(--warn-border);
  background: var(--warn-bg);
  color: var(--warn-text);
  font-size: 10px;
  line-height: 1.35;
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

@media (max-width: 360px) {
  .ai-selector {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  }

  .effort-field {
    grid-column: 1;
  }

  .refresh-btn {
    grid-column: 2;
  }
}
</style>
