import {
  MAX_TOOL_IMAGE_BYTES,
  type ToolImageMimeType,
  type ToolImagePayload,
  validateToolResultForTool
} from '../agent/protocol'

export const SHEET_PREVIEW_VIEWS = [
  'full',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right'
] as const

export type SheetPreviewView = (typeof SHEET_PREVIEW_VIEWS)[number]

export const DEFAULT_RASTER_LONGEST_SIDE = 1_400
export const MIN_READABLE_RASTER_LONGEST_SIDE = 700

export interface RasterEncodeRequest {
  svg: string
  width: number
  height: number
  mimeType: ToolImageMimeType
  quality?: number
}

export type RasterEncoder = (
  request: RasterEncodeRequest
) => Promise<Uint8Array>

export interface RasterizeSheetRequest {
  svg: string
  svgSha256: string
  pageWidth: number
  pageHeight: number
  view: SheetPreviewView
  renderRevision: number
  targetLongestSide?: number
  minimumReadableLongestSide?: number
  maximumBytes?: number
  encoder?: RasterEncoder
}

export interface RasterizedSheet {
  image: ToolImagePayload
  usedWebpFallback: boolean
}

interface ViewBox {
  x: number
  y: number
  width: number
  height: number
}

export async function rasterizeSheetSvg(
  request: RasterizeSheetRequest
): Promise<RasterizedSheet> {
  const actualSvgSha256 = await sha256Bytes(
    new TextEncoder().encode(request.svg)
  )
  if (actualSvgSha256 !== request.svgSha256) {
    throw new Error('Sheet Preview SVG hash changed before rasterization.')
  }
  const targetLongestSide =
    request.targetLongestSide ?? DEFAULT_RASTER_LONGEST_SIDE
  const minimumReadableLongestSide =
    request.minimumReadableLongestSide ??
    MIN_READABLE_RASTER_LONGEST_SIDE
  const maximumBytes = request.maximumBytes ?? MAX_TOOL_IMAGE_BYTES
  if (
    !Number.isSafeInteger(targetLongestSide) ||
    !Number.isSafeInteger(minimumReadableLongestSide) ||
    targetLongestSide < minimumReadableLongestSide ||
    minimumReadableLongestSide < 1
  ) {
    throw new Error('Sheet raster dimensions are invalid.')
  }
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > MAX_TOOL_IMAGE_BYTES
  ) {
    throw new Error('Sheet raster byte limit is invalid.')
  }
  if (
    !Number.isFinite(request.pageWidth) ||
    !Number.isFinite(request.pageHeight) ||
    request.pageWidth <= 0 ||
    request.pageHeight <= 0
  ) {
    throw new Error('Sheet page dimensions are invalid.')
  }

  const encoder = request.encoder ?? browserRasterEncoder
  const crop = viewBoxFor(
    request.view,
    request.pageWidth,
    request.pageHeight
  )
  const candidates = progressiveLongestSides(
    targetLongestSide,
    minimumReadableLongestSide
  )

  for (const longestSide of candidates) {
    const dimensions = rasterDimensions(crop, longestSide)
    const bytes = await encoder({
      svg: svgForRaster(request.svg, crop, dimensions.width, dimensions.height),
      ...dimensions,
      mimeType: 'image/png'
    })
    if (bytes.byteLength <= maximumBytes) {
      return {
        image: await makeImagePayload(
          bytes,
          'image/png',
          dimensions.width,
          dimensions.height,
          request.view,
          request.renderRevision,
          maximumBytes,
          crop
        ),
        usedWebpFallback: false
      }
    }
  }

  // WebP is considered only after lossless PNG cannot fit even at the minimum
  // readable resolution.
  for (const quality of [0.92, 0.84, 0.76]) {
    for (const longestSide of candidates) {
      const dimensions = rasterDimensions(crop, longestSide)
      const bytes = await encoder({
        svg: svgForRaster(request.svg, crop, dimensions.width, dimensions.height),
        ...dimensions,
        mimeType: 'image/webp',
        quality
      })
      if (bytes.byteLength <= maximumBytes) {
        return {
          image: await makeImagePayload(
            bytes,
            'image/webp',
            dimensions.width,
            dimensions.height,
            request.view,
            request.renderRevision,
            maximumBytes,
            crop
          ),
          usedWebpFallback: true
        }
      }
    }
  }

  throw new Error(
    `Sheet Preview could not be encoded readably within the ${maximumBytes.toLocaleString()}-byte image limit.`
  )
}

