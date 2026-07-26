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

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // localStorage unavailable (private browsing, quota) — autosave is best-effort
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

export function saveAutosaveSnapshot(fileName: string, dxf: string): void {
  const snapshot: AutosaveSnapshot = { fileName, dxf, savedAt: Date.now() }
  writeStorage(SNAPSHOT_KEY, JSON.stringify(snapshot))
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
  function snapshotIfDirty() {
    if (!target.documentOpen || !target.isDirty) return
    const dxf = target.dxfOut()
    if (dxf === null) return
    saveAutosaveSnapshot(target.fileName, dxf)
  }

  const interval = setInterval(snapshotIfDirty, AUTOSAVE_INTERVAL_MS)
  window.addEventListener('beforeunload', snapshotIfDirty)

  return () => {
    clearInterval(interval)
    window.removeEventListener('beforeunload', snapshotIfDirty)
  }
}
