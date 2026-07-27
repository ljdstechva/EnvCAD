import { describe, expect, it, vi } from 'vitest'
import { ProviderManager } from '../providers/providerManager'
import type { CadToolBridge } from '../cadToolSpecs'
import {
  FakeProvider,
  unavailableProvider
} from './fakeProviders'

const bridge: CadToolBridge = {
  callTool: vi.fn(async () => ({ data: null })),
  getSelectionSnapshot: () => undefined
}

function logger() {
  return { log: vi.fn(), error: vi.fn() }
}

describe('ProviderManager', () => {
  it.each([
    ['one unavailable', new FakeProvider('claude-code'), unavailableProvider('openai-codex')],
    ['both ready', new FakeProvider('claude-code'), new FakeProvider('openai-codex')],
    [
      'both unavailable',
      unavailableProvider('claude-code', 'authentication-required'),
      unavailableProvider('openai-codex', 'missing')
    ]
  ])('discovers providers independently when %s', async (_label, claude, codex) => {
    const manager = new ProviderManager([claude, codex], logger())
    const catalog = await manager.discover()

    expect(catalog.map((provider) => provider.status)).toEqual([
      claude.capability.status,
      codex.capability.status
    ])
  })

  it('isolates a thrown discovery failure and can recover after refresh', async () => {
    const claude = new FakeProvider('claude-code')
    const codex = new FakeProvider('openai-codex')
    codex.discoveryError = new Error('signed out')
    const manager = new ProviderManager([claude, codex], logger())

    expect((await manager.discover())[1]).toMatchObject({
      id: 'openai-codex',
      status: 'failed',
      statusMessage: expect.stringContaining('signed out')
    })
    codex.discoveryError = undefined
    expect((await manager.discover())[1]).toMatchObject({
      id: 'openai-codex',
      status: 'ready'
    })
  })

  it('coalesces concurrent capability discovery into one provider pass', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const claude = new FakeProvider('claude-code')
    const codex = new FakeProvider('openai-codex')
    claude.discoveryGate = gate
    codex.discoveryGate = gate
    const manager = new ProviderManager([claude, codex], logger())

    const first = manager.discover()
    const second = manager.discover()
    expect(second).toBe(first)
    expect(claude.discoverCount).toBe(1)
    expect(codex.discoverCount).toBe(1)

    release()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })

  it('rejects removed models and unsupported effort before creating a conversation', async () => {
    const claude = new FakeProvider('claude-code')
    const manager = new ProviderManager(
      [claude, new FakeProvider('openai-codex')],
      logger()
    )
    await manager.discover()

    await expect(
      manager.applyConfiguration(
        { provider: 'claude-code', model: 'removed-model' },
        bridge
      )
    ).rejects.toThrow('does not currently advertise model')
    await expect(
      manager.applyConfiguration(
        {
          provider: 'claude-code',
          model: 'claude-default',
          effort: 'max'
        },
        bridge
      )
    ).rejects.toThrow('does not support effort "max"')
    expect(claude.configurations).toHaveLength(0)
  })

  it('closes the old conversation before switching providers while idle', async () => {
    const claude = new FakeProvider('claude-code')
    const codex = new FakeProvider('openai-codex')
    const manager = new ProviderManager([claude, codex], logger())
    await manager.discover()

    await manager.applyConfiguration(
      {
        provider: 'claude-code',
        model: 'claude-default',
        effort: 'high'
      },
      bridge
    )
    const oldConversation = claude.conversations[0]
    await manager.applyConfiguration(
      {
        provider: 'openai-codex',
        model: 'codex-default',
        effort: 'low'
      },
      bridge
    )

    expect(oldConversation.closed).toBe(true)
    expect(manager.configuration?.provider).toBe('openai-codex')
    expect(codex.conversations).toHaveLength(1)
  })

  it('closes the active conversation when refreshed capabilities invalidate it', async () => {
    const claude = new FakeProvider('claude-code')
    const codex = new FakeProvider('openai-codex')
    const manager = new ProviderManager([claude, codex], logger())
    await manager.discover()
    await manager.applyConfiguration(
      {
        provider: 'claude-code',
        model: 'claude-default',
        effort: 'high'
      },
      bridge
    )
    const conversation = claude.conversations[0]

    claude.capability = {
      id: 'claude-code',
      displayName: 'Claude Code',
      status: 'authentication-required',
      statusMessage: 'Claude Code signed out.',
      models: []
    }
    await manager.discover()

    expect(conversation.closed).toBe(true)
    expect(manager.conversation).toBeUndefined()
    expect(manager.configuration).toBeUndefined()
    await expect(
      manager.applyConfiguration(
        {
          provider: 'openai-codex',
          model: 'codex-default',
          effort: 'low'
        },
        bridge
      )
    ).resolves.toMatchObject({
      configuration: { provider: 'openai-codex' }
    })
  })

  it('leaves CAD and the ready provider usable when its peer is unavailable', async () => {
    const claude = new FakeProvider('claude-code')
    const manager = new ProviderManager(
      [claude, unavailableProvider('openai-codex', 'incompatible')],
      logger()
    )
    await manager.discover()

    await expect(
      manager.applyConfiguration(
        {
          provider: 'claude-code',
          model: 'claude-default',
          effort: 'high'
        },
        bridge
      )
    ).resolves.toMatchObject({
      configuration: { provider: 'claude-code' },
      newConversation: true
    })
  })
})
