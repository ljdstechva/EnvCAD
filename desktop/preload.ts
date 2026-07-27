import { contextBridge, ipcRenderer } from 'electron'
import {
  DESKTOP_IPC,
  isSidecarStatus,
  type DesktopRuntimeConfig,
  type EnvCadDesktopApi
} from './runtimeProtocol'
import type { AiPreferences } from './aiPreferences'

const api: EnvCadDesktopApi = {
  getRuntimeConfig: () =>
    ipcRenderer.invoke(DESKTOP_IPC.getRuntimeConfig) as Promise<DesktopRuntimeConfig>,
  onSidecarStatus(callback) {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (isSidecarStatus(value)) callback(value)
    }
    ipcRenderer.on(DESKTOP_IPC.sidecarStatus, listener)
    return () => ipcRenderer.removeListener(DESKTOP_IPC.sidecarStatus, listener)
  },
  openLogFolder: () =>
    ipcRenderer.invoke(DESKTOP_IPC.openLogFolder) as Promise<{ ok: boolean; error?: string }>,
  getAiPreferences: () =>
    ipcRenderer.invoke(DESKTOP_IPC.getAiPreferences) as Promise<AiPreferences>,
  saveAiPreferences: (preferences) =>
    ipcRenderer.invoke(
      DESKTOP_IPC.saveAiPreferences,
      preferences
    ) as Promise<AiPreferences>
}

contextBridge.exposeInMainWorld('envcadDesktop', Object.freeze(api))
