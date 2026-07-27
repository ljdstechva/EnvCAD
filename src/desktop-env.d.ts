import type { EnvCadDesktopApi } from '../desktop/runtimeProtocol'

declare global {
  interface Window {
    envcadDesktop?: EnvCadDesktopApi
  }
}

export {}
