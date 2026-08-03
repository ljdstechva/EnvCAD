import { describe, expect, it, vi } from 'vitest'
import type { CadToolBridge } from '../cadToolSpecs'
import { ProviderSupervisor } from '../providers/providerSupervisor'
import { FakeProvider } from './fakeProviders'

const bridge: CadToolBridge = {
  callTool: vi.fn(async () => ({ data: null })),
  getSelectionSnapshot: () => undefined
}

const logger = () => ({ log: vi.fn(), error: vi.fn() })

describe('ProviderSupervisor', () => {
  it('keeps the working conversation when replacement startup fails', async () => {
    const claude = new FakeProvider('claude-code')
    const codex = new FakeProvider('openai-codex')
    const supervisor = new ProviderSupervisor([claude, codex], logger())
    await supervisor.discover()
    await supervisor.applyConfiguration(
      { provider: 'claude-code', model: 'claude-default', effort: 'high' },
      bridge
    )
    const working = claude.conversations[0]
    codex.nextCreateError = new Error('codex process did not become ready')

    await expect(
      supervisor.applyConfiguration(
        { provider: 'openai-codex', model: 'codex-default', effort: 'low' },
        bridge
      )
    ).rejects.toThrow('did not become ready')

    expect(working.closed).toBe(false)
    expect(supervisor.conversation).toBe(working)
    expect(supervisor.configuration?.provider).toBe('claude-code')
  })

  it('caches ready discovery and supports an explicit refresh', async () => {
    let now = 1_000
    const claude = new FakeProvider('claude-code')
    const codex = new FakeProvider('openai-codex')
    const supervisor = new ProviderSupervisor([claude, codex], logger(), {
      now: () => now,
      capabilityCacheTtlMs: 10_000
    })

    await supervisor.discover()
    await supervisor.discover()
    expect(claude.discoverCount).toBe(1)
    expect(codex.discoverCount).toBe(1)

    await supervisor.discover(undefined, { force: true })
    expect(claude.discoverCount).toBe(2)
    expect(codex.discoverCount).toBe(2)

    now += 10_001
    await supervisor.discover()
    expect(claude.discoverCount).toBe(3)
  })

  it('recreates only the selected provider and closes the old conversation after success', async () => {
    const claude = new FakeProvider('claude-code')
    const codex = new FakeProvider('openai-codex')
    const supervisor = new ProviderSupervisor([claude, codex], logger())
    await supervisor.discover()
    await supervisor.applyConfiguration(
      { provider: 'claude-code', model: 'claude-default', effort: 'high' },
      bridge
    )
    const previous = claude.conversations[0]

    const replacement = await supervisor.recreateConversation(
      bridge,
      new Error('transport ended')
    )

    expect(previous.closed).toBe(true)
    expect(replacement).toBe(claude.conversations[1])
    expect(codex.conversations).toHaveLength(0)
    expect(supervisor.configuration?.provider).toBe('claude-code')
  })

  it('opens a bounded circuit after repeated recovery startup failures', async () => {
    const claude = new FakeProvider('claude-code')
    const supervisor = new ProviderSupervisor(
      [claude, new FakeProvider('openai-codex')],
      logger(),
      { failureThreshold: 2, cooldownMs: 30_000 }
    )
    await supervisor.discover()
    await supervisor.applyConfiguration(
      { provider: 'claude-code', model: 'claude-default', effort: 'high' },
      bridge
    )
    const working = claude.conversations[0]
    claude.nextCreateError = new Error('spawn failed')

    await expect(
      supervisor.recreateConversation(bridge, new Error('provider crashed'))
    ).rejects.toThrow('spawn failed')
    expect(supervisor.health[0]).toMatchObject({
      state: 'circuit-open',
      consecutiveFailures: 2
    })

    await expect(supervisor.recreateConversation(bridge)).rejects.toThrow(
      'recovery circuit is open'
    )
    expect(claude.configurations).toHaveLength(2)
    expect(supervisor.conversation).toBe(working)
    expect(working.closed).toBe(false)
  })
})
