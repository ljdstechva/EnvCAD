import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturePath = join(__dirname, 'fixtures', 'sample-site.dxf')

function countGroupPairs(content: string, code8Value: string) {
  const pattern = new RegExp(`\\n8\\n${code8Value}\\n`, 'g')
  return (content.match(pattern) ?? []).length
}

describe('sample-site.dxf fixture', () => {
  const content = readFileSync(fixturePath, 'utf-8')

  it('is well-formed DXF with a Model layout and owned entities', () => {
    expect(content).toMatch(/0\nSECTION\n2\nHEADER/)
    expect(content).toMatch(/0\nTABLE\n2\nLAYER/)
    expect(content).toMatch(/0\nTABLE\n2\nBLOCK_RECORD/)
    expect(content).toMatch(/0\nSECTION\n2\nBLOCKS/)
    expect(content).toMatch(/0\nBLOCK_RECORD\n5\n10[\s\S]*2\n\*Model_Space/)
    expect(content).toMatch(/0\nSECTION\n2\nENTITIES/)
    expect(content.trim().endsWith('0\nEOF')).toBe(true)
    const entities = content.match(
      /0\nSECTION\n2\nENTITIES\n([\s\S]*?)0\nENDSEC/
    )?.[1]
    expect((entities?.match(/\n330\n10\n/g) ?? []).length).toBe(7)
  })

  it('declares the four expected layers', () => {
    for (const layer of ['BOUNDARY', 'BUILDINGS', 'ANNOTATION', 'FACILITIES']) {
      expect(content).toContain(`2\n${layer}\n`)
    }
  })

  it('places the expected entity counts on each layer', () => {
    expect(countGroupPairs(content, 'BOUNDARY')).toBe(1) // closed site boundary polyline
    expect(countGroupPairs(content, 'BUILDINGS')).toBe(2) // two building rectangles
    expect(countGroupPairs(content, 'ANNOTATION')).toBe(3) // MTEXT labels
    expect(countGroupPairs(content, 'FACILITIES')).toBe(1) // circular tank
  })
})
