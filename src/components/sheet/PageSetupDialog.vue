<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { sheetStore } from '../../sheet/sheetStore'
import {
  exportTemplateToJson,
  importTemplateFromJson
} from '../../sheet/templates/customTemplates'
import { listTemplates } from '../../sheet/templates/registry'
import type { TitleBlockTemplate } from '../../sheet/templates/types'
import { PAPER_SIZES, type Orientation, type PaperSizeId } from '../../sheet/types'
import { closePageSetup, pageSetupOpen } from './pageSetupUiStore'
import { pickModeActive, requestPickCenter } from './pickCenter'

const PAPER_LABELS: Record<PaperSizeId, string> = {
  A4: 'A4',
  A3: 'A3',
  A2: 'A2',
  A1: 'A1',
  A0: 'A0',
  LETTER: 'Letter',
  ANSI_B: 'ANSI B',
  ANSI_C: 'ANSI C',
  ANSI_D: 'ANSI D'
}

const SCALE_PRESETS = [50, 100, 200, 250, 500, 1000]

const isCustomScale = ref(!SCALE_PRESETS.includes(sheetStore.current.scaleDenominator))
const customScaleValue = ref(sheetStore.current.scaleDenominator)

const scaleSelectValue = computed<number | 'custom'>({
  get: () => (isCustomScale.value ? 'custom' : sheetStore.current.scaleDenominator),
  set: (value) => {
    if (value === 'custom') {
      isCustomScale.value = true
      sheetStore.current.scaleDenominator = customScaleValue.value
    } else {
      isCustomScale.value = false
      sheetStore.current.scaleDenominator = value
    }
  }
})

watch(customScaleValue, (value) => {
  if (isCustomScale.value && value > 0) {
    sheetStore.current.scaleDenominator = value
  }
})

const paperDims = computed(() => PAPER_SIZES[sheetStore.current.paper])

function setOrientation(orientation: Orientation) {
  sheetStore.current.orientation = orientation
}

function setViewportMode(mode: 'extents' | 'pick') {
  if (mode === 'extents') {
    sheetStore.current.viewportCenter = 'extents'
  } else {
    void startPickCenter()
  }
}

async function startPickCenter() {
  const point = await requestPickCenter()
  if (point) {
    sheetStore.current.viewportCenter = point
  }
}

function close() {
  closePageSetup()
}

const isPickMode = computed(() => sheetStore.current.viewportCenter !== 'extents')
const pickedCenter = computed(() => {
  const center = sheetStore.current.viewportCenter
  return center === 'extents' ? null : center
})

const availableTemplates = computed(() =>
  listTemplates().filter(t => t.supportedPapers.includes(sheetStore.current.paper))
)

const selectedTemplate = computed<TitleBlockTemplate | undefined>(() =>
  availableTemplates.value.find(t => t.id === sheetStore.current.templateId)
)

const editableFields = computed(() =>
  (selectedTemplate.value?.fields ?? []).filter(f => f.key !== 'SCALE')
)

const templateImportError = ref<string | null>(null)
const templateFileInput = ref<HTMLInputElement | null>(null)

watch(
  () => sheetStore.current.paper,
  () => {
    if (sheetStore.current.templateId && !selectedTemplate.value) {
      sheetStore.current.templateId = undefined
    }
  }
)

function selectTemplate(id: string | undefined) {
  sheetStore.current.templateId = id
}

function fieldValue(key: string): string {
  return sheetStore.current.fields?.[key] ?? ''
}

function setFieldValue(key: string, value: string) {
  if (!sheetStore.current.fields) sheetStore.current.fields = {}
  sheetStore.current.fields[key] = value
}

function triggerImport() {
  templateImportError.value = null
  templateFileInput.value?.click()
}

async function onImportFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const text = await file.text()
    const template = importTemplateFromJson(text)
    sheetStore.current.templateId = template.id
    templateImportError.value = null
  } catch (err) {
    templateImportError.value = err instanceof Error ? err.message : String(err)
  }
}

