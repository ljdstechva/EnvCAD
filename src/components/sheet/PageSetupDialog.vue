<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { sheetStore } from '../../sheet/sheetStore'
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
