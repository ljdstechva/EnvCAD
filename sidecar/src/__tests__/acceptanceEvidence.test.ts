import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildProviderPromptEvidence,
  buildProviderVisualEvidence,
  recordProviderPromptEvidence
} from '../providers/acceptanceEvidence'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('provider prompt acceptance evidence', () => {
  it('records only hashes, lengths, and sentinel positions at the provider boundary', async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'envcad-provider-evidence-')
    )
    directories.push(directory)
    const evidencePath = path.join(directory, 'evidence.jsonl')
    const userText =
      `BEGIN-LONG-PROMPT-SENTINEL\n${'α🌏\n'.repeat(2_000)}` +
      'MIDDLE-LONG-PROMPT-SENTINEL\n' +
      `${'x'.repeat(8_000)}\nEND-LONG-PROMPT-SENTINEL`
    const prompt = `${userText}\n\n<context>\nSelection attached: none.\n</context>`

    await recordProviderPromptEvidence('openai-codex', prompt, {
      ENVCAD_ACCEPTANCE_EVIDENCE_PATH: evidencePath
    })

    const raw = await readFile(evidencePath, 'utf8')
    const evidence = JSON.parse(raw.trim())
    expect(evidence).toEqual(
      expect.objectContaining({
        evidenceType: 'prompt',
        provider: 'openai-codex',
        promptCharacters: prompt.length,
        promptUtf8Bytes: Buffer.byteLength(prompt, 'utf8'),
        userTextCharacters: userText.length,
        userTextUtf8Bytes: Buffer.byteLength(userText, 'utf8'),
        beginSentinelIndex: 0,
        middleSentinelIndex: expect.any(Number),
        endSentinelIndex: expect.any(Number),
        promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        userTextSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    )
    expect(evidence.middleSentinelIndex).toBeGreaterThan(
      evidence.beginSentinelIndex
    )
    expect(evidence.endSentinelIndex).toBeGreaterThan(
      evidence.middleSentinelIndex
    )
    expect(raw).not.toContain(userText)
    expect(raw).not.toContain('Selection attached')
  })

  it('derives the user-text hash from the final context delimiter', () => {
    const prompt =
      'text with an earlier\n\n<context>\nmarker' +
      '\n\n<context>\nSelection attached: none.\n</context>'
    const evidence = buildProviderPromptEvidence('claude-code', prompt)
    expect(evidence.userTextCharacters).toBe(
      'text with an earlier\n\n<context>\nmarker'.length
    )
  })

  it('rejects unsafe evidence destinations', async () => {
    await expect(
      recordProviderPromptEvidence('claude-code', 'prompt', {
        ENVCAD_ACCEPTANCE_EVIDENCE_PATH: 'relative.jsonl'
      })
    ).rejects.toThrow('absolute .jsonl path')
  })

  it('records only bounded hashes and dimensions for provider-native image transport', () => {
    const evidence = buildProviderVisualEvidence({
      provider: 'openai-codex',
      configuration: {
        provider: 'openai-codex',
        model: 'gpt-test',
        effort: 'xhigh'
      },
      transport: 'codex-dynamic-inputImage',
      result: {
        data: {
          svgSha256: '1'.repeat(64),
          privateDrawingText: 'DO-NOT-RECORD'
        },
        image: {
          mimeType: 'image/png',
          base64: 'DO-NOT-RECORD-BASE64',
          byteLength: 1234,
          width: 1400,
          height: 990,
          aspectRatio: 1400 / 990,
          sha256: '2'.repeat(64),
          captureId: 'sheet-7-full-2222222222222222',
          renderRevision: 7
        }
      }
    })
    expect(evidence).toEqual(
      expect.objectContaining({
        evidenceType: 'visual-image',
        provider: 'openai-codex',
        requestedModel: 'gpt-test',
        effort: 'xhigh',
        transport: 'codex-dynamic-inputImage',
        width: 1400,
        height: 990,
        byteLength: 1234,
        rasterSha256: '2'.repeat(64),
        svgSha256: '1'.repeat(64),
        renderRevision: 7
      })
    )
    expect(JSON.stringify(evidence)).not.toContain('DO-NOT-RECORD')
  })
})
