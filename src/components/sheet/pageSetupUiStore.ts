import { ref } from 'vue'

export const pageSetupOpen = ref(false)

export function openPageSetup() {
  pageSetupOpen.value = true
}

export function closePageSetup() {
  pageSetupOpen.value = false
}