export function viewBoxFor(
  view: SheetPreviewView,
  pageWidth: number,
  pageHeight: number
): ViewBox {
  if (view === 'full') {
    return { x: 0, y: 0, width: pageWidth, height: pageHeight }
  }
  const width = pageWidth / 2
  const height = pageHeight / 2
  return {
    x: view.endsWith('right') ? width : 0,
    y: view.startsWith('bottom') ? height : 0,
    width,
    height
  }
}

export function rasterDimensions(
  viewBox: Pick<ViewBox, 'width' | 'height'>,
  longestSide: number
): { width: number; height: number } {
  if (viewBox.width >= viewBox.height) {
    return {
      width: longestSide,
      height: Math.max(1, Math.round(longestSide * (viewBox.height / viewBox.width)))
    }
  }
  return {
    width: Math.max(1, Math.round(longestSide * (viewBox.width / viewBox.height))),
    height: longestSide
  }
}

export function progressiveLongestSides(
  target: number,
  minimum: number
): number[] {
  const values: number[] = []
  let current = target
  while (current > minimum) {
    values.push(current)
    const next = Math.floor(current * 0.82)
    current = next >= current ? current - 1 : next
  }
  values.push(minimum)
  return [...new Set(values)]
}

export function svgForRaster(
  svg: string,
  crop: ViewBox,
  width: number,
  height: number
): string {
  if (/<!DOCTYPE\b/i.test(svg) || /<\?xml-stylesheet\b/i.test(svg)) {
    throw new Error(
      'Sheet Preview SVG contains an unsupported document declaration.'
    )
  }
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const parserError = document.querySelector('parsererror')
  const root = document.documentElement
  if (
    parserError ||
    root.localName.toLowerCase() !== 'svg' ||
    root.namespaceURI !== 'http://www.w3.org/2000/svg'
  ) {
    throw new Error('Sheet Preview returned malformed SVG.')
  }
  assertSafeSvgResources(root)
  root.setAttribute(
    'viewBox',
    `${formatNumber(crop.x)} ${formatNumber(crop.y)} ${formatNumber(
      crop.width
    )} ${formatNumber(crop.height)}`
  )
  root.setAttribute('width', String(width))
  root.setAttribute('height', String(height))
  root.setAttribute('preserveAspectRatio', 'none')
  return new XMLSerializer().serializeToString(document)
}

