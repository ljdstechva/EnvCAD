const SAFE_ENVIRONMENT_NAMES = [
  'APPDATA',
  'COMSPEC',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PATH',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'WINDIR'
] as const

export const BLOCKED_SECRET_ENVIRONMENT_NAMES = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN'
] as const

function getEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  requestedName: string
): string | undefined {
  const key = Object.keys(environment).find(
    (name) => name.toLowerCase() === requestedName.toLowerCase()
  )
  return key ? environment[key] : undefined
}

export function sanitizedProviderEnvironment(
  environment: NodeJS.ProcessEnv,
  additions: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const safe = Object.fromEntries(
    SAFE_ENVIRONMENT_NAMES.flatMap((name) => {
      const value = getEnvironmentValue(environment, name)
      return value ? [[name, value]] : []
    })
  )
  for (const [name, value] of Object.entries(additions)) {
    if (value !== undefined) safe[name] = value
  }
  for (const blocked of BLOCKED_SECRET_ENVIRONMENT_NAMES) delete safe[blocked]
  return safe
}

export function presentBlockedEnvironmentNames(
  environment: NodeJS.ProcessEnv,
  names: readonly string[] = BLOCKED_SECRET_ENVIRONMENT_NAMES
): string[] {
  return names.filter((name) => Boolean(getEnvironmentValue(environment, name)?.trim()))
}

export function redactProviderDiagnostic(value: unknown): string {
  return String(value)
    .replace(/\bsk-(?:ant|proj|svcacct)-[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/\b(?:Bearer\s+)?eyJ[A-Za-z0-9._-]+\b/gi, '[redacted]')
}
