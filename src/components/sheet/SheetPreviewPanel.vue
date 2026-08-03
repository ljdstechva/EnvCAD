<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { agentBridge } from '../../agent/bridge'
import { modelImageInputSupport } from '../../agent/protocol'
import { cadSessionState } from '../../cad/session'
import { sheetStore } from '../../sheet/sheetStore'
import { PAPER_SIZES } from '../../sheet/types'
import { openPageSetup } from './pageSetupUiStore'
import { exportSheetToPdf } from './pdfExport'
import { useSheetRender } from './useSheetRender'
import { pushToast } from '../../toast/toastStore'

const props = defineProps<{
  inspectWithAi: () => Promise<boolean>
}>()

const PX_PER_MM = 96 / 25.4

const {
  svg,
  svgSha256,
  warnings,
  rendering,
  renderError,
  diagnostics,
  renderRevision,
  refresh
} = useSheetRender()

type ZoomMode = 'fit' | '100'
const zoomMode = ref<ZoomMode>('fit')
const fitScale = ref(1)
const dismissedWarnings = ref<Set<string>>(new Set())
const exporting = ref(false)
const exportError = ref<string | null>(null)
const inspectState = ref<'idle' | 'loading' | 'success' | 'failure'>('idle')
const inspectToolSucceeded = ref(false)

const viewportEl = ref<HTMLDivElement | null>(null)
let resizeObserver: ResizeObserver | null = null

const paperDims = computed(() => {
  const base = PAPER_SIZES[sheetStore.current.paper]
  const landscape = sheetStore.current.orientation === 'landscape'
  return {
    widthMm: landscape ? base.heightMm : base.widthMm,
    heightMm: landscape ? base.widthMm : base.heightMm
  }
})

const paperPx = computed(() => ({
  width: paperDims.value.widthMm * PX_PER_MM,
  height: paperDims.value.heightMm * PX_PER_MM
}))

const activeScale = computed(() => (zoomMode.value === 'fit' ? fitScale.value : 1))

const visibleWarnings = computed(() =>
  warnings.value.filter((w) => !dismissedWarnings.value.has(w))
)
const documentReady = computed(
  () =>
    cadSessionState.status === 'active' &&
    cadSessionState.editable &&
    cadSessionState.viewReady
)
const canExport = computed(
  () =>
    documentReady.value &&
    Boolean(svg.value) &&
    !exporting.value &&
    diagnostics.value !== null &&
    diagnostics.value.drawableElementCount > 0 &&
    !diagnostics.value.unitMismatch
)
const selectedProvider = computed(() =>
  agentBridge.selectedProviderCapability()
)
const selectedModel = computed(() => agentBridge.selectedModelCapability())
const selectedModelImageSupport = computed(() =>
  selectedModel.value
    ? modelImageInputSupport(selectedModel.value)
    : 'unknown'
)
const canInspectWithAi = computed(
  () =>
    documentReady.value &&
    Boolean(svg.value) &&
    diagnostics.value !== null &&
    !rendering.value &&
    agentBridge.state.connectionState === 'online' &&
    agentBridge.state.status !== 'thinking' &&
    !agentBridge.state.refreshingCapabilities &&
    agentBridge.state.configurationReady &&
    selectedProvider.value?.status === 'ready' &&
    Boolean(selectedModel.value) &&
    selectedModelImageSupport.value !== 'unsupported'
)
const inspectTitle = computed(() => {
  if (selectedModelImageSupport.value === 'unsupported') {
    return 'The selected model explicitly excludes image input. Choose an image-capable model to inspect Sheet Preview.'
  }
  if (!documentReady.value || !svg.value || diagnostics.value === null) {
    return 'Wait for an open drawing and a completed Sheet Preview render.'
  }
  const provider = selectedProvider.value?.displayName ?? 'the selected AI provider'
  return `Send the current Sheet Preview image to ${provider}. This uses the selected model and effort in a real provider turn.`
})
const inspectLabel = computed(() => {
  if (inspectState.value === 'loading') return 'Inspecting…'
  if (inspectState.value === 'success') return 'Inspected'
  if (inspectState.value === 'failure') return 'Inspection failed'
  return 'Inspect with AI'
})

