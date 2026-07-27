/**
 * Rewrites a drawing name to carry a `.dxf` extension.
 *
 * EnvCAD only ever writes DXF text, and the viewer library picks its parser
 * from the file extension, so both the Save DXF download and any DXF content
 * handed back to the library must be named `.dxf` — a drawing opened from
 * `site.dwg` otherwise round-trips as DXF text under a name nothing can read.
 */
export function dxfFileName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return 'drawing.dxf'
  return `${trimmed.replace(/\.[^./\\]*$/, '')}.dxf`
}

/**
 * Cheap format check run before a file is handed to the viewer library.
 *
 * `AcApDocManager.openDocument` clears the current document *before* parsing
 * the new one, so a file that fails to parse takes the open drawing down with
 * it. Rejecting obviously-wrong files up front keeps the common case — picking
 * a non-CAD file by mistake — from destroying work in progress.
 *
 * This is a sniff, not a parser: a structurally plausible file that fails
 * deeper parsing still clears the document. Closing that gap needs a
 * parse-then-swap inside the library.
 *
 * @returns null when the file looks openable, otherwise a user-facing reason.
 */
export function drawingFileProblem(fileName: string, content: ArrayBuffer): string | null {
  if (content.byteLength === 0) return 'the file is empty'

  const head = new Uint8Array(content.slice(0, 4096))
  if (/\.dwg$/i.test(fileName)) return dwgProblem(head)
  return dxfProblem(head)
}

/** DWG files start with a six-character version tag such as `AC1027`. */
function dwgProblem(head: Uint8Array): string | null {
  const tag = String.fromCharCode(...head.subarray(0, 6))
  return /^AC\d{4}$/.test(tag) ? null : "it doesn't look like a DWG file"
}

function dxfProblem(head: Uint8Array): string | null {
  if (head[0] === 0xff && head[1] === 0xfe) return 'UTF-16 DXF is not supported — save it as ASCII DXF'
  if (head[0] === 0xfe && head[1] === 0xff) return 'UTF-16 DXF is not supported — save it as ASCII DXF'

  const text = new TextDecoder('utf-8', { fatal: false }).decode(head)
  if (text.startsWith('AutoCAD Binary DXF')) {
    return 'binary DXF is not supported — save it as ASCII DXF'
  }
  // Every ASCII DXF starts with a numeric group code, normally `0` for SECTION.
  const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0)
  if (firstLine === undefined || !/^\s*-?\d+\s*$/.test(firstLine)) {
    return "it doesn't look like a DXF file"
  }
  return null
}
