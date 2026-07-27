import { contextBridge, ipcRenderer } from 'electron'
import {
  DESKTOP_IPC,
  isSidecarStatus,
  type DesktopRuntimeConfig,
  type EnvCadDesktopApi
} from './runtimeProtocol'

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
    ipcRenderer.invoke(DESKTOP_IPC.openLogFolder) as Promise<{ ok: boolean; error?: string }>
}

contextBridge.exposeInMainWorld('envcadDesktop', Object.freeze(api))
