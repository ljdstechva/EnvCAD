<script setup lang="ts">
import { toasts, dismissToast } from './toastStore'
</script>

<template>
  <div class="toast-host">
    <div v-for="toast in toasts" :key="toast.id" class="toast" :class="toast.kind" role="alert">
      <span class="message">{{ toast.message }}</span>
      <button class="dismiss" @click="dismissToast(toast.id)">×</button>
    </div>
  </div>
</template>

<style scoped>
/*
 * Anchored bottom-left, above the 24px status bar: the right edge belongs to
 * the chat dock, and a toast there would sit on top of the Send button
 * precisely when an agent error makes the user want to retry. Toasts stay
 * click-through so they never swallow a click meant for the canvas; only the
 * dismiss button takes pointer events.
 */
.toast-host {
  position: fixed;
  left: 14px;
  bottom: 34px;
  z-index: 1000;
  display: flex;
  flex-direction: column-reverse;
  gap: 8px;
  max-width: 360px;
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 5px;
  font-size: 12px;
  line-height: 1.4;
  box-shadow: 0 4px 16px var(--shadow-color);
  background: var(--bg-button);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
}

.toast.error {
  background: var(--error-bg);
  color: var(--error-text);
  border-color: var(--error-border);
}

.toast.info {
  background: var(--info-bg);
  color: var(--info-text);
  border-color: var(--info-border);
}

.message {
  flex: 1;
  word-break: break-word;
}

.dismiss {
  pointer-events: auto;
  flex-shrink: 0;
  background: transparent;
  border: none;
  color: inherit;
  font-size: 14px;
  cursor: pointer;
  line-height: 1;
}
</style>
