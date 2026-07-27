import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiPreferences } from '../../../desktop/aiPreferences'
import type { EnvCadDesktopApi } from '../../../desktop/runtimeProtocol'

const bridgeMock = vi.hoisted(() => ({
  initializePreferences: vi.fn(),
  configureConnection: vi.fn(),
  connect: vi.fn(),
  waitForRuntime: vi.fn(),
  setUnavailable: vi.fn()
}))

vi.mock('../bridge', () => ({
  agentBridge: bridgeMock
}))

import { connectAgentBridge } from '../desktopRuntime'

function defaults(): AiPreferences {
  return {
    schemaVersion: 1,
    selectedProvider: 'claude-code',
    lastSelectedModels: {},
    lastSelectedEfforts: {}
  }
}

describe('connectAgentBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('retains the save callback when the initial preference read fails', async () => {
    const saveAiPreferences = vi.fn(async (preferences: AiPreferences) => preferences)
    const desktop = {
      getAiPreferences: vi.fn().mockRejectedValue(new Error('startup race')),
      saveAiPreferences,
      onSidecarStatus: vi.fn(),
      getRuntimeConfig: vi.fn().mockRejectedValue(new Error('not ready'))
    } as unknown as EnvCadDesktopApi
    window.envcadDesktop = desktop

    await connectAgentBridge()

    expect(bridgeMock.initializePreferences).toHaveBeenCalledOnce()
    const [preferences, save] = bridgeMock.initializePreferences.mock.calls[0]
    expect(preferences).toBeUndefined()
    expect(save).toEqual(expect.any(Function))

    const value = defaults()
    await save(value)
    expect(saveAiPreferences).toHaveBeenCalledWith(value)
  })
})
