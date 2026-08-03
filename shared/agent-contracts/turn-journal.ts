import { z } from 'zod'
import {
  agentClientEnvelopeSchema,
  agentServerEnvelopeSchema,
  type AgentClientEnvelope,
  type AgentServerEnvelope,
  type SubmitTurnCommand
} from './protocol'
import {
  turnAcceptedSchema,
  turnEventSchema,
  type TurnAccepted,
  type TurnEvent,
  type TurnPhase
} from './turn-events'

export type SubmitTurnEnvelope = AgentClientEnvelope & {
  payload: SubmitTurnCommand
}

export type PersistedTurnEventEnvelope = AgentServerEnvelope & {
  payload: TurnEvent
}

export interface TurnJournalSnapshot {
  draft: SubmitTurnEnvelope
  events: PersistedTurnEventEnvelope[]
}

export interface OpenTurnSummary {
  turnId: string
  sessionId: string
  clientMessageId: string
  lastSequence: number
  phase: OpenTurnPhase
}

export type OpenTurnPhase = Exclude<
  TurnPhase,
  'draft' | 'completed' | 'needs-input' | 'cancelled' | 'failed'
>

const identifierSchema = z.string().min(1).max(200)
const sequenceSchema = z.number().int().nonnegative().safe()
const openTurnPhaseSchema = z.enum([
  'accepted',
  'ingesting',
  'briefing',
  'planning',
  'inspecting',
  'executing',
  'verifying',
  'recovering',
  'retrying',
  'degraded'
])

export const submitTurnEnvelopeSchema = agentClientEnvelopeSchema
  .refine(
    (envelope) => envelope.payload.type === 'submit_turn',
    'Turn journal drafts must contain submit_turn.'
  )
  .refine(
    (envelope) =>
      new TextEncoder().encode(JSON.stringify(envelope)).byteLength <=
      1_500_000,
    'Turn journal draft exceeds its durable record envelope.'
  )
  .transform((envelope) => envelope as SubmitTurnEnvelope)

export const persistedTurnEventEnvelopeSchema = agentServerEnvelopeSchema
  .refine(
    (envelope) => turnEventSchema.safeParse(envelope.payload).success,
    'Turn journal events must contain a turn event.'
  )
  .transform((envelope) => envelope as PersistedTurnEventEnvelope)

export const turnJournalSnapshotSchema: z.ZodType<TurnJournalSnapshot> =
  z.strictObject({
    draft: submitTurnEnvelopeSchema,
    events: z.array(persistedTurnEventEnvelopeSchema).min(1).max(100_000)
  })

export type TurnJournalCommand =
  | {
      type: 'accept-turn'
      eventId: string
      draft: SubmitTurnEnvelope
      accepted: TurnAccepted
    }
  | {
      type: 'append-event'
      eventId: string
      turnId: string
      event: TurnEvent
    }
  | {
      type: 'read-turn'
      turnId: string
      afterSequence: number
    }
  | { type: 'list-open-turns' }

export const turnJournalCommandSchema: z.ZodType<TurnJournalCommand> =
  z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('accept-turn'),
      eventId: identifierSchema,
      draft: submitTurnEnvelopeSchema,
      accepted: turnAcceptedSchema
    }),
    z.strictObject({
      type: z.literal('append-event'),
      eventId: identifierSchema,
      turnId: identifierSchema,
      event: turnEventSchema
    }),
    z.strictObject({
      type: z.literal('read-turn'),
      turnId: identifierSchema,
      afterSequence: sequenceSchema
    }),
    z.strictObject({
      type: z.literal('list-open-turns')
    })
  ])

export type TurnJournalResult =
  | {
      type: 'turn-accepted'
      envelope: PersistedTurnEventEnvelope
      duplicate: boolean
    }
  | {
      type: 'event-appended'
      envelope: PersistedTurnEventEnvelope
      duplicate: boolean
    }
  | {
      type: 'turn-read'
      draft?: SubmitTurnEnvelope
      lastSequence?: number
      terminal?: boolean
      eventsAfterCursor: PersistedTurnEventEnvelope[]
    }
  | {
      type: 'open-turns-listed'
      turns: OpenTurnSummary[]
    }

export const turnJournalResultSchema: z.ZodType<TurnJournalResult> =
  z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('turn-accepted'),
      envelope: persistedTurnEventEnvelopeSchema,
      duplicate: z.boolean()
    }),
    z.strictObject({
      type: z.literal('event-appended'),
      envelope: persistedTurnEventEnvelopeSchema,
      duplicate: z.boolean()
    }),
    z.strictObject({
      type: z.literal('turn-read'),
      draft: submitTurnEnvelopeSchema.optional(),
      lastSequence: sequenceSchema.optional(),
      terminal: z.boolean().optional(),
      eventsAfterCursor: z
        .array(persistedTurnEventEnvelopeSchema)
        .max(100_000)
    }).superRefine((result, context) => {
      const presence = [
        result.draft !== undefined,
        result.lastSequence !== undefined,
        result.terminal !== undefined
      ]
      if (presence.some(Boolean) && !presence.every(Boolean)) {
        context.addIssue({
          code: 'custom',
          message: 'Turn read metadata must be present or absent as one unit.'
        })
      }
      if (!presence.some(Boolean) && result.eventsAfterCursor.length > 0) {
        context.addIssue({
          code: 'custom',
          path: ['eventsAfterCursor'],
          message: 'Unknown turns cannot return journal events.'
        })
        return
      }
      if (!result.draft || result.lastSequence === undefined) return
      let previousSequence = -1
      let terminalSeen = false
      for (const [index, event] of result.eventsAfterCursor.entries()) {
        if (
          event.sessionId !== result.draft.sessionId ||
          event.turnId !== result.draft.turnId
        ) {
          context.addIssue({
            code: 'custom',
            path: ['eventsAfterCursor', index],
            message: 'Turn tail event identity does not match its draft.'
          })
        }
        if (event.sequence <= previousSequence) {
          context.addIssue({
            code: 'custom',
            path: ['eventsAfterCursor', index, 'sequence'],
            message: 'Turn tail sequences must be strictly increasing.'
          })
        }
        if (event.sequence > result.lastSequence) {
          context.addIssue({
            code: 'custom',
            path: ['eventsAfterCursor', index, 'sequence'],
            message: 'Turn tail sequence exceeds lastSequence.'
          })
        }
        if (terminalSeen) {
          context.addIssue({
            code: 'custom',
            path: ['eventsAfterCursor', index],
            message: 'Turn tail contains an event after its terminal event.'
          })
        }
        terminalSeen ||= event.payload.type === 'turn_finished'
        previousSequence = event.sequence
      }
    }),
    z.strictObject({
      type: z.literal('open-turns-listed'),
      turns: z
        .array(
          z.strictObject({
            turnId: identifierSchema,
            sessionId: identifierSchema,
            clientMessageId: identifierSchema,
            lastSequence: sequenceSchema,
            phase: openTurnPhaseSchema
          })
        )
        .max(1_000)
    })
  ])

export interface TurnJournalPort {
  execute(command: TurnJournalCommand): Promise<TurnJournalResult>
}