function exportSelectedTemplate() {
  const template = selectedTemplate.value
  if (!template) return
  const json = exportTemplateToJson(template)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${template.id}.json`
  link.click()
  URL.revokeObjectURL(url)
}

function previewSvg(template: TitleBlockTemplate): string {
  const W = 80
  const H = 56
  const parts = [`<rect x="2" y="2" width="${W - 4}" height="${H - 4}" fill="none" stroke="#888" stroke-width="1"/>`]

  if (template.frame.length > 0) {
    const xs = template.frame.flatMap(s => [s.x1, s.x2])
    const ys = template.frame.flatMap(s => [s.y1, s.y2])
    const boundsW = Math.max(...xs, 1)
    const boundsH = Math.max(...ys, 1)
    const targetW = Math.min(40, W - 6)
    const scale = targetW / boundsW
    const originX = W - 3
    const originY = H - 3
    for (const seg of template.frame) {
      const x1 = originX - seg.x1 * scale
      const y1 = originY - seg.y1 * scale
      const x2 = originX - seg.x2 * scale
      const y2 = originY - seg.y2 * scale
      parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#333" stroke-width="0.8"/>`)
    }
  }

  if (template.northArrow) {
    parts.push(
      `<circle cx="${W - 8}" cy="8" r="3" fill="none" stroke="#333" stroke-width="0.8"/>` +
        `<text x="${W - 8}" y="9.5" font-size="4" text-anchor="middle" fill="#333">N</text>`
    )
  }

  if (template.scaleBar) {
    parts.push(`<line x1="8" y1="${H - 8}" x2="24" y2="${H - 8}" stroke="#333" stroke-width="1.5"/>`)
  }

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%">${parts.join('')}</svg>`
}
</script>

<template>
  <div v-if="pageSetupOpen" class="dialog-backdrop" @click.self="close">
    <div class="dialog">
      <div class="dialog-header">
        <span>Page Setup</span>
        <button class="icon-btn" @click="close">×</button>
      </div>

      <div class="dialog-body">
        <div class="field-row">
          <label>Paper size</label>
          <select v-model="sheetStore.current.paper">
            <option v-for="(_, id) in PAPER_SIZES" :key="id" :value="id">
              {{ PAPER_LABELS[id as PaperSizeId] }}
            </option>
          </select>
          <span class="hint">{{ paperDims.widthMm }} × {{ paperDims.heightMm }} mm</span>
        </div>

        <div class="field-row">
          <label>Orientation</label>
          <div class="orientation-toggle">
            <button
              :class="{ active: sheetStore.current.orientation === 'portrait' }"
              @click="setOrientation('portrait')"
            >
              <svg class="orient-icon" viewBox="0 0 24 24" width="18" height="18">
                <rect x="6" y="3" width="12" height="18" rx="1" fill="none" stroke="currentColor" stroke-width="2" />
              </svg>
              Portrait
            </button>
            <button
              :class="{ active: sheetStore.current.orientation === 'landscape' }"
              @click="setOrientation('landscape')"
            >
              <svg class="orient-icon" viewBox="0 0 24 24" width="18" height="18">
                <rect x="3" y="6" width="18" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="2" />
              </svg>
              Landscape
            </button>
          </div>
        </div>

        <div class="field-row">
          <label>Scale</label>
          <select v-model="scaleSelectValue">
            <option v-for="preset in SCALE_PRESETS" :key="preset" :value="preset">1:{{ preset }}</option>
            <option value="custom">Custom…</option>
          </select>
          <template v-if="isCustomScale">
            <span class="hint">1 :</span>
            <input type="number" min="1" v-model.number="customScaleValue" class="scale-input" />
          </template>
        </div>

        <div class="field-row">
          <label>Drawing unit</label>
          <select v-model="sheetStore.current.drawingUnit">
            <option value="m">Meters</option>
            <option value="mm">Millimeters</option>
          </select>
        </div>

        <div class="field-group">
          <label class="group-label">Margins (mm)</label>
          <div class="margins-grid">
            <label>Top<input type="number" min="0" v-model.number="sheetStore.current.marginsMm.top" /></label>
            <label>Right<input type="number" min="0" v-model.number="sheetStore.current.marginsMm.right" /></label>
            <label>Bottom<input type="number" min="0" v-model.number="sheetStore.current.marginsMm.bottom" /></label>
            <label>Left<input type="number" min="0" v-model.number="sheetStore.current.marginsMm.left" /></label>
          </div>
        </div>

        <div class="field-group">
          <label class="group-label">Viewport center</label>
          <div class="viewport-toggle">
            <button :class="{ active: !isPickMode }" @click="setViewportMode('extents')">
              Fit extents
            </button>
            <button :class="{ active: isPickMode }" @click="setViewportMode('pick')">
              Pick center
            </button>
          </div>
          <div v-if="pickModeActive" class="pick-hint">Click a point on the canvas… (Esc to cancel)</div>
          <div v-else-if="pickedCenter" class="hint">
            Center: {{ pickedCenter.x.toFixed(2) }}, {{ pickedCenter.y.toFixed(2) }}
          </div>
        </div>

        <div class="field-group">
          <label class="group-label">Title block template</label>
          <div class="template-grid">
            <button
              class="template-card"
              :class="{ active: !sheetStore.current.templateId }"
              @click="selectTemplate(undefined)"
            >
              <div class="template-preview none-preview">None</div>
              <span class="template-name">No template</span>
            </button>
            <button
              v-for="template in availableTemplates"
              :key="template.id"
              class="template-card"
              :class="{ active: sheetStore.current.templateId === template.id }"
              :title="template.description"
              @click="selectTemplate(template.id)"
            >
              <div class="template-preview" v-html="previewSvg(template)"></div>
              <span class="template-name">{{ template.name }}</span>
            </button>
          </div>

          <div class="template-io">
            <button @click="triggerImport">Import…</button>
            <button :disabled="!selectedTemplate" @click="exportSelectedTemplate">Export…</button>
            <input
              ref="templateFileInput"
              type="file"
              accept="application/json"
              class="hidden-file-input"
              @change="onImportFile"
            />
          </div>
          <div v-if="templateImportError" class="hint error-hint">{{ templateImportError }}</div>
        </div>

        <div v-if="editableFields.length" class="field-group">
          <label class="group-label">Title block fields</label>
          <div class="fields-grid">
            <label v-for="field in editableFields" :key="field.key" class="field-input">
              {{ field.label }}
              <input
                type="text"
                :value="fieldValue(field.key)"
                @input="setFieldValue(field.key, ($event.target as HTMLInputElement).value)"
              />
            </label>
          </div>
        </div>
      </div>

      <div class="dialog-footer">
        <button class="primary" @click="close">Done</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.dialog {
  width: 360px;
  max-height: 85vh;
  overflow: auto;
  background: #2b2b2b;
  border: 1px solid #4a4a4a;
  border-radius: 4px;
  color: #e0e0e0;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid #1a1a1a;
  font-weight: 600;
  font-size: 13px;
}

