import type { SidecarStatus } from '../../desktop/runtimeProtocol'
import { agentBridge } from './bridge'

function applyStatus(status: SidecarStatus): void {
  if (status.type === 'ready') {
    agentBridge.configureConnection(status.connection)
    agentBridge.connect()
  } else if (status.type === 'starting') {
    agentBridge.waitForRuntime(status.message)
  } else {
    agentBridge.setUnavailable(status.message)
  }
}

export async function connectAgentBridge(): Promise<void> {
  const desktop = window.envcadDesktop
  if (!desktop) {
    agentBridge.initializePreferences()
    agentBridge.connect()
    return
  }

  const savePreferences = (nextPreferences: Parameters<
    typeof desktop.saveAiPreferences
  >[0]) => desktop.saveAiPreferences(nextPreferences)
  try {
    const preferences = await desktop.getAiPreferences()
    agentBridge.initializePreferences(preferences, savePreferences)
  } catch {
    // Keep persistence available after a transient startup read failure. This
    // lets later user selections repair the preferences file instead of
    // silently becoming session-only.
    agentBridge.initializePreferences(undefined, savePreferences)
  }

  let receivedEvent = false
  desktop.onSidecarStatus((status) => {
    receivedEvent = true
    applyStatus(status)
  })
  try {
    const runtime = await desktop.getRuntimeConfig()
    if (!receivedEvent) applyStatus(runtime.sidecar)
  } catch {
    agentBridge.setUnavailable(
      'AI Assistant runtime configuration is unavailable. CAD editing remains available; use File > Open Log Folder for details.'
    )
  }
}
