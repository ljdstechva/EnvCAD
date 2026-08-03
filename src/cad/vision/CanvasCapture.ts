import {
  MAX_TOOL_IMAGE_BYTES,
  type ToolImageMimeType,
  type ToolImagePayload
} from '../../agent/protocol'
import type { PixelRegion } from './VisionEvidence'

const TARGET_LONGEST_SIDE = 1_400
const MINIMUM_LONGEST_SIDE = 700

export async function captureCanvasRegion(
  source: HTMLCanvasElement,
  region: PixelRegion,
  capturePrefix: string,
  renderRevision: number
): Promise<ToolImagePayload> {
  validateRegion(source, region)
  for (const mimeType of ['image/png', 'image/webp'] as const) {
    for (const longestSide of sizes()) {
      const output = drawRegion(source, region, longestSide)
      const bytes = await encode(output, mimeType)
      if (bytes.byteLength <= MAX_TOOL_IMAGE_BYTES) {
        return imagePayload(
          bytes,
          mimeType,
          output.width,
          output.height,
          capturePrefix,
          renderRevision
        )
      }
    }
  }
  throw new Error(
    `Drawing image could not fit the ${MAX_TOOL_IMAGE_BYTES}-byte visual evidence limit.`
  )
}

export async function composeEvidenceImages(
  images: readonly ToolImagePayload[],
  capturePrefix: string,
  renderRevision: number,
  decorate?: (context: CanvasRenderingContext2D, width: number, height: number) => void
): Promise<ToolImagePayload> {
  const decoded = await Promise.all(images.map(loadPayloadImage))
  const height = Math.min(
    TARGET_LONGEST_SIDE,
    Math.max(...decoded.map((image) => image.naturalHeight))
  )
  const widths = decoded.map((image) =>
    Math.max(1, Math.round((image.naturalWidth / image.naturalHeight) * height))
  )
  const canvas = document.createElement('canvas')
  canvas.width = widths.reduce((sum, width) => sum + width, 0)
  canvas.height = height
  const context = requiredContext(canvas)
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  let x = 0
  decoded.forEach((image, index) => {
    context.drawImage(image, x, 0, widths[index], height)
    x += widths[index]
  })
  decorate?.(context, canvas.width, canvas.height)
  for (const mimeType of ['image/png', 'image/webp'] as const) {
    const bytes = await encode(canvas, mimeType)
    if (bytes.byteLength <= MAX_TOOL_IMAGE_BYTES) {
      return imagePayload(
        bytes,
        mimeType,
        canvas.width,
        canvas.height,
        capturePrefix,
        renderRevision
      )
    }
  }
  throw new Error('Composite visual evidence exceeded the bounded image size.')
}

function drawRegion(
  source: HTMLCanvasElement,
  region: PixelRegion,
  longestSide: number
): HTMLCanvasElement {
  const scale = Math.min(1, longestSide / Math.max(region.width, region.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(region.width * scale))
  canvas.height = Math.max(1, Math.round(region.height * scale))
  const context = requiredContext(canvas)
  context.drawImage(
    source,
    region.x,
    region.y,
    region.width,
    region.height,
    0,
    0,
    canvas.width,
    canvas.height
  )
  return canvas
}

function sizes(): number[] {
  const result: number[] = []
  for (
    let size = TARGET_LONGEST_SIDE;
    size > MINIMUM_LONGEST_SIDE;
    size = Math.floor(size * 0.82)
  ) {
    result.push(size)
  }
  result.push(MINIMUM_LONGEST_SIDE)
  return result
}

function validateRegion(canvas: HTMLCanvasElement, region: PixelRegion): void {
  if (
    ![region.x, region.y, region.width, region.height].every(Number.isFinite) ||
    region.x < 0 ||
    region.y < 0 ||
    region.width <= 0 ||
    region.height <= 0 ||
    region.x + region.width > canvas.width + 1 ||
    region.y + region.height > canvas.height + 1
  ) {
    throw new Error('Visual capture region is outside the current canvas.')
  }
}

function requiredContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('A 2D image context is unavailable.')
  return context
}

function encode(
  canvas: HTMLCanvasElement,
  mimeType: ToolImageMimeType
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          reject(new Error(`The drawing could not be encoded as ${mimeType}.`))
          return
        }
        resolve(new Uint8Array(await blob.arrayBuffer()))
      },
      mimeType,
      mimeType === 'image/webp' ? 0.84 : undefined
    )
  })
}

async function imagePayload(
  bytes: Uint8Array,
  mimeType: ToolImageMimeType,
  width: number,
  height: number,
  prefix: string,
  renderRevision: number
): Promise<ToolImagePayload> {
  const source = new Uint8Array(bytes)
  const digest = await crypto.subtle.digest(
    'SHA-256',
    source.buffer as ArrayBuffer
  )
  const sha256 = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
  return {
    mimeType,
    base64: bytesToBase64(bytes),
    byteLength: bytes.byteLength,
    width,
    height,
    aspectRatio: width / height,
    sha256,
    captureId: `${prefix}-${sha256.slice(0, 16)}`,
    renderRevision: Math.max(1, renderRevision)
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function loadPayloadImage(payload: ToolImagePayload): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Stored visual evidence could not be decoded.'))
    image.src = `data:${payload.mimeType};base64,${payload.base64}`
  })
}
