import { z } from 'zod'
import {
  MAX_INLINE_TURN_TEXT_UTF8_BYTES,
  inputReferenceSchema,
  type InputReference
} from '../../../shared/agent-contracts'
import type { SelectionSnapshot, SheetSnapshot } from '../protocol'
import {
  selectionSnapshotSchema,
  sheetSnapshotSchema
} from './DurableTurnSessionStorage'
import type { KeyValueStorage } from './DurableTurnSession'
import { DesktopDraftStorage } from './DesktopDraftStorage'

export const ASSISTANT_DRAFT_STORAGE_KEY = 'envcad.agent.drafts.v1'
const ASSISTANT_DRAFT_STORAGE_VERSION = 1 as const
const MAX_QUEUED_TURNS = 100

export interface QueuedTurnDraft {
  queueId: string
  queuedAt: string
  text: string
  instructionReference?: InputReference
  referenceInputIds: string[]
  selectionSnapshot: SelectionSnapshot
  sheet: SheetSnapshot
  status: 'queued' | 'needs-review'
  reason?: string
}

interface StoredAssistantDrafts {
  version: typeof ASSISTANT_DRAFT_STORAGE_VERSION
  composerText: string
  queuedTurns: QueuedTurnDraft[]
}

export interface DraftStoreOptions {
  storage?: KeyValueStorage
  idFactory?: () => string
  now?: () => Date
  onPersistenceError?: (error: Error) => void
}

const identifierSchema = z.string().min(1).max(1_000)
const queuedTurnSchema: z.ZodType<QueuedTurnDraft> = z.strictObject({
  queueId: identifierSchema,
  queuedAt: z
    .string()
    .min(20)
    .max(40)
    .refine((value) => Number.isFinite(Date.parse(value)), 'Invalid timestamp'),
  text: z
    .string()
    .min(1)
    .refine(
      (text) =>
        new TextEncoder().encode(text).byteLength <=
        MAX_INLINE_TURN_TEXT_UTF8_BYTES,
      'Queued inline instruction exceeds the protocol limit.'
    ),
  instructionReference: inputReferenceSchema.optional(),
  referenceInputIds: z.array(identifierSchema).max(1_000),
  selectionSnapshot: selectionSnapshotSchema,
  sheet: sheetSnapshotSchema,
  status: z.enum(['queued', 'needs-review']),
  reason: z.string().min(1).max(2_000).optional()
})

const storedDraftsSchema: z.ZodType<StoredAssistantDrafts> = z.strictObject({
  version: z.literal(ASSISTANT_DRAFT_STORAGE_VERSION),
  composerText: z.string(),
  queuedTurns: z.array(queuedTurnSchema).max(MAX_QUEUED_TURNS)
})

export class DraftStore {
  private state: StoredAssistantDrafts
  private readonly storage: KeyValueStorage | undefined
  private readonly idFactory: () => string
  private readonly now: () => Date
  private readonly onPersistenceError: (error: Error) => void

  constructor(options: DraftStoreOptions = {}) {
    this.idFactory = options.idFactory ?? randomId
    this.now = options.now ?? (() => new Date())
    this.onPersistenceError =
      options.onPersistenceError ??
      ((error) => console.error('[assistant-drafts]', error))
    this.storage =
      options.storage ?? browserStorage(this.onPersistenceError)
    this.state = this.load() ?? emptyState()
  }

  get composerText(): string {
    return this.state.composerText
  }

  setComposerText(text: string): boolean {
    return this.mutate((state) => {
      state.composerText = text
    })
  }

  enqueue(
    input: Omit<QueuedTurnDraft, 'queueId' | 'queuedAt' | 'status'>
  ): QueuedTurnDraft {
    if (this.state.queuedTurns.length >= MAX_QUEUED_TURNS) {
      throw new Error(
        `The assistant queue is full (${MAX_QUEUED_TURNS} messages).`
      )
    }
    const queued: QueuedTurnDraft = {
      ...structuredClone(input),
      queueId: this.idFactory(),
      queuedAt: this.now().toISOString(),
      status: 'queued'
    }
    if (!this.mutate((state) => state.queuedTurns.push(queued))) {
      throw new Error(
        'EnvCAD could not preserve the queued message in local storage.'
      )
    }
    return structuredClone(queued)
  }

  update(
    queueId: string,
    update: Partial<Pick<QueuedTurnDraft, 'selectionSnapshot' | 'status' | 'reason'>>
  ): boolean {
    return this.mutate((state) => {
      const queued = state.queuedTurns.find((item) => item.queueId === queueId)
      if (!queued) return
      if (update.selectionSnapshot) {
        queued.selectionSnapshot = structuredClone(update.selectionSnapshot)
      }
      if (update.status) queued.status = update.status
      if (update.reason === undefined) delete queued.reason
      else queued.reason = update.reason
    })
  }

  remove(queueId: string): boolean {
    return this.mutate((state) => {
      state.queuedTurns = state.queuedTurns.filter(
        (item) => item.queueId !== queueId
      )
    })
  }

  clearQueue(): boolean {
    return this.mutate((state) => {
      state.queuedTurns = []
    })
  }

  get queuedTurns(): QueuedTurnDraft[] {
    return structuredClone(this.state.queuedTurns)
  }

  private mutate(change: (state: StoredAssistantDrafts) => void): boolean {
    const previous = structuredClone(this.state)
    change(this.state)
    if (this.persist()) return true
    this.state = previous
    return false
  }

  private load(): StoredAssistantDrafts | undefined {
    const raw = this.storage?.getItem(ASSISTANT_DRAFT_STORAGE_KEY)
    if (!raw) return undefined
    try {
      return storedDraftsSchema.parse(JSON.parse(raw) as unknown)
    } catch (error) {
      this.onPersistenceError(
        new Error('Stored assistant drafts are invalid and were quarantined.', {
          cause: error
        })
      )
      return undefined
    }
  }

  private persist(): boolean {
    if (!this.storage) return true
    try {
      this.storage.setItem(
        ASSISTANT_DRAFT_STORAGE_KEY,
        JSON.stringify(this.state)
      )
      return true
    } catch (error) {
      this.onPersistenceError(
        new Error('EnvCAD could not persist assistant drafts.', { cause: error })
      )
      return false
    }
  }
}

function emptyState(): StoredAssistantDrafts {
  return {
    version: ASSISTANT_DRAFT_STORAGE_VERSION,
    composerText: '',
    queuedTurns: []
  }
}

function browserStorage(
  onPersistenceError: (error: Error) => void
): KeyValueStorage | undefined {
  try {
    const fallback = globalThis.localStorage
    const desktop = globalThis.window?.envcadDesktop
    return desktop
      ? new DesktopDraftStorage(
          ASSISTANT_DRAFT_STORAGE_KEY,
          desktop,
          fallback,
          onPersistenceError
        )
      : fallback
  } catch {
    return undefined
  }
}

function randomId(): string {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `queue-${Date.now()}-${Math.random().toString(16).slice(2)}`
}
