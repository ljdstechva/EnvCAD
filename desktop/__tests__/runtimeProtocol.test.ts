import { describe, expect, it } from 'vitest'
import {
  desktopConnectionConfig,
  isDurableAgentStateKey,
  isSidecarStatus,
  isSidecarWorkerCommand,
  isSidecarWorkerEvent
} from '../runtimeProtocol'

describe('desktop runtime protocol validation', () => {
  it('allowlists only the two renderer recovery-state keys', () => {
    expect(isDurableAgentStateKey('envcad.agent.turn-session.v2')).toBe(true)
    expect(isDurableAgentStateKey('envcad.agent.drafts.v1')).toBe(true)
    expect(isDurableAgentStateKey('envcad.agent.credentials')).toBe(false)
    expect(isDurableAgentStateKey('../outside')).toBe(false)
  })

  it('accepts the narrow loopback start command and rejects extra authority', () => {
    const valid = {
      type: 'start',
      host: '127.0.0.1',
      port: 0,
      permittedOrigin: 'http://127.0.0.1:43123',
      sessionToken: 'a'.repeat(43),
      runtimeDirectory: 'C:\\Users\\test\\AppData\\Local\\EnvCAD\\ai-runtime\\session',
      inputStoreDirectory:
        'C:\\Users\\test\\AppData\\Roaming\\EnvCAD\\agent-journal-v2\\inputs'
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

  it('strictly validates turn-journal requests and responses', () => {
    const request = {
      type: 'turn-journal-request',
      requestId: 'request-1',
      command: { type: 'list-open-turns' }
    }
    expect(isSidecarWorkerEvent(request)).toBe(true)
    expect(
      isSidecarWorkerEvent({
        ...request,
        command: { type: 'list-open-turns', path: 'C:\\unsafe' }
      })
    ).toBe(false)
    expect(
      isSidecarWorkerEvent({ ...request, unexpected: true })
    ).toBe(false)

    const success = {
      type: 'turn-journal-response',
      requestId: 'request-1',
      ok: true,
      result: { type: 'open-turns-listed', turns: [] }
    }
    expect(isSidecarWorkerCommand(success)).toBe(true)
    expect(
      isSidecarWorkerCommand({
        ...success,
        result: {
          type: 'turn-read',
          eventsAfterCursor: [
            {
              protocolVersion: 2,
              sessionId: 'session-1',
              messageId: 'event-1',
              turnId: 'turn-1',
              sequence: 1,
              timestamp: '2026-07-29T08:00:00.000Z',
              payload: {
                type: 'assistant_text_delta',
                turnId: 'turn-1',
                text: 'orphan'
              }
            }
          ]
        }
      })
    ).toBe(false)
    expect(
      isSidecarWorkerCommand({
        type: 'turn-journal-response',
        requestId: 'request-1',
        ok: false,
        error: {
          code: 'turn-journal-failed',
          message: 'Durable turn state could not be updated.'
        }
      })
    ).toBe(true)
  })
})
