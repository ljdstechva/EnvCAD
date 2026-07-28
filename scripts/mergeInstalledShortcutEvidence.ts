import { createHash } from 'node:crypto'
import {
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import path from 'node:path'
import type { ProviderId } from '../src/agent/protocol'

interface ScreenshotEvidence {
  path: string
  sha256: string
  bytes: number
}

interface InstalledShortcutEvidence {
  schemaVersion: 1
  status: 'passed'
  generatedAt: string
  launch: {
    method: 'windows-computer-use-shortcut'
    shortcutPath: string
    shortcutTarget: string
    windowApp: string
    windowTitle: string
    processIds: number[]
  }
  providerRuns: Array<{
    provider: ProviderId
    liveCall: true
    fixture: string
    conversationTurn: number
    model: string
    effort?: string
    promptSha256: string
    response: string
    responseSha256: string
    toolSummary: string
    screenshot: ScreenshotEvidence
  }>
  cleanup: {
    closedNormally: true
    remainingEnvCadProcesses: 0
    remainingRuntimeSessions: 0
    remainingClaudeTranscriptDirectories: 0
    newOrModifiedClaudeTranscriptFiles: 0
    sidecarPorts: number[]
    sidecarPortsClosed: true
  }
}

function parseArgs(argv: string[]): { report: string; evidence: string } {
  const values: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--report' || argument === '--evidence') {
      values[argument.slice(2)] = argv[++index]
    } else if (argument.startsWith('--report=')) {
      values.report = argument.slice('--report='.length)
    } else if (argument.startsWith('--evidence=')) {
      values.evidence = argument.slice('--evidence='.length)
    } else {
      throw new Error(`Unknown shortcut evidence argument: ${argument}`)
    }
  }
  if (!values.report || !values.evidence) {
    throw new Error('Usage: --report <installed report> --evidence <OS UI evidence>')
  }
  return {
    report: path.resolve(values.report),
    evidence: path.resolve(values.evidence)
  }
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function sameWindowsPath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
}

async function verifyScreenshot(screenshot: ScreenshotEvidence): Promise<void> {
  const bytes = await readFile(path.resolve(screenshot.path))
  if (
    bytes.byteLength !== screenshot.bytes ||
    sha256(bytes) !== screenshot.sha256
  ) {
    throw new Error(`Shortcut evidence screenshot failed integrity validation.`)
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    await rename(temporaryPath, filePath)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {})
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  await Promise.all([stat(options.report), stat(options.evidence)])
  const report = JSON.parse(await readFile(options.report, 'utf8')) as {
    status?: string
    launch?: {
      requestedExecutable?: string
      applicationExecutable?: string
      [key: string]: unknown
    }
    [key: string]: unknown
  }
  const evidence = JSON.parse(
    await readFile(options.evidence, 'utf8')
  ) as InstalledShortcutEvidence
  if (
    report.status !== 'passed' ||
    evidence.schemaVersion !== 1 ||
    evidence.status !== 'passed' ||
    evidence.launch.method !== 'windows-computer-use-shortcut'
  ) {
    throw new Error('Installed acceptance or shortcut evidence is not passed.')
  }
  const installedExecutable = report.launch?.applicationExecutable
  const requestedExecutable = report.launch?.requestedExecutable
  if (
    !installedExecutable ||
    !requestedExecutable ||
    !sameWindowsPath(evidence.launch.shortcutTarget, requestedExecutable) ||
    !sameWindowsPath(evidence.launch.windowApp, installedExecutable)
  ) {
    throw new Error('Shortcut evidence did not target the installed EnvCAD executable.')
  }
  if (!evidence.launch.shortcutPath.toLowerCase().endsWith('.lnk')) {
    throw new Error('Shortcut evidence did not name a Windows shortcut.')
  }

  const providers = new Set<ProviderId>()
  for (const run of evidence.providerRuns) {
    providers.add(run.provider)
    if (
      run.liveCall !== true ||
      !run.response.trim() ||
      sha256(run.response) !== run.responseSha256 ||
      !/^[a-f0-9]{64}$/.test(run.promptSha256) ||
      !/inspect_sheet_preview/i.test(run.toolSummary)
    ) {
      throw new Error(`Invalid ${run.provider} installed shortcut provider evidence.`)
    }
    await verifyScreenshot(run.screenshot)
  }
  if (!providers.has('claude-code') || !providers.has('openai-codex')) {
    throw new Error('Installed shortcut evidence must include both live providers.')
  }
  if (
    evidence.cleanup.closedNormally !== true ||
    evidence.cleanup.remainingEnvCadProcesses !== 0 ||
    evidence.cleanup.remainingRuntimeSessions !== 0 ||
    evidence.cleanup.remainingClaudeTranscriptDirectories !== 0 ||
    evidence.cleanup.newOrModifiedClaudeTranscriptFiles !== 0 ||
    evidence.cleanup.sidecarPortsClosed !== true
  ) {
    throw new Error('Installed shortcut cleanup evidence did not pass.')
  }

  report.launch = {
    ...report.launch,
    usedInstalledShortcutForLiveProviderRuns: true,
    installedShortcutEvidencePath: options.evidence
  }
  report.installedShortcutUi = evidence
  await writeJsonAtomic(options.report, report)
  console.log(
    JSON.stringify({
      status: 'passed',
      report: options.report,
      evidence: options.evidence,
      providers: [...providers],
      screenshots: evidence.providerRuns.length
    })
  )
}

await main()
