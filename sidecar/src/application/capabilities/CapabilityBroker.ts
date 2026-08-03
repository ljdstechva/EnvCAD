import type { ToolResult } from '../../../../src/agent/protocol'
import {
  CAD_TOOL_MANIFEST,
  getEffectiveToolPolicy,
  getToolManifestEntry
} from '../../../../shared/agent-contracts'
import type { CadToolBridge } from '../../cadToolSpecs'
import { getCadToolSpec } from '../../cadToolSpecs'
import { getInputToolSpec } from '../../inputToolSpecs'
import type { SkillInvocation } from '../../domain/skills/SkillInvocation'
import type { SkillRegistry } from '../skills/SkillRegistry'
import type { ContextBudgetManager } from '../input/ContextBudgetManager'

export interface CapabilityAuditEvent {
  timestamp: string
  toolName: string
  mutability: 'read' | 'write'
  decision: 'allowed' | 'denied'
  reason?: string
  activeSkillIds: string[]
}

export interface CapabilityBrokerOptions {
  delegate: CadToolBridge
  skillRegistry: SkillRegistry
  availableCapabilities?: readonly string[]
  contextBudget?: ContextBudgetManager
  audit?(event: CapabilityAuditEvent): void
}

const DEFAULT_CAPABILITIES = [
  'cad.read',
  'cad.write',
  'cad.render',
  'sheet.read',
  'input.read'
] as const

/**
 * App-owned provider boundary. Providers can see only catalogued tool names,
 * and every invocation is re-authorized against the active verified skills.
 */
export class CapabilityBroker implements CadToolBridge {
  private invocation: SkillInvocation | undefined
  private readonly capabilities: ReadonlySet<string>

  constructor(private readonly options: CapabilityBrokerOptions) {
    this.capabilities = new Set(
      options.availableCapabilities ?? DEFAULT_CAPABILITIES
    )
  }

  activate(invocation: SkillInvocation): void {
    this.invocation = invocation
  }

  deactivate(): void {
    this.invocation = undefined
  }

  getSelectionSnapshot() {
    return this.options.delegate.getSelectionSnapshot()
  }

  async callTool(name: string, input: unknown): Promise<ToolResult> {
    const authorization = this.authorize(name, input)
    this.audit(name, authorization.mutability, authorization.allowed, authorization.reason)
    if (!authorization.allowed) {
      return { error: authorization.reason ?? 'Capability denied.' }
    }
    const maximumOutputBytes =
      getToolManifestEntry(name)?.maximumOutputBytes ??
      getInputToolSpec(name)?.maximumOutputBytes ??
      32_000
    if (authorization.mutability === 'write') {
      const reservation =
        this.options.contextBudget?.reserveMaximumToolResult(
          maximumOutputBytes
        )
      if (reservation && !reservation.allowed) {
        const reason = contextCapacityMessage(name)
        this.audit(name, 'write', false, reason)
        return { error: reason }
      }
    }
    const result = await this.options.delegate.callTool(name, input)
    if (authorization.mutability === 'read') {
      const reservation = this.options.contextBudget?.reserveToolResult(
        providerBudgetProjection(result),
        { hasImage: Boolean(result.image) }
      )
      if (reservation && !reservation.allowed) {
        const reason = contextCapacityMessage(name)
        this.audit(name, 'read', false, reason)
        return { error: reason }
      }
    }
    return result
  }

  permittedToolNames(): string[] {
    const invocation = this.invocation
    if (!invocation) return []
    const cad = CAD_TOOL_MANIFEST.filter((entry) =>
      this.entryAllowed(
        entry.requiredSkills,
        entry.requiredCapabilities
      )
    ).map((entry) => entry.name)
    return [...cad, ...this.permittedInputTools()]
  }

