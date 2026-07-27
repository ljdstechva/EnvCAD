import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearAutosaveSnapshot,
  getRecentFiles,
  loadAutosaveSnapshot,
  pushRecentFile,
  saveAutosaveSnapshot,
  startAutosave
} from '../src/autosave/autosave'
import { toasts } from '../src/toast/toastStore'

const AUTOSAVE_INTERVAL_MS = 2 * 60 * 1000

function failNextStorageWrites() {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('quota', 'QuotaExceededError')
  })
}

function makeTarget(overrides: Partial<Parameters<typeof startAutosave>[0]> = {}) {
  return {
    documentOpen: true,
    isDirty: true,
    fileName: 'site.dxf',
    dxfOut: () => '0\nSECTION\n0\nEOF',
    ...overrides
  }
}

describe('autosave storage', () => {
  beforeEach(() => {
    window.localStorage.clear()
    toasts.splice(0, toasts.length)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('round-trips a snapshot and clears it on request', () => {
    expect(saveAutosaveSnapshot('site.dxf', 'DXF-BODY')).toBe(true)
    const loaded = loadAutosaveSnapshot()
    expect(loaded?.fileName).toBe('site.dxf')
    expect(loaded?.dxf).toBe('DXF-BODY')

    clearAutosaveSnapshot()
    expect(loadAutosaveSnapshot()).toBeNull()
  })

  it('reports a rejected write instead of swallowing it, and keeps the older snapshot', () => {
    expect(saveAutosaveSnapshot('site.dxf', 'FIRST')).toBe(true)
    failNextStorageWrites()

    expect(saveAutosaveSnapshot('site.dxf', 'SECOND')).toBe(false)
    vi.restoreAllMocks()
    expect(loadAutosaveSnapshot()?.dxf).toBe('FIRST')
  })

  it('keeps recent files unique, newest first, and capped', () => {
    for (let i = 0; i < 12; i++) pushRecentFile(`file-${i}.dxf`)
    pushRecentFile('file-3.dxf')

    const recent = getRecentFiles()
    expect(recent).toHaveLength(10)
    expect(recent[0]).toBe('file-3.dxf')
    expect(recent.filter((name) => name === 'file-3.dxf')).toHaveLength(1)
  })
})

describe('startAutosave', () => {
  beforeEach(() => {
    window.localStorage.clear()
    toasts.splice(0, toasts.length)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('snapshots a dirty open document on the interval', () => {
    const stop = startAutosave(makeTarget())
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS)
    expect(loadAutosaveSnapshot()?.fileName).toBe('site.dxf')
    stop()
  })

  it('does not snapshot while the document is clean or closed', () => {
    const stopClean = startAutosave(makeTarget({ isDirty: false }))
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS)
    stopClean()

    const stopClosed = startAutosave(makeTarget({ documentOpen: false }))
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS)
    stopClosed()

    expect(loadAutosaveSnapshot()).toBeNull()
  })

  it('warns once for a run of failed writes, and again after a recovery', () => {
    // Each tick is checked on its own because toasts auto-dismiss well inside
    // the two-minute autosave interval.
    const warnings = () =>
      toasts.filter((toast) => toast.message.startsWith('Autosave failed')).length

    failNextStorageWrites()
    const stop = startAutosave(makeTarget())

    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS)
    expect(warnings()).toBe(1)

    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS)
    expect(warnings()).toBe(0)

    vi.restoreAllMocks()
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS)
    expect(loadAutosaveSnapshot()).not.toBeNull()
    expect(warnings()).toBe(0)

    failNextStorageWrites()
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS)
    expect(warnings()).toBe(1)

    stop()
  })

  it('stops snapshotting after the disposer runs', () => {
    const stop = startAutosave(makeTarget())
    stop()
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS * 2)
    expect(loadAutosaveSnapshot()).toBeNull()
  })
})
