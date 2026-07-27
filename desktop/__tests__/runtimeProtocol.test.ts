import { describe, expect, it } from 'vitest'
import {
  desktopConnectionConfig,
  isSidecarStatus,
  isSidecarWorkerCommand,
  isSidecarWorkerEvent
} from '../runtimeProtocol'

describe('desktop runtime protocol validation', () => {
  it('accepts the narrow loopback start command and rejects extra authority', () => {
    const valid = {
      type: 'start',
      host: '127.0.0.1',
      port: 0,
      permittedOrigin: 'http://127.0.0.1:43123',
      sessionToken: 'a'.repeat(43),
      runtimeDirectory: 'C:\\Users\\test\\AppData\\Local\\EnvCAD\\ai-runtime\\session'
    }
    expect(isSidecarWorkerCommand(valid)).toBe(true)
    expect(isSidecarWorkerCommand({ ...valid, port: 8787 })).toBe(false)
    expect(isSidecarWorkerCommand({ ...valid, host: '0.0.0.0' })).toBe(false)
    expect(isSidecarWorkerCommand({ ...valid, environment: {} })).toBe(false)
    expect(isSidecarWorkerCommand({ type: 'shutdown', force: true })).toBe(false)
  })

  it('accepts only strict worker events and authenticated loopback status', () => {
    expect(
      isSidecarWorkerEvent({
        type: 'ready',
        host: '127.0.0.1',
        port: 43123,
        message: 'Ready'
      })
    ).toBe(true)
    expect(
      isSidecarWorkerEvent({
        type: 'ready',
        host: '0.0.0.0',
        port: 43123,
        message: 'Ready'
      })
    ).toBe(false)

    const connection = desktopConnectionConfig(
      '127.0.0.1',
      43123,
      'b'.repeat(43)
    )
    expect(
      isSidecarStatus({ type: 'ready', message: 'Ready', connection })
    ).toBe(true)
    expect(
      isSidecarStatus({
        type: 'ready',
        message: 'Ready',
        connection: { ...connection, url: 'ws://0.0.0.0:43123' }
      })
    ).toBe(false)
  })
})