  private authorize(
    name: string,
    input: unknown
  ): {
    allowed: boolean
    mutability: 'read' | 'write'
    reason?: string
  } {
    if (!this.invocation) {
      return {
        allowed: false,
        mutability: 'read',
        reason: 'No active accepted turn owns this capability request.'
      }
    }
    const inputSpec = getInputToolSpec(name)
    if (inputSpec) return this.authorizeInput(name, input)
    const entry = getToolManifestEntry(name)
    const spec = getCadToolSpec(name)
    if (!entry || !spec) {
      return {
        allowed: false,
        mutability: 'read',
        reason: `Capability "${name}" is not in EnvCAD's allowlist.`
      }
    }
    const policy = getEffectiveToolPolicy(name, input)!
    const missingSkill = entry.requiredSkills.find(
      (id) => !this.invocation!.verifiedSkillIds.has(id)
    )
    if (missingSkill) {
      return this.denied(
        policy.mutability,
        `Capability "${name}" requires verified skill "${missingSkill}".`
      )
    }
    const missingCapability = policy.requiredCapabilities.find(
      (capability) => !this.capabilities.has(capability)
    )
    if (missingCapability) {
      return this.denied(
        policy.mutability,
        `Capability "${name}" requires unavailable permission "${missingCapability}".`
      )
    }
    const parsed = spec.inputSchema.safeParse(input)
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) =>
        issue.path.length > 0 ? issue.path.join('.') : 'input'
      ))]
      return this.denied(
        policy.mutability,
        `Invalid arguments for ${name}; correct: ${fields.slice(0, 8).join(', ')}.`
      )
    }
    if (policy.mutability === 'write') {
      const check = this.options.skillRegistry.verifyBeforeMutation(
        entry.requiredSkills
      )
      if (!check.allowed) {
        return this.denied(
          'write',
          `${check.reason} AI drawing changes remain disabled; manual CAD is still available.`
        )
      }
    }
    return { allowed: true, mutability: policy.mutability }
  }

  private authorizeInput(
    name: string,
    input: unknown
  ): {
    allowed: boolean
    mutability: 'read'
    reason?: string
  } {
    const spec = getInputToolSpec(name)!
    if (!this.capabilities.has('input.read')) {
      return this.denied('read', 'Local input retrieval is unavailable.')
    }
    const parsed = spec.inputSchema.safeParse(input)
    if (!parsed.success) {
      return this.denied('read', `Invalid arguments for ${name}.`)
    }
    return { allowed: true, mutability: 'read' }
  }

  private entryAllowed(
    skills: readonly string[],
    capabilities: readonly string[]
  ): boolean {
    return (
      skills.every((id) => this.invocation!.verifiedSkillIds.has(id)) &&
      capabilities.every((id) => this.capabilities.has(id))
    )
  }

  private permittedInputTools(): string[] {
    return this.capabilities.has('input.read') && this.invocation
      ? [
          'get_input_metadata',
          'get_input_outline',
          'search_input',
          'read_input_chunk',
          'read_input_range'
        ]
      : []
  }

  private denied<T extends 'read' | 'write'>(
    mutability: T,
    reason: string
  ): { allowed: false; mutability: T; reason: string } {
    return { allowed: false, mutability, reason }
  }

  private audit(
    toolName: string,
    mutability: 'read' | 'write',
    allowed: boolean,
    reason?: string
  ): void {
    this.options.audit?.({
      timestamp: new Date().toISOString(),
      toolName,
      mutability,
      decision: allowed ? 'allowed' : 'denied',
      ...(reason ? { reason } : {}),
      activeSkillIds: [...(this.invocation?.activeSkillIds ?? [])]
    })
  }
}

function providerBudgetProjection(result: ToolResult): unknown {
  return {
    ...(result.data !== undefined ? { data: result.data } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.image
      ? {
          image: {
            mimeType: result.image.mimeType,
            width: result.image.width,
            height: result.image.height,
            byteLength: result.image.byteLength,
            sha256: result.image.sha256
          }
        }
      : {})
  }
}

function contextCapacityMessage(toolName: string): string {
  return (
    `The provider context window has no safe capacity for ${toolName}. ` +
    'Narrow the query or use search_input and a smaller exact range; the authoritative local content remains preserved.'
  )
}
