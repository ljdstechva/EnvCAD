import { ref, watch } from 'vue'

export type ThemeMode = 'dark' | 'light'

const STORAGE_KEY = 'envcad.theme'

function readStoredTheme(): ThemeMode | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return value === 'dark' || value === 'light' ? value : null
  } catch {
    return null
  }
}

function prefersLight(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false
}

export const theme = ref<ThemeMode>(readStoredTheme() ?? (prefersLight() ? 'light' : 'dark'))

export function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
}

export function setTheme(mode: ThemeMode) {
  theme.value = mode
}

/** Canvas background colors matching each theme, as 24-bit RGB hex for AcTrView2d.backgroundColor. */
export const CANVAS_BACKGROUND: Record<ThemeMode, number> = {
  dark: 0x1a1a1a,
  light: 0xf5f5f5
}

watch(
  theme,
  (mode) => {
    document.documentElement.dataset.theme = mode
    try {
      window.localStorage.setItem(STORAGE_KEY, mode)
    } catch {
      // localStorage unavailable — theme still applies for this session
    }
  },
  { immediate: true }
)
