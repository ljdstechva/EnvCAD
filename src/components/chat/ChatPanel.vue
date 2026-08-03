<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import { agentBridge } from '../../agent/bridge'
import { getWorkspaceRevision } from '../../cad/session'
import type {
  EffortCapability,
  ModelCapability,
  ProviderId
} from '../../agent/protocol'
import {
  sameWorkspaceRevision,
  type InputReference,
  type RecoveryActionKind
} from '../../../shared/agent-contracts'
import type { CadViewerApi } from '../../viewer/useCadViewer'
import { useChatTimeline } from './useChatTimeline'
import ChatMessageList from './ChatMessageList.vue'
import ChatInput from './ChatInput.vue'

const props = defineProps<{
  viewer: CadViewerApi
}>()

const {
  entries,
  sendMessage,
  retryLastMessage,
  interrupt,
  resetChat,
  dispose
} =
  useChatTimeline()

onBeforeUnmount(dispose)
defineExpose({ sendMessage })

const bridgeState = agentBridge.state
const isOffline = computed(() => bridgeState.connectionState !== 'online')
const hasActiveTurn = computed(() => Boolean(bridgeState.activeTurnId))
const isStreaming = computed(
  () => hasActiveTurn.value && bridgeState.status !== 'idle'
)
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
  () => bridgeState.queuedMessages.length >= 100 && isStreaming.value
)
const composerQueueing = computed(
  () =>
    isOffline.value ||
    hasActiveTurn.value ||
    bridgeState.status !== 'idle' ||
    bridgeState.refreshingCapabilities ||
    !bridgeState.configurationReady
)
const canUndoAiAction = computed(() => {
  const terminal = bridgeState.terminal
  return Boolean(
    terminal &&
      props.viewer.canUndo &&
      bridgeState.operationReceipts.some(
        (receipt) => receipt.status === 'committed'
      ) &&
      sameWorkspaceRevision(getWorkspaceRevision(), terminal.finalRevision)
  )
})
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

function onSend(text: string, attachments: InputReference[] = []) {
  return sendMessage(text, attachments)
}

function onAttach(file: File) {
  return agentBridge.ingestTextAttachment(file)
}

function onDeleteAttachment(inputId: string) {
  return agentBridge.deleteLocalInput(inputId)
}

function onDraftChange(text: string): boolean {
  return agentBridge.saveComposerDraft(text)
}

function onNewChat() {
  if (!bridgeState.configurationReady || isStreaming.value) return
  if (
    window.confirm(
      'Start a new chat? This clears the current conversation and queued follow-ups.'
    )
  ) {
    agentBridge.clearQueuedMessages()
    resetChat()
  }
}

function undoAiAction() {
  if (canUndoAiAction.value) props.viewer.undo()
}

async function onRecoveryAction(kind: RecoveryActionKind) {
  if (kind === 'undo') {
    undoAiAction()
    return
  }
  if (kind === 'export-diagnostics') {
    exportDiagnostics()
    return
  }
  if (kind === 'open-drawing') {
    window.dispatchEvent(new Event('envcad:open-drawing'))
    return
  }
  if (kind === 'choose-provider') {
    document.querySelector<HTMLSelectElement>('[aria-label="AI provider"]')?.focus()
    return
  }
  if (kind === 'retry' || kind === 'resume' || kind === 'replan') {
    const drawingStatus = bridgeState.terminal?.recovery?.drawingChanged
    if (
      drawingStatus === 'unknown' &&
      !window.confirm(
        'EnvCAD cannot yet confirm whether the previous drawing operation changed the file. Retry only after reviewing the operation receipt. Continue?'
      )
    ) {
      return
    }
    await retryLastMessage()
  }
}

