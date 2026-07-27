import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  cleanBenchmarkDxf,
  chooseModel,
  geometryFingerprint,
  inspectDxf,
  recommended,
  resolveBenchmarkLaunchTarget,
  type ModelCatalog,
  type ProviderCatalog
} from '../scripts/aiBenchmark'

const FIXTURE = path.join(process.cwd(), 'test', 'fixtures', 'sample-site.dxf')

describe('AI benchmark DXF inspection', () => {
  it('creates a metre-based clean drawing without carrying fixture entities', async () => {
    const source = await readFile(FIXTURE, 'utf8')
    const original = inspectDxf(source)
    const cleaned = inspectDxf(cleanBenchmarkDxf(source))

    expect(original.entities.length).toBeGreaterThan(0)
    expect(cleaned.acadVersion).toBe('AC1018')
    expect(cleaned.unitsCode).toBe(6)
    expect(cleaned.entities).toEqual([])
    expect(cleaned.layers).toEqual(original.layers)
  })

  it('ignores DXF handles when comparing saved and reopened geometry', () => {
    const first = inspectDxf(
      [
        '0', 'SECTION', '2', 'ENTITIES',
        '0', 'CIRCLE', '5', 'A1', '8', 'AI_BENCHMARK',
        '10', '30', '20', '10', '40', '5',
        '0', 'ENDSEC', '0', 'EOF', ''
      ].join('\r\n')
    )
    const reopened = inspectDxf(
      [
        '0', 'SECTION', '2', 'ENTITIES',
        '0', 'CIRCLE', '5', 'FF', '8', 'AI_BENCHMARK',
        '10', '30', '20', '10', '40', '5',
        '0', 'ENDSEC', '0', 'EOF', ''
      ].join('\r\n')
    )

    expect(geometryFingerprint(first)).toBe(geometryFingerprint(reopened))
  })

  it('launches the exact versioned ASAR behind a Squirrel stub', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'envcad-benchmark-launch-'))
    try {
      const stub = path.join(root, 'EnvCAD.exe')
      const oldDirectory = path.join(root, 'app-0.1.1')
      const currentDirectory = path.join(root, 'app-0.2.0')
      await Promise.all([
        mkdir(path.join(oldDirectory, 'resources'), { recursive: true }),
        mkdir(path.join(currentDirectory, 'resources'), { recursive: true })
      ])
      await Promise.all([
        writeFile(stub, ''),
        writeFile(path.join(oldDirectory, 'EnvCAD.exe'), ''),
        writeFile(path.join(oldDirectory, 'resources', 'app.asar'), ''),
        writeFile(path.join(currentDirectory, 'EnvCAD.exe'), ''),
        writeFile(path.join(currentDirectory, 'resources', 'app.asar'), '')
      ])

      const target = resolveBenchmarkLaunchTarget(stub)

      expect(target.requestedExecutable).toBe(stub)
      expect(target.applicationExecutable).toBe(
        path.join(currentDirectory, 'EnvCAD.exe')
      )
      expect(target.applicationAsar).toBe(
        path.join(currentDirectory, 'resources', 'app.asar')
      )
      expect(target.automationDriver).toMatch(
        /node_modules[\\/]electron[\\/]dist[\\/]electron\.exe$/i
      )
    } finally {
      await rm(root, { recursive: true })
    }
  })

  it('prioritizes the intended fastest-model pattern over catalog order', () => {
    const model = (id: string): ModelCatalog => ({
      id,
      invocationName: id,
      displayName: id,
      description: '',
      isDefault: id === 'gpt-5.6-sol',
      efforts: []
    })
    const provider: ProviderCatalog = {
      id: 'openai-codex',
      displayName: 'OpenAI Codex',
      models: [
        model('gpt-5.6-sol'),
        model('gpt-5.6-luna'),
        model('gpt-5.4-mini'),
        model('gpt-5.3-codex-spark')
      ]
    }

    expect(chooseModel(provider, 'fast').id).toBe('gpt-5.3-codex-spark')
  })

  it('selects the quality/latency frontier instead of max effort by rank', () => {
    const result = (
      model: string,
      effort: string | undefined,
      score: number,
      totalMs: number
    ) => ({
      configuration: {
        provider: 'claude-code' as const,
        model,
        ...(effort ? { effort } : {})
      },
      score,
      totalMs,
      issues: []
    })

    expect(
      recommended(
        [
          result('default', undefined, 100, 36_306),
          result('haiku', undefined, 75, 28_247),
          result('opus[1m]', 'max', 100, 46_234)
        ],
        'claude-code'
      )
    ).toEqual({ provider: 'claude-code', model: 'default' })
  })
})
