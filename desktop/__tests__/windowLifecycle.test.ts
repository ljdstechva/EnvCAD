import { describe, expect, it, vi } from 'vitest'
import { focusExistingWindow } from '../windowLifecycle'

describe('single-instance focus behavior', () => {
  it('restores, shows, and focuses the existing window', () => {
    const window = {
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn()
    }
    focusExistingWindow(window)
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
  })
})