function exportDiagnostics() {
  const payload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    connectionState: bridgeState.connectionState,
    agentStatus: bridgeState.status,
    provider: bridgeState.selectedProvider,
    model: bridgeState.selectedModelId,
    activeTurnId: bridgeState.activeTurnId,
    phase: bridgeState.turnPhase,
    turnStatus: bridgeState.turnStatus,
    queueCount: bridgeState.queuedMessages.length,
    skills: bridgeState.activeSkills.map((skill) => ({
      id: skill.skillId,
      version: skill.version,
      integrity: skill.integrity
    })),
    operationReceipts: bridgeState.operationReceipts.map((receipt) => ({
      operationId: receipt.operationId,
      toolName: receipt.toolName,
      status: receipt.status,
      revisionBefore: receipt.revisionBefore,
      revisionAfter: receipt.revisionAfter,
      affectedEntityCount: receipt.affectedEntityIds.length,
      failureCode: receipt.failureCode
    })),
    terminal: bridgeState.terminal
      ? {
          outcome: bridgeState.terminal.outcome,
          phase: bridgeState.terminal.phase,
          finalRevision: bridgeState.terminal.finalRevision,
          errorCode: bridgeState.terminal.error?.code,
          verification: bridgeState.terminal.verification
        }
      : undefined
  }
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
    type: 'application/json'
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `envcad-diagnostics-${Date.now()}.json`
  anchor.click()
  URL.revokeObjectURL(url)
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
            :data-input-modalities="model.inputModalities?.join(',')"
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
        <span
          class="skill-badge"
          title="The pinned earthtojake/text-to-cad CAD/DXF skill files are integrity-checked and invoked through EnvCAD's native tools for every AI turn."
        >
          CAD Skills · always active
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
    <div
      v-if="!props.viewer.documentOpen || !props.viewer.viewReady"
      class="provider-message document-message"
      tabindex="0"
    >
      Conversation is available. Drawing inspection and CAD edits will stay
      gated until you choose New Drawing or Open.
    </div>

    <section
      v-if="bridgeState.queuedMessages.length"
      class="queue-panel"
      aria-label="Queued assistant follow-ups"
    >
      <header>
        <strong>
          {{ bridgeState.queuedMessages.length }} queued follow-up{{
            bridgeState.queuedMessages.length === 1 ? '' : 's'
          }}
        </strong>
        <span>{{ bridgeState.queueStatus }}</span>
      </header>
      <ol>
        <li
          v-for="queued in bridgeState.queuedMessages"
          :key="queued.queueId"
          :class="{ review: queued.status === 'needs-review' }"
        >
          <span>{{ queued.text.slice(0, 120) }}</span>
          <small>{{ queued.status.replace('-', ' ') }}</small>
          <button
            v-if="queued.status === 'needs-review'"
            type="button"
            @click="agentBridge.resumeQueuedMessage(queued.queueId)"
          >
            Send with current drawing
          </button>
          <button
            type="button"
            @click="agentBridge.removeQueuedMessage(queued.queueId)"
          >
            Remove
          </button>
        </li>
      </ol>
    </section>

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
        Cancel turn
      </button>
      <button
        class="new-chat-btn"
        type="button"
        :disabled="!canUndoAiAction"
        title="Available only while the drawing still matches the completed AI revision"
        @click="undoAiAction"
      >
        Undo AI action
      </button>
      <button class="new-chat-btn" type="button" @click="exportDiagnostics">
        Export diagnostics
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

    <div class="visually-hidden" aria-live="assertive" aria-atomic="true">
      {{
        bridgeState.turnStatus ||
        (bridgeState.terminalOutcome
          ? `Assistant turn ${bridgeState.terminalOutcome}`
          : '')
      }}
    </div>

    <ChatMessageList
      :entries="entries"
      @recovery-action="onRecoveryAction"
    />

    <ChatInput
      :disabled="inputDisabled"
      :queueing="composerQueueing"
      :selection-count="props.viewer.selectionCount"
      :initial-draft="agentBridge.getComposerDraft()"
      :on-draft-change="onDraftChange"
      :on-attach="onAttach"
      :on-delete-attachment="onDeleteAttachment"
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
  font-size: 12px;
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
  font-size: 12px;
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
  font-size: 12px;
}

.selector-field select {
  width: 100%;
  min-width: 0;
  height: 30px;
  padding: 2px 4px;
  border: 1px solid var(--border-color);
  border-radius: 3px;
  background: var(--bg-input);
  color: var(--text-primary);
  font: inherit;
  font-size: 12px;
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
  height: 30px;
  border: 1px solid var(--border-color);
  border-radius: 3px;
  padding: 2px 6px;
  background: var(--bg-button);
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
}

.selector-status {
  grid-column: 1 / -1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: 12px;
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
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-badge {
  flex: none;
  border: 1px solid #476b9e;
  border-radius: 8px;
  padding: 1px 6px;
  color: #9cc5ff;
  white-space: nowrap;
}

.provider-message {
  flex-shrink: 0;
  padding: 5px 8px;
  border-bottom: 1px solid var(--warn-border);
  background: var(--warn-bg);
  color: var(--warn-text);
  font-size: 12px;
  line-height: 1.35;
}

.chat-toolbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-strong);
}

.status-text {
  font-size: 12px;
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
  font-size: 12px;
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

.queue-panel {
  flex: none;
  max-height: 160px;
  overflow: auto;
  padding: 7px 8px;
  border-bottom: 1px solid var(--border-color);
  background: var(--info-bg);
  color: var(--info-text);
  font-size: 12px;
}

.queue-panel header {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.queue-panel header span {
  color: var(--text-secondary);
}

.queue-panel ol {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin: 6px 0 0;
  padding-left: 22px;
}

.queue-panel li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 5px;
}

.queue-panel li.review {
  color: var(--warn-text);
}

.queue-panel li > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-panel button {
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-button);
  color: var(--text-primary);
  padding: 3px 6px;
  font: inherit;
  cursor: pointer;
}

button:focus-visible,
select:focus-visible,
.document-message:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
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
