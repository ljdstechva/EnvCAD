<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AcApDocManager } from '@mlightcad/cad-simple-viewer'
import { sheetStore } from '../../sheet/sheetStore'
import { PAPER_SIZES } from '../../sheet/types'
import { openPageSetup } from './pageSetupUiStore'
import { exportSheetToPdf } from './pdfExport'
import { useSheetRender } from './useSheetRender'

const PX_PER_MM = 96 / 25.4

const { svg, warnings, rendering, renderError, refresh } = useSheetRender()

type ZoomMode = 'fit' | '100'
const zoomMode = ref<ZoomMode>('fit')
const fitScale = ref(1)
const dismissedWarnings = ref<Set<string>>(new Set())
const exporting = ref(false)
const exportError = ref<string | null>(null)

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

onMounted(() => {
  if (viewportEl.value) {
    resizeObserver = new ResizeObserver(() => recomputeFitScale())
    resizeObserver.observe(viewportEl.value)
  }
  recomputeFitScale()
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
})

async function onExportPdf() {
  if (!svg.value || exporting.value) return
  exporting.value = true
  exportError.value = null
  try {
    await exportSheetToPdf(svg.value, sheetStore.current, `${getDrawingName()}.pdf`)
  } catch (err) {
    exportError.value = err instanceof Error ? err.message : String(err)
  } finally {
    exporting.value = false
  }
}

function getDrawingName(): string {
  try {
    const fileName = AcApDocManager.instance.curDocument?.fileName
    if (fileName) return fileName.replace(/\.[^./\\]+$/, '')
  } catch {
    // no active document manager yet
  }
  return 'drawing'
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
      <span class="grow"></span>
      <button class="export-btn" :disabled="!svg || exporting" @click="onExportPdf">
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

    <div ref="viewportEl" class="preview-viewport">
      <div
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
  border-bottom: 1px solid #1a1a1a;
  flex-shrink: 0;
  flex-wrap: wrap;
}

.preview-toolbar button {
  background: #3c3c3c;
  color: #e0e0e0;
  border: 1px solid #4a4a4a;
  border-radius: 3px;
  padding: 4px 8px;
  font-size: 11px;
  cursor: pointer;
}

.preview-toolbar button:hover:not(:disabled) {
  background: #4a4a4a;
}

.preview-toolbar button:disabled {
  opacity: 0.5;
  cursor: default;
}

.preview-toolbar button.active {
  background: #0e639c;
  border-color: #1177bb;
}

.export-btn {
  background: #2e7d32 !important;
  border-color: #388e3c !important;
}

.sep {
  width: 1px;
  height: 18px;
  background: #4a4a4a;
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
  background: #4a3b12;
  color: #f0d080;
  border-bottom: 1px solid #6a551c;
  padding: 6px 10px;
  font-size: 11px;
}

.warning-banner.error {
  background: #4a1414;
  color: #f0a0a0;
  border-bottom-color: #6a1c1c;
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
  background: #1a1a1a;
}

.paper {
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
