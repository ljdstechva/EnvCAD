# ADR-001: Durable turn state machine

- Status: Accepted
- Date: 2026-07-29
- Owners: EnvCAD agent runtime

## Context

The v1 bridge infers a turn from WebSocket connection state and the
`thinking`/`idle` status pair. It has no durable turn identifier or event
sequence. Its `finally` block emits `assistant_done` even after provider
failure, and a socket close clears renderer state. Those behaviors cannot prove
that every accepted message has one terminal outcome.

## Decision

The renderer assigns `messageId` and `turnId` before network send and durably
stores the draft under those IDs. `TurnOrchestrator` idempotently accepts or
resumes that identity, persists acknowledgment before provider work, and drives
this state machine. The protocol-v1 adapter assigns IDs only for legacy
messages that cannot supply them.

```text
draft -> accepted -> ingesting -> briefing -> planning -> inspecting
      -> executing -> verifying -> completed

active -> recovering -> retrying | degraded | needs-input | failed
active -> cancelled
```

Every transition is a protocol-v2 envelope with a monotonic server-event
sequence scoped to one session, timestamp, complete workspace revision, active
skills, provider, elapsed time, and safe status text. Client commands use their
own monotonic per-session sequence; they do not contend with the server event
counter. A resume cursor is the last received server-event sequence. A turn may emit exactly one
`turn_finished`; subsequent terminal attempts are rejected and recorded as a
diagnostic invariant violation.

Acceptance is local work only. The draft and acknowledgment must reach durable
local storage before `turn_accepted` is emitted, and the measured acceptance
latency gate is 150 ms. The first instruction breakdown is deterministic and
does not wait for provider startup. Draft, acceptance, transition journal,
partial assistant output, operation receipts, and the terminal event are
restorable after reconnect or process restart. Persistent journals live under
Electron `userData`, separate from the disposable provider runtime directory.

Protocol v1 remains behind an adapter during migration. The adapter may project
v2 progress to `status` and successful completion to `assistant_done`, but it
must never synthesize completion after failure.

## Consequences

- WebSocket connectivity is no longer the source of truth for turn state.
- Renderer projections can resume from `(sessionId, turnId, lastSequence)`.
- Provider adapters emit neutral observations; they do not finish turns.
- Cancellation is a terminal outcome and preserves committed receipts.
- Terminal uniqueness becomes a testable domain invariant.

## Rejected alternatives

- Treating socket close as turn failure loses resumability.
- Inferring completion from provider stream end cannot distinguish failure,
  cancellation, recovery, or unresolved mutation.
- Keeping terminal behavior only in Vue state is not durable and cannot
  reconcile sidecar restarts.
