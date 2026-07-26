import { ref } from 'vue'
import { AcApDocManager } from '@mlightcad/cad-simple-viewer'

export const pickModeActive = ref(false)

let activeResolve: ((point: { x: number; y: number } | null) => void) | null = null
let boundElement: HTMLElement | null = null

function findCanvasHost(): HTMLElement | null {
  return document.querySelector('.canvas-host')
}

function onCanvasClick(event: MouseEvent) {
  if (!boundElement) return
  const rect = boundElement.getBoundingClientRect()
  const screenPoint = { x: event.clientX - rect.left, y: event.clientY - rect.top }
  let worldPoint = screenPoint
  try {
    worldPoint = AcApDocManager.instance.curView.screenToWorld(screenPoint)
  } catch {
    // viewer not ready — fall back to raw screen coordinates
  }
  finishPick({ x: worldPoint.x, y: worldPoint.y })
}

function onCancelKey(event: KeyboardEvent) {
  if (event.key === 'Escape') finishPick(null)
}

function finishPick(point: { x: number; y: number } | null) {
  if (boundElement) {
    boundElement.removeEventListener('click', onCanvasClick)
    boundElement.classList.remove('sheet-pick-cursor')
  }
  window.removeEventListener('keydown', onCancelKey)
  boundElement = null
  pickModeActive.value = false
  const resolve = activeResolve
  activeResolve = null
  resolve?.(point)
}

/**
 * Arms a one-shot click listener on the CAD canvas and resolves with the world-space
 * point clicked, or null if the user presses Escape before clicking.
 */
export function requestPickCenter(): Promise<{ x: number; y: number } | null> {
  if (pickModeActive.value) finishPick(null)
  const host = findCanvasHost()
  if (!host) return Promise.resolve(null)

  return new Promise((resolve) => {
    activeResolve = resolve
    boundElement = host
    pickModeActive.value = true
    host.classList.add('sheet-pick-cursor')
    host.addEventListener('click', onCanvasClick)
    window.addEventListener('keydown', onCancelKey)
  })
}

export function cancelPickCenter() {
  if (pickModeActive.value) finishPick(null)
}