function assertSafeSvgResources(root: Element): void {
  const elements = [root, ...Array.from(root.querySelectorAll('*'))]
  const unsupportedElements = new Set([
    'a',
    'animate',
    'animatemotion',
    'animatetransform',
    'audio',
    'canvas',
    'discard',
    'embed',
    'feimage',
    'foreignobject',
    'iframe',
    'object',
    'script',
    'set',
    'style',
    'video'
  ])

  for (const element of elements) {
    const elementName = element.localName.toLowerCase()
    if (
      element.namespaceURI !== 'http://www.w3.org/2000/svg' ||
      unsupportedElements.has(elementName)
    ) {
      throw new Error(
        'Sheet Preview SVG contains unsupported executable, dynamic, or DOM content.'
      )
    }

    for (const attribute of Array.from(element.attributes)) {
      if (/^on/i.test(attribute.name)) {
        throw new Error('Sheet Preview SVG contains an event handler.')
      }

      const attributeName = attribute.localName.toLowerCase()
      const value = attribute.value.trim()
      if (
        attributeName === 'style' ||
        attributeName === 'base' ||
        attributeName === 'src'
      ) {
        throw new Error(
          'Sheet Preview SVG contains an unsupported resource-bearing attribute.'
        )
      }
      if (attributeName === 'href' && value) {
        const isLocalFragment = /^#[A-Za-z_][A-Za-z0-9_.:-]*$/.test(value)
        const isEmbeddedRaster =
          elementName === 'image' &&
          /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(
            value
          )
        if (!isLocalFragment && !isEmbeddedRaster) {
          throw new Error(
            'Sheet Preview SVG contains a non-embedded resource; visual inspection was refused.'
          )
        }
      }
      if (/url\s*\(/i.test(value)) {
        const withoutLocalFragments = value.replace(
          /url\s*\(\s*(["']?)#[A-Za-z_][A-Za-z0-9_.:-]*\1\s*\)/gi,
          ''
        )
        if (/url\s*\(/i.test(withoutLocalFragments)) {
          throw new Error(
            'Sheet Preview SVG contains a non-local URL resource; visual inspection was refused.'
          )
        }
      }
    }
  }
}

async function makeImagePayload(
  bytes: Uint8Array,
  mimeType: ToolImageMimeType,
  width: number,
  height: number,
  view: SheetPreviewView,
  renderRevision: number,
  maximumBytes: number,
  crop: ViewBox
): Promise<ToolImagePayload> {
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    throw new Error('Sheet raster encoder returned an invalid byte length.')
  }
  const expectedAspect = crop.width / crop.height
  const actualAspect = width / height
  const aspectTolerance = Math.max(1 / width, 1 / height) * 2
  if (Math.abs(expectedAspect - actualAspect) > aspectTolerance) {
    throw new Error('Sheet raster aspect ratio does not match the requested page view.')
  }

  const sha256 = await sha256Bytes(bytes)
  const image: ToolImagePayload = {
    mimeType,
    base64: bytesToBase64(bytes),
    byteLength: bytes.byteLength,
    width,
    height,
    aspectRatio: width / height,
    sha256,
    captureId: `sheet-${renderRevision}-${view}-${sha256.slice(0, 16)}`,
    renderRevision
  }
  const validation = validateToolResultForTool('inspect_sheet_preview', {
    data: {},
    image
  })
  if (!validation.ok) {
    throw new Error(`Sheet raster validation failed: ${validation.error}`)
  }
  return image
}

async function browserRasterEncoder(
  request: RasterEncodeRequest
): Promise<Uint8Array> {
  const blob = new Blob([request.svg], {
    type: 'image/svg+xml;charset=utf-8'
  })
  const objectUrl = URL.createObjectURL(blob)
  try {
    const image = await loadImage(objectUrl)
    const canvas = document.createElement('canvas')
    canvas.width = request.width
    canvas.height = request.height
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) {
      throw new Error('The renderer could not create a 2D canvas for Sheet Preview.')
    }
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, request.width, request.height)
    context.drawImage(image, 0, 0, request.width, request.height)
    const encoded = await canvasToBlob(
      canvas,
      request.mimeType,
      request.quality
    )
    if (encoded.type !== request.mimeType) {
      throw new Error(
        `The renderer did not support the requested ${request.mimeType} image encoding.`
      )
    }
    return new Uint8Array(await encoded.arrayBuffer())
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () =>
      reject(new Error('The renderer could not decode the generated Sheet Preview SVG.'))
    image.src = url
  })
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: ToolImageMimeType,
  quality?: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob)
          else reject(new Error(`The renderer could not encode ${mimeType}.`))
        },
        mimeType,
        quality
      )
    } catch (error) {
      reject(error)
    }
  })
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const source = new Uint8Array(bytes)
  const digest = await crypto.subtle.digest('SHA-256', source.buffer)
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(8)))
}
