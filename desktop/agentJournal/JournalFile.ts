import type { OperationReceipt } from '../../shared/agent-contracts'
import {
  appendChecksummedJsonlRecord,
  loadChecksummedJsonlJournal,
  type ChecksummedJournalOptions
} from '../../shared/node/ChecksummedJsonlJournal'

const JOURNAL_VERSION = 1
const MAX_RECORD_BYTES = 2_000_000

export interface LoadedJournal {
  records: Array<{ sequence: number; receipt: OperationReceipt }>
  lastSequence: number
}

export class JournalCorruptionError extends Error {
  constructor(message: string) {
    super(`Operation journal is corrupt: ${message}`)
    this.name = 'JournalCorruptionError'
  }
}

const journalOptions: ChecksummedJournalOptions<OperationReceipt> = {
  version: JOURNAL_VERSION,
  payloadKey: 'receipt',
  maximumRecordBytes: MAX_RECORD_BYTES,
  parsePayload: (value) => value as OperationReceipt,
  corruptionError: (message) => new JournalCorruptionError(message)
}

export async function loadJournal(filePath: string): Promise<LoadedJournal> {
  const loaded = await loadChecksummedJsonlJournal(filePath, journalOptions)
  return {
    records: loaded.records.map((record) => ({
      sequence: record.sequence,
      receipt: record.value
    })),
    lastSequence: loaded.lastSequence
  }
}

export async function appendJournalReceipt(
  filePath: string,
  sequence: number,
  receipt: OperationReceipt
): Promise<void> {
  await appendChecksummedJsonlRecord(
    filePath,
    sequence,
    receipt,
    journalOptions
  )
}
