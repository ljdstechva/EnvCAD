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
    agentBridge.connect()
    return
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
