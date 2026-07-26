import { beforeEach, describe, expect, it, vi } from 'vitest'

const svgRendererMock = vi.hoisted(() => ({
  prepareExport: vi.fn(),
  setFontMapping: vi.fn(),
  group: vi.fn(() => ({})),
  image: vi.fn((_blob: Blob, _style: unknown) => ({})),
  exportAsync: vi.fn(async () => `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -10 10 10">
  <rect x="0" y="-10" width="10" height="10" fill="#ffffff"/>
  <g transform="matrix(1,0,0,-1,0,0)">
    <path d="M0 0 L10 10"/>
  </g>
</svg>`)
}))

vi.mock('@mlightcad/cad-svg-plugin', () => ({
  AcSvgRenderer: class {
    static prepareExport = svgRendererMock.prepareExport

    ltscale = 1
    celtscale = 1
    showLineWeight = false
    currentBackgroundColor = 0xffffff

    changeForeground() {}

    setFontMapping = svgRendererMock.setFontMapping
    group = svgRendererMock.group
    image = svgRendererMock.image
    exportAsync = svgRendererMock.exportAsync
  }
}))

vi.mock('@mlightcad/cad-simple-viewer', () => ({
  AcApSettingManager: {
    instance: {
      fontMapping: { romans: 'Arial' }
    }
  }
}))

import { renderSheet } from '../renderSheet'
import type { SheetDefinition } from '../types'

const SHEET: SheetDefinition = {
  paper: 'A4',
  orientation: 'landscape',
  marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
  scaleDenominator: 100,
  drawingUnit: 'm',
  viewportCenter: 'extents'
}

describe('renderSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders entities through AcSvgRenderer into the exact sheet viewport', async () => {
    const worldDraw = vi.fn()
    const doc = {
      database: {
        tables: {
          blockTable: {
            modelSpace: {
              newIterator: () => [{ worldDraw }]
            }
          }
        },
        extents: {
          min: { x: 0, y: 0 },
          max: { x: 10, y: 10 }
        },
        ltscale: 2,
        celtscale: 3,
        lwdisplay: true
      }
    }

    const first = await renderSheet(doc, SHEET)
    const second = await renderSheet(doc, SHEET)

    expect(svgRendererMock.prepareExport).toHaveBeenCalledTimes(2)
    expect(svgRendererMock.setFontMapping).toHaveBeenCalledWith({
      romans: 'Arial'
    })
    expect(worldDraw).toHaveBeenCalledTimes(2)
    expect(first.warnings).toEqual([])
    expect(first.svg).toBe(second.svg)
    expect(first.svg).toContain(
      'width="297mm" height="210mm" viewBox="0 0 297 210"'
    )
    expect(first.svg).toContain(
      'x="10" y="10" width="277" height="190"'
    )
    expect(first.svg).toContain(
      'viewBox="-8.85 -14.5 27.7 19"'
    )
    expect(first.svg).toContain('preserveAspectRatio="none"')
    expect(first.svg).toContain(
      'clip-path="url(#envcad-sheet-printable-clip)"'
    )
    expect(first.svg).toContain('<path d="M0 0 L10 10"/>')
  })

  it('feeds raster images to the renderer in model-space traversal order', async () => {
    const style = {
      boundary: [],
      roation: 0
    }
    const firstBlob = new Blob(['first'], { type: 'image/first' })
    const secondBlob = new Blob(['second'], { type: 'image/second' })
    const doc = {
      database: {
        tables: {
          blockTable: {
            modelSpace: {
              newIterator: () => [
                {
                  worldDraw: (renderer: { image: Function }) =>
                    renderer.image(firstBlob, style)
                },
                {
                  worldDraw: (renderer: { image: Function }) =>
                    renderer.image(secondBlob, style)
                }
              ]
            }
          }
        },
        extents: {
          min: { x: 0, y: 0 },
          max: { x: 1, y: 1 }
        }
      }
    }

    await renderSheet(doc, SHEET)

    expect(svgRendererMock.image.mock.calls.map(call => call[0].type)).toEqual([
      'image/first',
      'image/second'
    ])
    expect(svgRendererMock.exportAsync).toHaveBeenCalledTimes(3)
  })
})
