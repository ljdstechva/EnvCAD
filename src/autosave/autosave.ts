import { pushToast } from '../toast/toastStore'

const SNAPSHOT_KEY = 'envcad.autosaveSnapshot'
const RECENT_FILES_KEY = 'envcad.recentFiles'
const AUTOSAVE_INTERVAL_MS = 2 * 60 * 1000
const MAX_RECENT_FILES = 10

export interface AutosaveSnapshot {
  fileName: string
  dxf: string
  savedAt: number
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Returns false when the write was rejected (private browsing, quota exceeded). */
function writeStorage(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

function removeStorage(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

export function loadAutosaveSnapshot(): AutosaveSnapshot | null {
  const raw = readStorage(SNAPSHOT_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as AutosaveSnapshot
    if (typeof parsed.dxf === 'string' && typeof parsed.fileName === 'string') return parsed
    return null
  } catch {
    return null
  }
}

/** Returns false when the snapshot could not be stored. */
export function saveAutosaveSnapshot(fileName: string, dxf: string): boolean {
  const snapshot: AutosaveSnapshot = { fileName, dxf, savedAt: Date.now() }
  return writeStorage(SNAPSHOT_KEY, JSON.stringify(snapshot))
}

export function clearAutosaveSnapshot(): void {
  removeStorage(SNAPSHOT_KEY)
}

export function getRecentFiles(): string[] {
  const raw = readStorage(RECENT_FILES_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : []
  } catch {
    return []
  }
}

export function pushRecentFile(fileName: string): void {
  const existing = getRecentFiles().filter((name) => name !== fileName)
  const updated = [fileName, ...existing].slice(0, MAX_RECENT_FILES)
  writeStorage(RECENT_FILES_KEY, JSON.stringify(updated))
}

export interface AutosaveTarget {
  documentOpen: boolean
  isDirty: boolean
  fileName: string
  dxfOut(): string | null
}

/**
 * Snapshots the open drawing to localStorage every two minutes (while dirty)
 * and once more on tab close, so a crashed sidecar or an accidental tab
 * close doesn't lose in-progress edits. Returns a disposer that stops the
 * interval and removes the beforeunload listener.
 */
export function startAutosave(target: AutosaveTarget): () => void {
  // A drawing whose DXF exceeds the localStorage quota fails every tick, so
  // the warning is shown once per run of failures rather than every two
  // minutes. Silence would be worse: the user would believe autosave is
  // protecting work that is not being stored at all.
  let warnedAboutFailure = false

  function snapshotIfDirty() {
    if (!target.documentOpen || !target.isDirty) return
    const dxf = target.dxfOut()
    if (dxf === null) return
    if (saveAutosaveSnapshot(target.fileName, dxf)) {
      warnedAboutFailure = false
      return
    }
    if (!warnedAboutFailure) {
      warnedAboutFailure = true
      pushToast(
        "Autosave failed — this drawing doesn't fit in the browser's local storage. " +
          'Save it with Ctrl+S to avoid losing work.'
      )
    }
  }

  const interval = setInterval(snapshotIfDirty, AUTOSAVE_INTERVAL_MS)
  window.addEventListener('beforeunload', snapshotIfDirty)

  return () => {
    clearInterval(interval)
    window.removeEventListener('beforeunload', snapshotIfDirty)
  }
}
