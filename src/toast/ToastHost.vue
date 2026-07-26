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
.toast-host {
  position: fixed;
  right: 14px;
  bottom: 14px;
  z-index: 1000;
  display: flex;
  flex-direction: column-reverse;
  gap: 8px;
  max-width: 360px;
  pointer-events: none;
}

.toast {
  pointer-events: auto;
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
  flex-shrink: 0;
  background: transparent;
  border: none;
  color: inherit;
  font-size: 14px;
  cursor: pointer;
  line-height: 1;
}
</style>
