import { createHash } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import type { ProviderId } from '../../../src/agent/protocol'
import { ACCEPTANCE_EVIDENCE_ENVIRONMENT_NAME } from './environment'

const USER_CONTEXT_MARKER = '\n\n<context>\n'

export interface ProviderPromptEvidence {
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

export async function recordProviderPromptEvidence(
  provider: ProviderId,
  prompt: string,
  environment: NodeJS.ProcessEnv
): Promise<void> {
  const requestedPath = environment[ACCEPTANCE_EVIDENCE_ENVIRONMENT_NAME]
  if (!requestedPath) return
  if (
    requestedPath.length > 4_000 ||
    !path.isAbsolute(requestedPath) ||
    path.extname(requestedPath).toLowerCase() !== '.jsonl'
  ) {
    throw new Error(
      `${ACCEPTANCE_EVIDENCE_ENVIRONMENT_NAME} must be an absolute .jsonl path.`
    )
  }
  const evidence = buildProviderPromptEvidence(provider, prompt)
  await appendFile(requestedPath, `${JSON.stringify(evidence)}\n`, {
    encoding: 'utf8',
    flag: 'a'
  })
}