const unsubscribeAgent = agentBridge.subscribe((message) => {
  if (inspectState.value !== 'loading') return
  if (
    message.type === 'tool_result' &&
    message.name === 'inspect_sheet_preview'
  ) {
    if (message.result.error) inspectState.value = 'failure'
    else inspectToolSucceeded.value = true
  } else if (
    message.type === 'durable_event' &&
    message.envelope.payload.type === 'turn_finished'
  ) {
    const outcome = message.envelope.payload.outcome
    inspectState.value =
      inspectToolSucceeded.value &&
      (outcome === 'completed' || outcome === 'recovered')
        ? 'success'
        : 'failure'
  } else if (message.type === 'assistant_done') {
    inspectState.value = inspectToolSucceeded.value ? 'success' : 'failure'
  } else if (message.type === 'error' || message.type === 'connection_reset') {
    inspectState.value = 'failure'
  }
})

function dismissWarning(warning: string) {
  dismissedWarnings.value = new Set(dismissedWarnings.value).add(warning)
}

function recomputeFitScale() {
  const el = viewportEl.value
  if (!el) return
  const padding = 24
  const availW = el.clientWidth - padding
  const availH = el.clientHeight - padding
  if (availW <= 0 || availH <= 0) return
  const scale = Math.min(availW / paperPx.value.width, availH / paperPx.value.height, 1)
  fitScale.value = scale > 0 ? scale : 1
}

watch(paperPx, () => nextTick(recomputeFitScale))
watch(svg, () => {
  dismissedWarnings.value = new Set()
  nextTick(recomputeFitScale)
})

function observeViewport(element: HTMLDivElement | null) {
  resizeObserver?.disconnect()
  resizeObserver = null
  if (element) {
    resizeObserver = new ResizeObserver(() => recomputeFitScale())
    resizeObserver.observe(element)
    nextTick(recomputeFitScale)
  }
}

watch(viewportEl, observeViewport, { flush: 'post' })

onMounted(recomputeFitScale)

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  unsubscribeAgent()
})

async function onInspectWithAi() {
  if (!canInspectWithAi.value) return
  inspectState.value = 'loading'
  inspectToolSucceeded.value = false
  if (!(await props.inspectWithAi())) {
    inspectState.value = 'failure'
    pushToast('The Sheet Preview inspection request could not be sent.')
  }
}

