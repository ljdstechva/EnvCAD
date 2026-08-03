import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Pinned upstream CAD and DXF skills. EnvCAD never exposes their upstream
 * filesystem, shell, plugin, or delegation capabilities to a provider.
 */
export const TEXT_TO_CAD_SKILL = {
  name: 'CAD Skills',
  repository: 'earthtojake/text-to-cad',
  version: '0.3.9',
  commit: 'fdbb4b4fb62d95ae298cfe9a46fdc7092bdaf423',
  license: 'MIT',
  profile: 'envcad-native-cad-dxf',
  sources: {
    cad: {
      relativePath: 'skills/cad/SKILL.md',
      gitBlobSha: 'f9b01fe98d5991c08a10396c8d4e1a502afc55d3',
      sha256: 'f6ba5a9a2042d1a955f511a929f3061677871c2cd3674b09cf70b0c4c6690ecd'
    },
    dxf: {
      relativePath: 'skills/dxf/SKILL.md',
      gitBlobSha: '74121d2e3e0507fe509af934a42d1232332b760c',
      sha256: '12f88bb9d93b42c22b60e6ce4dad7ff3dacfe1cc4eab66afca6787cf243ee453'
    }
  }
} as const

export interface BundledTextToCadSkillSources {
  cad: string
  dxf: string
  root: string
}

const sourceEvidence = new Map<string, { size: number; mtimeMs: number }>()

function candidateRoots(): string[] {
  const runtimeProcess = process as NodeJS.Process & { resourcesPath?: string }
  return [
    ...process.argv
      .filter((value) => value.toLowerCase().endsWith('app.asar'))
      .map((value) => path.join(value, 'vendor', 'text-to-cad')),
    ...(runtimeProcess.resourcesPath
      ? [
          path.join(
            runtimeProcess.resourcesPath,
            'app.asar',
            'vendor',
            'text-to-cad'
          )
        ]
      : []),
    path.join(process.cwd(), 'vendor', 'text-to-cad')
  ].map((candidate) => path.resolve(candidate))
}

function locateRoot(): string {
  const unique = [...new Set(candidateRoots())]
  return (
    unique.find((root) =>
      Object.values(TEXT_TO_CAD_SKILL.sources).every((source) =>
        existsSync(path.join(root, source.relativePath))
      )
    ) ?? unique.at(-1)!
  )
}

function gitBlobSha(contents: string): string {
  const header = `blob ${Buffer.byteLength(contents, 'utf8')}\0`
  return createHash('sha1')
    .update(header, 'utf8')
    .update(contents, 'utf8')
    .digest('hex')
}

function readVerifiedSource(
  source: (typeof TEXT_TO_CAD_SKILL.sources)[keyof typeof TEXT_TO_CAD_SKILL.sources]
): string {
  const contents = readFileSync(
    path.join(locateRoot(), source.relativePath),
    'utf8'
  )
  if (gitBlobSha(contents) !== source.gitBlobSha) {
    throw new Error(
      `Bundled CAD Skills integrity check failed for ${source.relativePath}.`
    )
  }
  const sha256 = createHash('sha256').update(contents, 'utf8').digest('hex')
  if (sha256 !== source.sha256) {
    throw new Error(
      `Bundled CAD Skills SHA-256 check failed for ${source.relativePath}.`
    )
  }
  return contents
}

export function loadBundledTextToCadSkillSources(): BundledTextToCadSkillSources {
  return {
    cad: readVerifiedSource(TEXT_TO_CAD_SKILL.sources.cad),
    dxf: readVerifiedSource(TEXT_TO_CAD_SKILL.sources.dxf),
    root: locateRoot()
  }
}

/**
 * Small provider-safe compatibility fragment. The complete upstream sources
 * remain local and authoritative; the SkillRegistry compiles verified turn
 * manifests instead of reinjecting the source corpus.
 */
export const TEXT_TO_CAD_SKILL_INSTRUCTIONS = `## Pinned CAD workflow

EnvCAD uses the integrity-verified earthtojake/text-to-cad CAD and DXF skills,
pinned at ${TEXT_TO_CAD_SKILL.commit}, through its native 2D compatibility
layer. Use only EnvCAD's allowlisted native CAD, drawing-read, vision, and
input-retrieval capabilities. Upstream shell, filesystem, Python, plugin,
external viewer, 3D, STEP, mesh, and delegation workflows are unavailable.
Read exact revision-bound drawing data before edits, preserve units and entity
IDs, validate postconditions, use visual evidence only when captured, and
report only checks that actually ran.`

export function invokeTextToCadSkillForTurn(): string {
  assertBundledTextToCadSkillIntegrity(false)
  return (
    `CAD Skills invoked: ${TEXT_TO_CAD_SKILL.repository} ` +
    `v${TEXT_TO_CAD_SKILL.version} (${TEXT_TO_CAD_SKILL.profile}); ` +
    `verified CAD ${TEXT_TO_CAD_SKILL.sources.cad.sha256} and ` +
    `DXF ${TEXT_TO_CAD_SKILL.sources.dxf.sha256}.`
  )
}

export function assertBundledTextToCadSkillIntegrity(
  forceDigest: boolean
): void {
  for (const source of Object.values(TEXT_TO_CAD_SKILL.sources)) {
    const sourcePath = path.join(locateRoot(), source.relativePath)
    const metadata = statSync(sourcePath)
    const previous = sourceEvidence.get(sourcePath)
    if (
      !forceDigest &&
      previous?.size === metadata.size &&
      previous.mtimeMs === metadata.mtimeMs
    ) {
      continue
    }
    readVerifiedSource(source)
    sourceEvidence.set(sourcePath, {
      size: metadata.size,
      mtimeMs: metadata.mtimeMs
    })
  }
}

export function bundledTextToCadSourcePaths(): {
  cad: string
  dxf: string
} {
  const root = locateRoot()
  return {
    cad: path.join(root, TEXT_TO_CAD_SKILL.sources.cad.relativePath),
    dxf: path.join(root, TEXT_TO_CAD_SKILL.sources.dxf.relativePath)
  }
}
