export const OFFICIAL_CODEX_MODEL_PROVIDER = 'openai'
export const OFFICIAL_CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api/'
export const CODEX_APPROVAL_POLICY = 'never'
export const CODEX_SANDBOX_MODE = 'read-only'

const DISABLED_CODEX_FEATURES = [
  'apps',
  'artifact',
  'auth_elicitation',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'chronicle',
  'code_mode',
  'code_mode_buffered_exec',
  'code_mode_host',
  'code_mode_only',
  'computer_use',
  'current_time_reminder',
  'deferred_executor',
  'enable_mcp_apps',
  'executor_capability_discovery',
  'external_agent_memory_import',
  'goals',
  'guardian_approval',
  'hooks',
  'image_generation',
  'in_app_browser',
  'memories',
  'multi_agent',
  'multi_agent_v2',
  'network_proxy',
  'plugin_sharing',
  'plugins',
  'remote_plugin',
  'request_permissions_tool',
  'shell_snapshot',
  'shell_tool',
  'shell_zsh_fork',
  'skill_mcp_dependency_install',
  'skill_search',
  'standalone_web_search',
  'tool_call_mcp_elicitation',
  'tool_suggest',
  'unified_exec',
  'unified_exec_zsh_fork',
  'workspace_dependencies'
] as const

type CodexOverrideValue = string | number | boolean | readonly []

interface CodexSecurityOverride {
  path: string
  value: CodexOverrideValue
}

const CODEX_SHARED_SECURITY_OVERRIDES: readonly CodexSecurityOverride[] = [
  { path: 'model_provider', value: OFFICIAL_CODEX_MODEL_PROVIDER },
  { path: 'project_doc_max_bytes', value: 0 },
  { path: 'project_doc_fallback_filenames', value: [] },
  { path: 'web_search', value: 'disabled' },
  { path: 'shell_environment_policy.include_only', value: [] },
  { path: 'agents.enabled', value: false },
  ...DISABLED_CODEX_FEATURES.map((feature) => ({
    path: `features.${feature}`,
    value: false as const
  }))
]

function tomlLiteral(value: CodexOverrideValue): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return '[]'
  return String(value)
}

function setNestedValue(
  target: Record<string, unknown>,
  path: string,
  value: CodexOverrideValue
): void {
  const segments = path.split('.')
  let cursor = target
  for (const segment of segments.slice(0, -1)) {
    const current = cursor[segment]
    if (
      typeof current !== 'object' ||
      current === null ||
      Array.isArray(current)
    ) {
      cursor[segment] = {}
    }
    cursor = cursor[segment] as Record<string, unknown>
  }
  cursor[segments.at(-1)!] = value
}

export function isSafeCodexMcpServerName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 200 &&
    /^[A-Za-z0-9_-]+$/.test(name) &&
    name !== '__proto__' &&
    name !== 'prototype' &&
    name !== 'constructor'
  )
}

export function buildCodexProcessOverrides(
  disabledMcpServerNames: readonly string[]
): string[] {
  const overrides = [
    `chatgpt_base_url=${JSON.stringify(OFFICIAL_CHATGPT_BASE_URL)}`,
    `approval_policy=${JSON.stringify(CODEX_APPROVAL_POLICY)}`,
    `sandbox_mode=${JSON.stringify(CODEX_SANDBOX_MODE)}`,
    ...CODEX_SHARED_SECURITY_OVERRIDES.map(
      ({ path, value }) => `${path}=${tomlLiteral(value)}`
    )
  ]
  for (const name of disabledMcpServerNames) {
    if (!isSafeCodexMcpServerName(name)) {
      throw new Error('Codex MCP isolation received an unsafe server name.')
    }
    overrides.push(`mcp_servers.${name}.enabled=false`)
  }
  return overrides
}

export function buildCodexThreadSecurityConfig(
  disabledMcpServerNames: readonly string[]
): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  for (const override of CODEX_SHARED_SECURITY_OVERRIDES) {
    setNestedValue(config, override.path, override.value)
  }
  const mcpServers: Record<string, unknown> = {}
  for (const name of disabledMcpServerNames) {
    if (!isSafeCodexMcpServerName(name)) {
      throw new Error('Codex MCP isolation received an unsafe server name.')
    }
    mcpServers[name] = { enabled: false }
  }
  config.mcp_servers = mcpServers
  return config
}

export function codexDisabledFeatureNames(): readonly string[] {
  return DISABLED_CODEX_FEATURES
}
