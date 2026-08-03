import {
  persistedTurnEventEnvelopeSchema,
  turnJournalCommandSchema,
  type PersistedTurnEventEnvelope,
  type SubmitTurnEnvelope
} from '../../shared/agent-contracts'
import {
  appendChecksummedJsonlRecord,
  loadChecksummedJsonlJournal,
  type ChecksummedJournalOptions,
  type LoadedChecksummedJournal
} from '../../shared/node/ChecksummedJsonlJournal'

const JOURNAL_VERSION = 1
const MAX_RECORD_BYTES = 2_000_000

export type TurnJournalRecord =
  | {
      kind: 'accepted'
      draft: SubmitTurnEnvelope
      event: PersistedTurnEventEnvelope
    }
  | {
      kind: 'event'
      event: PersistedTurnEventEnvelope
    }

export class TurnJournalCorruptionError extends Error {
  constructor(message: string) {
    super(`Turn journal is corrupt: ${message}`)
    this.name = 'TurnJournalCorruptionError'
  }
}

const journalOptions: ChecksummedJournalOptions<TurnJournalRecord> = {
  version: JOURNAL_VERSION,
  payloadKey: 'entry',
  maximumRecordBytes: MAX_RECORD_BYTES,
  parsePayload: parseTurnJournalRecord,
  corruptionError: (message) => new TurnJournalCorruptionError(message)
}

export function loadTurnJournalRecords(
  filePath: string
): Promise<LoadedChecksummedJournal<TurnJournalRecord>> {
  return loadChecksummedJsonlJournal(filePath, journalOptions)
}

export async function appendTurnJournalRecord(
  filePath: string,
  sequence: number,
  record: TurnJournalRecord
): Promise<void> {
  await appendChecksummedJsonlRecord(
    filePath,
    sequence,
    record,
    journalOptions
  )
}

function parseTurnJournalRecord(value: unknown): TurnJournalRecord {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new Error('record must be an object with a kind')
  }
  if (
    value.kind === 'accepted' &&
    hasExactKeys(value, ['kind', 'draft', 'event'])
  ) {
    const event = persistedTurnEventEnvelopeSchema.parse(value.event)
    const command = turnJournalCommandSchema.parse({
      type: 'accept-turn',
      eventId: event.messageId,
      draft: value.draft,
      accepted: event.payload
    })
    if (command.type !== 'accept-turn') {
      throw new Error('accepted record did not parse as accept-turn')
    }
    return {
      kind: 'accepted',
      draft: command.draft,
      event
    }
  }
  if (value.kind === 'event' && hasExactKeys(value, ['kind', 'event'])) {
    return {
      kind: 'event',
      event: persistedTurnEventEnvelopeSchema.parse(value.event)
    }
  }
  throw new Error('record has an invalid turn-journal shape')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  const expected = new Set(keys)
  return (
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key))
  )
}