async function onExportPdf() {
  if (!canExport.value) {
    if (diagnostics.value?.unitMismatch) {
      pushToast('PDF export is blocked until the sheet drawing unit matches the database unit.')
    }
    return
  }
  exporting.value = true
  exportError.value = null
  try {
    await exportSheetToPdf(svg.value, sheetStore.current, `${getDrawingName()}.pdf`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    exportError.value = message
    pushToast(`PDF export failed: ${message}`)
  } finally {
    exporting.value = false
  }
}

function getDrawingName(): string {
  return (cadSessionState.documentName ?? 'drawing').replace(
    /\.[^./\\]+$/,
    ''
  )
}
</script>

<template>
  <div class="sheet-preview">
    <div class="preview-toolbar">
      <button class="icon-btn" title="Page Setup" @click="openPageSetup">⚙ Page Setup</button>
      <span class="sep"></span>
      <button :class="{ active: zoomMode === 'fit' }" @click="zoomMode = 'fit'">Fit</button>
      <button :class="{ active: zoomMode === '100' }" @click="zoomMode = '100'">100%</button>
      <span class="sep"></span>
      <button @click="refresh" :disabled="rendering">{{ rendering ? 'Rendering…' : 'Refresh' }}</button>
      <button
        class="inspect-btn"
        :disabled="!canInspectWithAi"
        :title="inspectTitle"
        :data-state="inspectState"
        @click="onInspectWithAi"
      >
        {{ inspectLabel }}
      </button>
      <span class="grow"></span>
      <button
        class="export-btn"
        :disabled="!canExport"
        :title="
          diagnostics?.unitMismatch
            ? 'Export is blocked until the sheet unit matches the database unit'
            : 'Export the visible vector sheet as PDF'
        "
        @click="onExportPdf"
      >
        {{ exporting ? 'Exporting…' : 'Export PDF' }}
      </button>
    </div>

    <div v-if="visibleWarnings.length" class="warnings">
      <div v-for="warning in visibleWarnings" :key="warning" class="warning-banner">
        <span>{{ warning }}</span>
        <button class="dismiss" @click="dismissWarning(warning)">×</button>
      </div>
    </div>
    <div v-if="renderError" class="warning-banner error">
      <span>Render failed: {{ renderError }}</span>
    </div>
    <div v-if="exportError" class="warning-banner error">
      <span>Export failed: {{ exportError }}</span>
      <button class="dismiss" @click="exportError = null">×</button>
    </div>

    <div
      v-if="!documentReady"
      class="preview-empty"
      role="status"
    >
      No drawing is open. Choose New Drawing or Open before using Sheet Preview.
    </div>
    <div
      v-else
      ref="viewportEl"
      class="preview-viewport"
      :data-render-status="cadSessionState.sheetPreview.status"
      :data-drawable-elements="diagnostics?.drawableElementCount ?? 0"
      :data-unit-mismatch="diagnostics?.unitMismatch ?? false"
      :data-svg-sha256="svgSha256"
      :data-render-revision="renderRevision"
    >
      <div
        v-if="svg"
        class="paper"
        :style="{
          width: paperPx.width + 'px',
          height: paperPx.height + 'px',
          transform: `scale(${activeScale})`
        }"
        v-html="svg"
      ></div>
    </div>
  </div>
</template>

<style scoped>
.sheet-preview {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
}

.preview-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-strong);
  flex-shrink: 0;
  flex-wrap: wrap;
}

.preview-toolbar button {
  background: var(--bg-button);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: 3px;
  padding: 4px 8px;
  font-size: 11px;
  cursor: pointer;
}

.preview-toolbar button:hover:not(:disabled) {
  background: var(--bg-button-hover);
}

.preview-toolbar button:disabled {
  opacity: 0.5;
  cursor: default;
}

.preview-toolbar button.active {
  background: var(--accent);
  border-color: var(--accent-border);
  color: var(--text-on-accent);
}

.export-btn {
  background: var(--success-bg) !important;
  border-color: var(--success-border) !important;
  color: var(--text-on-accent) !important;
}

.inspect-btn {
  border-color: var(--accent-border) !important;
}

.sep {
  width: 1px;
  height: 18px;
  background: var(--border-color);
  margin: 0 2px;
}

.grow {
  flex: 1;
}

.warnings {
  flex-shrink: 0;
}

.warning-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: var(--warn-bg);
  color: var(--warn-text);
  border-bottom: 1px solid var(--warn-border);
  padding: 6px 10px;
  font-size: 11px;
}

.warning-banner.error {
  background: var(--error-bg);
  color: var(--error-text);
  border-bottom-color: var(--error-border);
}

.dismiss {
  background: transparent;
  border: none;
  color: inherit;
  font-size: 14px;
  cursor: pointer;
  line-height: 1;
  flex-shrink: 0;
}

.preview-viewport {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 12px;
  background: var(--bg-canvas);
}

.preview-empty {
  flex: 1;
  display: grid;
  place-items: center;
  padding: 24px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
}

.paper {
  /* The paper preview represents a printed page — it stays white in both themes. */
  background: #ffffff;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.55);
  transform-origin: top center;
  flex-shrink: 0;
}

.paper :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
