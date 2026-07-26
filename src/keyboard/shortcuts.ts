/**
 * The CAD viewer library already installs a focus-aware document-level
 * keydown handler for Ctrl/Cmd+Z, Ctrl/Cmd+Y, Delete/Backspace, and Escape
 * (see @mlightcad/cad-simple-viewer's key handler). This helper covers the
 * app-level shortcuts the library doesn't know about — Ctrl/Cmd+O, Ctrl/Cmd+S,
 * F2 — using the same "ignore while typing" rule so behavior stays consistent.
 */
export function isEditableTarget(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null
  if (!target) return false
  const tag = target.tagName
  return tag === 'TEXTAREA' || tag === 'INPUT' || target.isContentEditable
}
