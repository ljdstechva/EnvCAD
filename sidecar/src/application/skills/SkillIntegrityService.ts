import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import type { RegisteredSkill } from '../../domain/skills/SkillManifest'

export interface SkillSourceFileSystem {
  stat(path: string): { size: number; mtimeMs: number }
  read(path: string): Buffer
}

interface FileEvidence {
  size: number
  mtimeMs: number
  sha256: string
}

export interface SkillIntegrityResult {
  verified: boolean
  changed: boolean
  reason?: string
}

export class SkillIntegrityService {
  private readonly evidence = new Map<string, FileEvidence>()

  constructor(
    private readonly files: SkillSourceFileSystem = {
      stat: (path) => statSync(path),
      read: (path) => readFileSync(path)
    }
  ) {}

  verify(
    skill: RegisteredSkill,
    forceDigest = false
  ): SkillIntegrityResult {
    if (!skill.sourceFiles?.length) {
      const digest = createHash('sha256')
        .update(skill.manifest.promptFragment, 'utf8')
        .digest('hex')
      return digest === skill.manifest.sha256
        ? { verified: true, changed: false }
        : {
            verified: false,
            changed: true,
            reason: `${skill.manifest.id} bundled policy digest changed.`
          }
    }
    let changed = false
    for (const source of skill.sourceFiles) {
      try {
        const metadata = this.files.stat(source.path)
        const previous = this.evidence.get(source.path)
        const metadataChanged =
          !previous ||
          previous.size !== metadata.size ||
          previous.mtimeMs !== metadata.mtimeMs
        changed ||= metadataChanged
        if (!forceDigest && !metadataChanged && previous) continue
        const actual = createHash('sha256')
          .update(this.files.read(source.path))
          .digest('hex')
        const confirmed = this.files.stat(source.path)
        if (
          confirmed.size !== metadata.size ||
          confirmed.mtimeMs !== metadata.mtimeMs
        ) {
          return {
            verified: false,
            changed: true,
            reason: `${skill.manifest.id} source changed during verification.`
          }
        }
        if (actual !== source.sha256) {
          return {
            verified: false,
            changed: true,
            reason: `${skill.manifest.id} source integrity failed.`
          }
        }
        this.evidence.set(source.path, {
          size: confirmed.size,
          mtimeMs: confirmed.mtimeMs,
          sha256: actual
        })
      } catch {
        return {
          verified: false,
          changed: true,
          reason: `${skill.manifest.id} source is unavailable.`
        }
      }
    }
    return { verified: true, changed }
  }
}
