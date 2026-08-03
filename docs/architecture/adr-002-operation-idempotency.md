# ADR-002: Exactly-once CAD operation coordination

- Status: Accepted
- Date: 2026-07-29
- Owners: EnvCAD CAD application layer

## Context

CAD mutations currently cross a WebSocket boundary and execute in the renderer.
A timeout can occur after mlightcad commits but before the sidecar observes the
result. Retrying the tool in that state can duplicate geometry. Several
multi-entity operations also validate their result after the database
transaction has committed.

## Decision

All AI mutations pass through a renderer-owned `OperationCoordinator`. Durable
receipt and result storage has one authority in the Electron main process,
reachable only through a narrow, sender-checked IPC port. Each request carries
a stable operation ID, group ID, idempotency key, arguments hash, deadline, and
complete expected workspace revision.

The coordinator:

1. returns the prior receipt for a known idempotency key;
2. rejects a mismatched complete workspace revision before mutation;
3. durably records `pending` before opening the CAD transaction;
4. executes mutation and postcondition validation inside one transaction
   callback;
5. records `committed` in one atomic ledger transition only after CAD
   postconditions pass;
6. records `rolled-back` or `cancelled` when those states are known;
7. records `unknown` when commit status cannot be proven; and
8. never reruns an operation while its receipt is `pending` or `unknown`; and
9. applies a global AI-write barrier while any operation is unresolved.

The barrier is intentionally global because the current renderer document ID
is session-scoped. A process restart must not evade an older unresolved receipt
by assigning a new document ID. The barrier can become document-scoped only
after EnvCAD has a persisted snapshot identity and a tested reconciler.

The CAD transaction and main-process journal are separate resource managers;
EnvCAD cannot claim one atomic commit across both. A crash after CAD commit but
before the ledger transition therefore leaves an explicit uncertainty window.
Each mutation writes a reconciliation marker or postcondition fingerprint
inside the CAD transaction. Restart recovery compares that evidence with the
pending receipt and a restart-safe drawing snapshot before it may classify the
operation as committed or rolled back. If evidence is insufficient, status
remains `unknown` and every later AI write stays blocked.

`get_operation_status` queries the ledger and reconciliation evidence. Recovery
reconciles status before it considers any replay. A provider turn journals
operation receipts and resumes after the last committed operation instead of
replaying writes.

One provider action uses one `operationGroupId`. Multi-batch edits retain enough
inverse data to undo or roll back the complete group. CAD-owned index changes
occur inside the CAD transaction where possible; external projections are
revision-keyed and cannot become authoritative until the committed revision is
visible.

## Persistence

Receipts use a checksummed, sequenced append journal under
`app.getPath('userData')/agent-journal-v2`; large results use content-addressed
files in the same persistent root. The main process acknowledges a receipt
append only after the file is synchronized. A partial tail, invalid receipt,
illegal transition, idempotency collision, or lost append acknowledgement
poisons the journal owner and disables further AI writes until a clean restart
or explicit recovery. Result reads verify byte length, digest, and JSON shape
before replay.

Electron's existing single-instance lock and one main-process journal singleton
are required invariants; the process-local ownership guard is not an OS file
lock. Renderer IndexedDB is not the production ledger because the packaged
localhost server uses a random port and therefore a new origin on later
launches. Provider runtime files remain under the separate ephemeral
`runtimeDirectory` and are deleted at shutdown.

The current evidence establishes process-restart persistence and fail-closed
fault behavior. It does not claim absolute power-loss durability: directory
metadata synchronization, journal compaction, and power-failure testing remain
exit criteria before that stronger claim.

## Consequences

- Mutation calls are serialized; immutable reads may still run concurrently.
- Timeouts report uncertainty instead of a false failure or success.
- Idempotency applies to the operation, not the transient WebSocket call ID.
- Manual edits remain available when the AI ledger is unhealthy.
- Recovery cannot claim exactly-once completion until reconciliation evidence
  closes the cross-store uncertainty window.

## Rejected alternatives

- Blind retry is prohibited.
- A sidecar-only ledger cannot prove whether a renderer-local transaction
  committed before connection loss.
- Marking committed before postconditions can preserve partial CAD results.
