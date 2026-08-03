import { contextBridge, ipcRenderer } from 'electron'
import {
  DESKTOP_IPC,
  isSidecarStatus,
  type DesktopRuntimeConfig,
  type EnvCadDesktopApi
} from './runtimeProtocol'
import type { AiPreferences } from './aiPreferences'
import type { SheetDefinition } from '../src/sheet/types'

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
    ) as Promise<AiPreferences>,
  getSheetPreference: (documentName) =>
    ipcRenderer.invoke(
      DESKTOP_IPC.getSheetPreference,
      documentName
    ) as Promise<SheetDefinition | undefined>,
  saveSheetPreference: (documentName, sheet) =>
    ipcRenderer.invoke(
      DESKTOP_IPC.saveSheetPreference,
      documentName,
      sheet
    ) as Promise<SheetDefinition>,
  getOperationReceipt: (operationId) =>
    ipcRenderer.invoke(
      DESKTOP_IPC.getOperationReceipt,
      operationId
    ),
  getOperationReceiptByKey: (idempotencyKey) =>
    ipcRenderer.invoke(
      DESKTOP_IPC.getOperationReceiptByKey,
      idempotencyKey
    ),
  listUnresolvedOperations: () =>
    ipcRenderer.invoke(DESKTOP_IPC.listUnresolvedOperations),
  createPendingOperation: (receipt) =>
    ipcRenderer.invoke(DESKTOP_IPC.createPendingOperation, receipt),
  saveOperationReceipt: (receipt) =>
    ipcRenderer.invoke(DESKTOP_IPC.saveOperationReceipt, receipt),
  writeOperationResult: (result) =>
    ipcRenderer.invoke(DESKTOP_IPC.writeOperationResult, result),
  readOperationResult: (reference) =>
    ipcRenderer.invoke(DESKTOP_IPC.readOperationResult, reference),
  loadAgentState: (key) => {
    const result = ipcRenderer.sendSync(DESKTOP_IPC.loadAgentState, key) as
      | { ok: true; value: string | null }
      | { ok: false; message: string }
    if (!result.ok) throw new Error(result.message)
    return result.value
  },
  saveAgentState: (key, value) =>
    ipcRenderer.invoke(DESKTOP_IPC.saveAgentState, key, value) as Promise<void>,
  saveAgentStateSync: (key, value) => {
    const result = ipcRenderer.sendSync(
      DESKTOP_IPC.saveAgentStateSync,
      key,
      value
    ) as { ok: true } | { ok: false; message: string }
    if (!result.ok) throw new Error(result.message)
  }
}

contextBridge.exposeInMainWorld('envcadDesktop', Object.freeze(api))
