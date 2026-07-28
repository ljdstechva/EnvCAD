import type { ToolResult } from './protocol'

export type ImageIntegrityResult =
  | { ok: true }
  | { ok: false; error: string }

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}

function decodeBase64(base64: string): Uint8Array {
  const binary = globalThis.atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/**
 * Recomputes the digest in the renderer immediately before an image-bearing
 * tool result crosses the WebSocket boundary.
 */
export async function verifyToolImageSha256(
  result: ToolResult
): Promise<ImageIntegrityResult> {
  if (!result.image) return { ok: true }
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    return {
      ok: false,
      error: 'SHA-256 verification is unavailable in the renderer'
    }
  }

  try {
    const bytes = decodeBase64(result.image.base64)
    const digest = await subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)
    const actual = bytesToHex(new Uint8Array(digest))
    if (actual !== result.image.sha256) {
      return {
        ok: false,
        error: 'tool_result.result.image.sha256 does not match the decoded image bytes'
      }
    }
    return { ok: true }
  } catch {
    return {
      ok: false,
      error: 'tool_result.result.image SHA-256 verification failed'
    }
  }
}