.icon-btn {
  background: transparent;
  border: none;
  color: #ccc;
  font-size: 16px;
  cursor: pointer;
  line-height: 1;
}

.dialog-body {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.field-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.field-row label {
  width: 90px;
  flex-shrink: 0;
  color: #b0b0b0;
}

select,
input[type='number'] {
  background: #1e1e1e;
  border: 1px solid #4a4a4a;
  color: #e0e0e0;
  padding: 4px 6px;
  border-radius: 3px;
  font-size: 12px;
}

.scale-input {
  width: 70px;
}

.hint {
  color: #888;
  font-size: 11px;
}

.field-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.group-label {
  font-size: 12px;
  color: #b0b0b0;
}

.margins-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.margins-grid label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: #999;
}

.margins-grid input {
  width: 100%;
}

.orientation-toggle,
.viewport-toggle {
  display: flex;
  gap: 6px;
  flex: 1;
}

.orientation-toggle button,
.viewport-toggle button {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: #3c3c3c;
  color: #ccc;
  border: 1px solid #4a4a4a;
  border-radius: 3px;
  padding: 6px 8px;
  font-size: 12px;
  cursor: pointer;
}

.orientation-toggle button.active,
.viewport-toggle button.active {
  background: #0e639c;
  border-color: #1177bb;
  color: #fff;
}

.orient-icon {
  flex-shrink: 0;
}

.pick-hint {
  font-size: 11px;
  color: #e0b84e;
}

.template-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}

.template-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  background: #3c3c3c;
  border: 1px solid #4a4a4a;
  border-radius: 3px;
  padding: 6px;
  cursor: pointer;
  color: #ccc;
}

.template-card.active {
  background: #0e639c;
  border-color: #1177bb;
  color: #fff;
}

.template-preview {
  width: 100%;
  height: 56px;
  background: #fff;
  border-radius: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.template-preview.none-preview {
  color: #999;
  font-size: 11px;
}

.template-name {
  font-size: 10px;
  text-align: center;
  line-height: 1.3;
}

.template-io {
  display: flex;
  gap: 8px;
}

.template-io button {
  flex: 1;
  background: #3c3c3c;
  color: #ccc;
  border: 1px solid #4a4a4a;
  border-radius: 3px;
  padding: 6px 8px;
  font-size: 12px;
  cursor: pointer;
}

.template-io button:disabled {
  opacity: 0.5;
  cursor: default;
}

.hidden-file-input {
  display: none;
}

.error-hint {
  color: #f0a0a0;
}

.fields-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.field-input {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: #999;
}

.field-input input {
  width: 100%;
}

.dialog-footer {
  padding: 10px 12px;
  border-top: 1px solid #1a1a1a;
  display: flex;
  justify-content: flex-end;
}

.primary {
  background: #0e639c;
  border: 1px solid #1177bb;
  color: #fff;
  padding: 6px 16px;
  border-radius: 3px;
  font-size: 12px;
  cursor: pointer;
}
</style>

<style>
.sheet-pick-cursor {
  cursor: crosshair !important;
}
</style>
