import { describe, expect, it, vi } from 'vitest'
import {
  progressiveLongestSides,
  rasterDimensions,
  rasterizeSheetSvg,
  svgForRaster,
  viewBoxFor,
  type RasterEncodeRequest
} from '../rasterizeSheet'

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="420mm" height="297mm" viewBox="0 0 420 297">
  <rect x="0" y="0" width="420" height="297" fill="#ffffff"/>
  <circle cx="100" cy="100" r="20" fill="#ff0000"/>
</svg>`

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
  )
  return Array.from(new Uint8Array(digest))
    .map((item) => item.toString(16).padStart(2, '0'))
    .join('')
}

function fakePng(width: number, height: number, byteLength: number): Uint8Array {
  const bytes = new Uint8Array(Math.max(24, byteLength))
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
  bytes.set([73, 72, 68, 82], 12)
  writeUint32BigEndian(bytes, 16, width)
  writeUint32BigEndian(bytes, 20, height)
  return bytes
}

function fakeWebp(width: number, height: number, byteLength: number): Uint8Array {
  const bytes = new Uint8Array(Math.max(30, byteLength))
  bytes.set([82, 73, 70, 70], 0)
  bytes.set([87, 69, 66, 80], 8)
  bytes.set([86, 80, 56, 88], 12)
  writeUint24LittleEndian(bytes, 24, width - 1)
  writeUint24LittleEndian(bytes, 27, height - 1)
  return bytes
}

function writeUint32BigEndian(
  bytes: Uint8Array,
  offset: number,
  value: number
): void {
  bytes[offset] = (value >>> 24) & 0xff
  bytes[offset + 1] = (value >>> 16) & 0xff
  bytes[offset + 2] = (value >>> 8) & 0xff
  bytes[offset + 3] = value & 0xff
}

function writeUint24LittleEndian(
  bytes: Uint8Array,
  offset: number,
  value: number
): void {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >>> 8) & 0xff
  bytes[offset + 2] = (value >>> 16) & 0xff
}

describe('Sheet Preview rasterization', () => {
  it('computes bounded full-page and quadrant view boxes and dimensions', () => {
    expect(viewBoxFor('full', 420, 297)).toEqual({
      x: 0,
      y: 0,
      width: 420,
      height: 297
    })
    expect(viewBoxFor('top-left', 420, 297)).toEqual({
      x: 0,
      y: 0,
      width: 210,
      height: 148.5
    })
    expect(viewBoxFor('bottom-right', 420, 297)).toEqual({
      x: 210,
      y: 148.5,
      width: 210,
      height: 148.5
    })
    expect(rasterDimensions(viewBoxFor('full', 420, 297), 1_400)).toEqual({
      width: 1_400,
      height: 990
    })
    expect(
      rasterDimensions(viewBoxFor('top-right', 420, 297), 1_400)
    ).toEqual({
      width: 1_400,
      height: 990
    })
  })

  it('keeps the exact final SVG content, white page, and bounded crop', () => {
    const rasterSvg = svgForRaster(
      svg,
      viewBoxFor('bottom-left', 420, 297),
      1_400,
      990
    )
    expect(rasterSvg).toContain('fill="#ffffff"')
    expect(rasterSvg).toContain('fill="#ff0000"')
    expect(rasterSvg).toContain('viewBox="0 148.5 210 148.5"')
    expect(rasterSvg).toContain('width="1400"')
    expect(rasterSvg).toContain('height="990"')
  })

  it('downscales PNG progressively until it fits the strict payload bound', async () => {
    const encoder = vi.fn(async (request: RasterEncodeRequest) =>
      fakePng(
        request.width,
        request.height,
        request.width > 900 ? 6_000 : 1_000
      )
    )
    const result = await rasterizeSheetSvg({
      svg,
      svgSha256: await sha256(svg),
      pageWidth: 420,
      pageHeight: 297,
      view: 'full',
      renderRevision: 3,
      maximumBytes: 5_000,
      encoder
    })

    expect(result.usedWebpFallback).toBe(false)
    expect(result.image.mimeType).toBe('image/png')
    expect(result.image.width).toBeLessThanOrEqual(900)
    expect(result.image.byteLength).toBe(1_000)
    expect(encoder.mock.calls.length).toBeGreaterThan(1)
  })

  it('uses WebP only after every readable PNG candidate is too large', async () => {
    const pngCandidates = progressiveLongestSides(1_400, 700).length
    const encoder = vi.fn(async (request: RasterEncodeRequest) =>
      request.mimeType === 'image/png'
        ? fakePng(request.width, request.height, 6_000)
        : fakeWebp(request.width, request.height, 1_000)
    )
    const result = await rasterizeSheetSvg({
      svg,
      svgSha256: await sha256(svg),
      pageWidth: 420,
      pageHeight: 297,
      view: 'top-left',
      renderRevision: 4,
      maximumBytes: 5_000,
      encoder
    })

    expect(result.usedWebpFallback).toBe(true)
    expect(result.image.mimeType).toBe('image/webp')
    expect(
      encoder.mock.calls
        .slice(0, pngCandidates)
        .every(([request]) => request.mimeType === 'image/png')
    ).toBe(true)
  })

  it('fails explicitly when neither PNG nor WebP is readable within the limit', async () => {
    await expect(
      rasterizeSheetSvg({
        svg,
        svgSha256: await sha256(svg),
        pageWidth: 420,
        pageHeight: 297,
        view: 'full',
        renderRevision: 5,
        maximumBytes: 5_000,
        encoder: async (request) =>
          request.mimeType === 'image/png'
            ? fakePng(request.width, request.height, 6_000)
            : fakeWebp(request.width, request.height, 6_000)
      })
    ).rejects.toThrow('could not be encoded readably')
  })

  it('rejects external, filesystem-like, and DOM-bearing SVG resources', () => {
    for (const unsafe of [
      svg.replace('</svg>', '<image href="https://example.com/a.png"/></svg>'),
      svg.replace('</svg>', '<image href="file:///C:/secret.png"/></svg>'),
      svg.replace('</svg>', '<use href="https://example.com/s.svg#shape"/></svg>'),
      svg.replace(
        '</svg>',
        '<rect width="10" height="10" style="fill:url(https://example.com/a.svg)"/></svg>'
      ),
      svg.replace(
        '</svg>',
        '<rect width="10" height="10" fill="url(https://example.com/a.svg#paint)"/></svg>'
      ),
      svg.replace(
        '</svg>',
        '<style>@import "https://example.com/a.css";</style></svg>'
      ),
      svg.replace('</svg>', '<feImage href="file:///C:/secret.png"/></svg>'),
      svg.replace('</svg>', '<foreignObject><div>secret</div></foreignObject></svg>'),
      svg.replace('</svg>', '<script>alert(1)</script></svg>'),
      svg.replace('<circle ', '<circle onclick="alert(1)" '),
      svg.replace(
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<?xml-stylesheet href="https://example.com/a.css"?>'
      ),
      svg.replace(
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE svg SYSTEM "https://example.com/a.dtd">'
      )
    ]) {
      expect(() =>
        svgForRaster(unsafe, viewBoxFor('full', 420, 297), 1_400, 990)
      ).toThrow()
    }
  })

  it('allows local SVG references needed by the final Sheet Preview', () => {
    const localReferenceSvg = svg.replace(
      '</svg>',
      '<defs><clipPath id="local-clip"><rect width="10" height="10"/></clipPath></defs><g clip-path="url(#local-clip)"><use href="#local-clip"/></g></svg>'
    )

    expect(() =>
      svgForRaster(
        localReferenceSvg,
        viewBoxFor('full', 420, 297),
        1_400,
        990
      )
    ).not.toThrow()
  })
})
