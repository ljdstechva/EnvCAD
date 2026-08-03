import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { RegisteredSkill } from '../domain/skills/SkillManifest'
import { SkillIntegrityService } from '../application/skills/SkillIntegrityService'
import { SkillRegistry } from '../application/skills/SkillRegistry'

const sha256 = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex')

function skill(
  id: 'cad-core' | 'dxf-core',
  sourcePath: string,
  digest: string
): RegisteredSkill {
  return {
    displayName: id,
    mandatory: true,
    sourceFiles: [{ path: sourcePath, sha256: digest }],
    manifest: {
      id,
      version: '1.0.0',
      sourceProvenance: 'test fixture',
      sha256: digest,
      supportedIntents: ['*'],
      requiredCapabilities: [],
      allowedTools: ['move_entities'],
      preconditions: ['test'],
      validationRules: ['test'],
      dataAccessScope: ['test'],
      retrySafety: 'idempotent-required',
      promptFragment: `${id} verified test fragment`,
      degradedBehavior: 'Block AI mutation.'
    }
  }
}

function conversationCommand(text = 'hello') {
  return {
    type: 'submit_turn' as const,
    text,
    referenceInputIds: [],
    configurationRevision: 1,
    selectionSnapshot: {
      count: 0,
      units: 'Meters',
      revision: {
        documentId: 'drawing-1',
        documentRevision: 1,
        contentRevision: 1,
        sheetRevision: 1,
        viewRevision: 1
      }
    },
    sheet: {
      paper: 'A3',
      orientation: 'landscape' as const,
      scaleDenominator: 500,
      drawingUnit: 'm'
    }
  }
}

describe('SkillRegistry', () => {
  it('activates both mandatory skills on every intent and routes conditional skills', () => {
    const registry = new SkillRegistry()
    registry.initialize()

    expect(
      registry.activate(conversationCommand()).activations.map(
        ({ skillId }) => skillId
      )
    ).toEqual(['cad-core', 'dxf-core'])

    const edit = registry.activate(
      conversationCommand('Move the selected annotation to layer NOTES.')
    )
    expect([...edit.activeSkillIds]).toEqual(
      expect.arrayContaining([
        'cad-core',
        'dxf-core',
        'drawing-analysis',
        'geometry-editing',
        'layer-hygiene',
        'annotation'
      ])
    )
    expect(edit.promptFragment).not.toContain(
      '# CAD generation, inspection, and validation'
    )
  })

  it('routes a stored large instruction from its bounded local classification text', () => {
    const registry = new SkillRegistry()
    const { text: _text, ...base } = conversationCommand()
    const routed = registry.activate(
      {
        ...base,
        instructionInputId: 'input-large-instruction'
      },
      '2026-07-29T08:00:00.000Z',
      'Move the selected annotation to layer NOTES and verify its visual placement.'
    )

    expect(routed.intent).toBe('additive-edit')
    expect([...routed.activeSkillIds]).toEqual(
      expect.arrayContaining([
        'cad-core',
        'dxf-core',
        'drawing-analysis',
        'geometry-editing',
        'layer-hygiene',
        'annotation',
        'visual-quality-assurance'
      ])
    )
  })

  it('uses cached evidence while metadata is unchanged and rehashes before mutation', () => {
    let contents = Buffer.from('verified skill', 'utf8')
    let mtimeMs = 1
    let reads = 0
    const files = {
      stat: () => ({ size: contents.length, mtimeMs }),
      read: () => {
        reads += 1
        return contents
      }
    }
    const integrity = new SkillIntegrityService(files)
    const registered = skill('cad-core', 'virtual/cad', sha256('verified skill'))

    expect(integrity.verify(registered, true).verified).toBe(true)
    expect(integrity.verify(registered, false)).toEqual({
      verified: true,
      changed: false
    })
    expect(reads).toBe(1)

    expect(integrity.verify(registered, true).verified).toBe(true)
    expect(reads).toBe(2)

    contents = Buffer.from('corrupt skill!', 'utf8')
    mtimeMs += 1
    expect(integrity.verify(registered, false)).toMatchObject({
      verified: false,
      changed: true
    })
  })

  it('degrades a corrupt mandatory skill and blocks only AI mutation', () => {
    let contents = Buffer.from('trusted', 'utf8')
    let mtimeMs = 1
    const files = {
      stat: () => ({ size: contents.length, mtimeMs }),
      read: () => contents
    }
    const digest = sha256('trusted')
    const registry = new SkillRegistry(
      [
        skill('cad-core', 'virtual/cad', digest),
        skill('dxf-core', 'virtual/dxf', digest)
      ],
      new SkillIntegrityService(files)
    )
    registry.initialize()
    expect(registry.activate(conversationCommand()).mutationBlockedReason).toBeUndefined()

    contents = Buffer.from('altered', 'utf8')
    mtimeMs += 1
    const degraded = registry.activate(conversationCommand())
    expect(degraded.mutationBlockedReason).toContain(
      'manual CAD remains available'
    )
    expect(
      degraded.activations.every(({ integrity }) => integrity === 'failed')
    ).toBe(true)
    expect(
      registry.verifyBeforeMutation(['cad-core', 'dxf-core'])
    ).toMatchObject({ allowed: false })
  })
})
