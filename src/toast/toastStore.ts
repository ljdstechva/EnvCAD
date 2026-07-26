import { reactive } from 'vue'

export type ToastKind = 'error' | 'info'

export interface Toast {
  id: number
  kind: ToastKind
  message: string
}

const AUTO_DISMISS_MS = 6000

let nextId = 1
export const toasts: Toast[] = reactive([])

export function pushToast(message: string, kind: ToastKind = 'error') {
  const id = nextId++
  toasts.push({ id, kind, message })
  setTimeout(() => dismissToast(id), AUTO_DISMISS_MS)
  return id
}

export function dismissToast(id: number) {
  const index = toasts.findIndex((t) => t.id === id)
  if (index !== -1) toasts.splice(index, 1)
}
