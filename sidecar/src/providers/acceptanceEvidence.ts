import { createHash } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  AgentConfiguration,
  ProviderId,
  ToolResult
} from '../../../src/agent/protocol'
import { ACCEPTANCE_EVIDENCE_ENVIRONMENT_NAME } from './environment'

const USER_CONTEXT_MARKER = '\n\n<context>\n'

export interface ProviderPromptEvidence {
  evidenceType: 'prompt'
  recordedAt: string
  provider: ProviderId
  promptCharacters: number
  promptUtf8Bytes: number
  promptSha256: string
  userTextCharacters: number
  userTextUtf8Bytes: number
  userTextSha256: string
  beginSentinelIndex: number
  middleSentinelIndex: number
  endSentinelIndex: number
}

export interface ProviderVisualEvidence {
  evidenceType: 'visual-image'
  recordedAt: string
  provider: ProviderId
  requestedModel: string
  effort?: string
  transport: 'claude-mcp-image' | 'codex-dynamic-inputImage'
  mimeType: 'image/png' | 'image/webp'
  width: number
  height: number
  byteLength: number
  rasterSha256: string
  svgSha256?: string
  captureId: string
  renderRevision: number
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function buildProviderPromptEvidence(
  provider: ProviderId,
  prompt: string
): ProviderPromptEvidence {
  const contextIndex = prompt.lastIndexOf(USER_CONTEXT_MARKER)
  const userText =
    contextIndex >= 0 ? prompt.slice(0, contextIndex) : prompt
  return {
    evidenceType: 'prompt',
    recordedAt: new Date().toISOString(),
    provider,
    promptCharacters: prompt.length,
    promptUtf8Bytes: Buffer.byteLength(prompt, 'utf8'),
    promptSha256: sha256(prompt),
    userTextCharacters: userText.length,
    userTextUtf8Bytes: Buffer.byteLength(userText, 'utf8'),
    userTextSha256: sha256(userText),
    beginSentinelIndex: userText.indexOf('BEGIN-LONG-PROMPT-SENTINEL'),
    middleSentinelIndex: userText.indexOf('MIDDLE-LONG-PROMPT-SENTINEL'),
    endSentinelIndex: userText.indexOf('END-LONG-PROMPT-SENTINEL')
  }
}

export function buildProviderVisualEvidence(input: {
  provider: ProviderId
  configuration: AgentConfiguration
  transport: ProviderVisualEvidence['transport']
  result: ToolResult
}): ProviderVisualEvidence {
  if (!input.result.image || input.result.error) {
    throw new Error('Visual provider evidence requires one successful image result.')
  }
  const metadata =
    input.result.data &&
    typeof input.result.data === 'object' &&
    !Array.isArray(input.result.data)
      ? (input.result.data as Record<string, unknown>)
      : undefined
  return {
    evidenceType: 'visual-image',
    recordedAt: new Date().toISOString(),
    provider: input.provider,
    requestedModel: input.configuration.model,
    ...(input.configuration.effort
      ? { effort: input.configuration.effort }
      : {}),
    transport: input.transport,
    mimeType: input.result.image.mimeType,
    width: input.result.image.width,
    height: input.result.image.height,
    byteLength: input.result.image.byteLength,
    rasterSha256: input.result.image.sha256,
    ...(typeof metadata?.svgSha256 === 'string'
      ? { svgSha256: metadata.svgSha256 }
      : {}),
    captureId: input.result.image.captureId,
    renderRevision: input.result.image.renderRevision
  }
}

function evidenceDestination(environment: NodeJS.ProcessEnv): string | undefined {
  const requestedPath = environment[ACCEPTANCE_EVIDENCE_ENVIRONMENT_NAME]
  if (!requestedPath) return undefined
  if (
    requestedPath.length > 4_000 ||
    !path.isAbsolute(requestedPath) ||
    path.extname(requestedPath).toLowerCase() !== '.jsonl'
  ) {
    throw new Error(
      `${ACCEPTANCE_EVIDENCE_ENVIRONMENT_NAME} must be an absolute .jsonl path.`
    )
  }
  return requestedPath
}

export async function recordProviderPromptEvidence(
  provider: ProviderId,
  prompt: string,
  environment: NodeJS.ProcessEnv
): Promise<void> {
  const requestedPath = evidenceDestination(environment)
  if (!requestedPath) return
  const evidence = buildProviderPromptEvidence(provider, prompt)
  await appendFile(requestedPath, `${JSON.stringify(evidence)}\n`, {
    encoding: 'utf8',
    flag: 'a'
  })
}

export async function recordProviderVisualEvidence(
  input: Parameters<typeof buildProviderVisualEvidence>[0],
  environment: NodeJS.ProcessEnv
): Promise<void> {
  const requestedPath = evidenceDestination(environment)
  if (!requestedPath) return
  const evidence = buildProviderVisualEvidence(input)
  await appendFile(requestedPath, `${JSON.stringify(evidence)}\n`, {
    encoding: 'utf8',
    flag: 'a'
  })
}
