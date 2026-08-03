# EnvCAD AI Assistant protocol

Status: protocol v2 is the durable production path. Protocol v1 remains only as
a bounded compatibility adapter while older benchmark and acceptance harnesses
are migrated.

The contract is provider-neutral and lives in `shared/agent-contracts/`.
Renderer code does not import sidecar tool definitions.

## Transport and authentication

The packaged renderer connects to a random loopback WebSocket owned by the
Electron utility process. The upgrade requires:

1. the exact random renderer origin;
2. the `envcad.v1` transport subprotocol; and
3. a per-launch `envcad.session.<token>` subprotocol.

The transport name remains `envcad.v1` for compatibility; it can carry the
versioned protocol-v2 envelopes described below. The token stays in
main/preload/utility-process memory and rotates whenever the supervised sidecar
restarts.

Complete serialized WebSocket frames are bounded. Large source content never
relies on raising that bound: it uses the chunked local-input protocol.
Selection IDs remain renderer-local until an authorized selection query runs.

Every decoded object uses a strict schema. Unknown message types, fields,
providers, tool names, revisions, or unbounded metadata are rejected. Raw Zod,
JSON-RPC, CLI, SDK, and stack-trace text is not projected into normal chat.

## Versioned envelopes

Every protocol-v2 command and event is wrapped as:

```ts
interface MessageEnvelope<T> {
  protocolVersion: 2
  sessionId: string
  messageId: string
  turnId?: string
  sequence: number
  timestamp: string
  payload: T
}
```

Client-command and server-event sequences are monotonic within their session.
They are separate sequence spaces. Stable message IDs make journal appends
idempotent.

All CAD-sensitive commands carry the full workspace revision:

```ts
interface WorkspaceRevision {
  documentId: string
  documentRevision: number
  contentRevision: number
  sheetRevision: number
  viewRevision: number
}
```

Document replacement is explicit. Component revisions cannot regress inside a
turn.

## Durable turns

The renderer assigns `messageId` and `turnId` before send. The sidecar journals
the draft and accepted event before emitting `turn_accepted`. Acceptance does
not wait for provider startup or another model call.

Normal phases are:

```text
draft -> accepted -> ingesting -> briefing -> planning -> inspecting
      -> executing -> verifying -> completed

active -> recovering -> retrying | degraded | needs-input | failed
active -> cancelled
```

Each progress event contains the turn ID, sequence, timestamp, workspace
revision, active skill IDs, provider, elapsed time, and safe status. The local
instruction breakdown is a separate event and contains objective, inputs,
constraints, required context, planned tool categories, expected output, and
risk.

Every accepted turn emits exactly one `turn_finished`:

```ts
type TurnOutcome =
  | 'completed'
  | 'recovered'
  | 'needs-input'
  | 'cancelled'
  | 'failed'
```

A failed or cancelled v2 turn never emits legacy `assistant_done`. Duplicate
submission replays journaled events and never re-executes the provider or a CAD
mutation.

`resume_session` supplies the session, active turn, and last received server
sequence. The sidecar returns only later events. WebSocket loss does not clear
the active turn. Partial text, progress, skills, receipts, and terminal state
are rebuilt by `TurnProjection`.

The Electron main process owns checksummed turn journals under
`userData/agent-journal-v2`. On Windows, active renderer cursor/session state,
composer drafts, and queued messages are also atomically mirrored into two
fixed, allowlisted files encrypted with Electron `safeStorage`. This permits
recovery when a restart changes the renderer's random loopback origin.

## Structured failures

Terminal errors use the shared failure taxonomy:

```ts
type FailureKind =
  | 'validation'
  | 'domain'
  | 'stale-workspace'
  | 'transient-tool'
  | 'transient-provider'
  | 'rate-limit'
  | 'authentication'
  | 'permission'
  | 'security'
  | 'cancelled'
  | 'unknown-operation'
```

Each failure has a stable code, safe user message, retryability, optional field
corrections and retry delay, and explicit recovery actions. Developer details
remain in redacted diagnostics.

Recovery is bounded: argument correction, same-provider retry, conversation
recreation, provider/runtime restart, consented cross-provider fallback,
database-only degradation, then an actionable terminal. Security failures fail
closed. Cross-provider fallback is disabled by default and is never permitted
for unresolved mutations.

## Large input

Inline turn text is limited to 128 KiB of UTF-8 so provider context has room for
instructions and bounded tool results. This is not a composer character limit.
Larger instructions and attachments use:

```text
input_begin
input_chunk
input_commit
input_abort
```

Chunks decode to at most 256 KiB. Every chunk and committed artifact has a
SHA-256 digest. The default local quota is 1 GiB with an additional free-space
reserve. Capacity is checked before provider execution.

A committed artifact returns an `InputReference` with exact bytes, UTF-8
character length when applicable, chunk count, media type, source name, and
complete digest. Authoritative bytes remain local until explicitly cleared.
Classification uses only a bounded local preview.

Providers can request only:

- `get_input_metadata`
- `get_input_outline`
- `search_input`
- `read_input_chunk`
- `read_input_range`

Reads are bounded and restricted to input IDs attached to the active turn.
Valid UTF-8 ranges return text without duplicate Base64. Binary ranges return
Base64 without lossy text. Summaries are never authoritative.

`ContextBudgetManager` reserves output capacity, counts static instructions,
the current prompt, tool metadata, and image capacity, and refuses unsafe
results. A write result's maximum size is reserved before mutation so context
exhaustion cannot turn a committed edit into a provider error.

## Skills and capability broker

The sidecar verifies and compiles pinned skill manifests once at startup.
`cad-core` and `dxf-core` activate before every accepted turn. Local
classification conditionally activates drawing analysis, geometry, layers,
annotations, sheets, imports, environmental siting, and visual QA. Activation
events include name, semantic version, provenance digest status, and time.

A mandatory integrity failure blocks AI writes while manual CAD, conversation,
and diagnostics remain available.

`CapabilityBroker` is the only provider-to-application boundary. It:

- starts from the neutral canonical manifest;
- restricts tools to verified active skills and available capabilities;
- validates strict inputs;
- rechecks skill integrity before every write;
- applies manifest timeout and output limits;
- enforces context capacity;
- records redacted allow/deny audit events; and
- delegates only to native CAD, the drawing read model, revision-bound vision,
  or active-turn input retrieval.

Providers never receive user MCP configuration, shell, filesystem, web,
connector, plugin, app, skill, or subagent authority. Claude's MCP server
registers only broker-permitted tools for the active intent. Codex currently
attaches dynamic tools at `thread/start`, the only point supported by the
installed app-server schema; its static thread catalog is still guarded on
every invocation by the same intent-scoped broker. Changing that catalog
mid-thread is deferred until the upstream interface can do so without losing
conversation continuity.

## Exactly-once mutations

Every mutating tool is converted to a `CadOperationRequest` containing:

- stable turn, operation, and operation-group IDs;
- deterministic idempotency key and arguments hash;
- complete expected workspace revision; and
- deadline.

The renderer's single-writer `OperationCoordinator`:

1. returns the prior receipt for a repeated idempotency key;
2. blocks while any receipt is unresolved;
3. checks the complete revision before execution;
4. persists `pending` before opening the CAD transaction;
5. runs mutation and postconditions inside the transaction callback;
6. commits the receipt only after postconditions pass;
7. records rolled-back, cancelled, or unknown status explicitly; and
8. never retries a pending or unknown operation.

The Electron main process is the production receipt/result owner. Receipt
transitions are checksummed and synchronized; large results are
content-addressed and digest-verified. `get_operation_status` reconciles timeout
or connection-loss uncertainty. A provider resumes after committed receipts
instead of replaying them.

One assistant action has one operation group and one visible Undo AI action.
Manual CAD remains available if the AI ledger is poisoned or unresolved.

## Drawing reads and vision

`DrawingReadModel` indexes entity ID, layer, type, text, bounding box,
visibility, space, and annotation type by workspace revision. Stable cursor
pagination no longer requires a model-space rescan for every page. Immutable
queries can run concurrently; writes remain serialized.

Vision capabilities are:

- `inspect_model_view`
- `inspect_sheet_preview`
- `inspect_region`
- `inspect_selection`
- `compare_before_after`
- `render_analysis_overlay`

Each image has a digest, capture/evidence ID, complete revision, bounds,
selection IDs, visible layers, and render settings. The renderer and sidecar
independently validate its MIME header, dimensions, byte length, aspect ratio,
revision, and SHA-256. Relevant layout/annotation/visibility requests capture
evidence before provider planning and after mutation. Without valid evidence,
the result is explicitly database-only and cannot claim visual QA.

## Provider and runtime supervision

Provider configuration is revisioned and make-before-break. Discovery is
single-flight and cached. Health, retry budgets, circuit breakers, conversation
recreation, and fallback consent are owned above the Claude and Codex adapters.
Ordinary domain/tool errors are recoverable observations, not security
shutdowns.

Electron's AI runtime supervisor restarts an unexpectedly exited sidecar with
bounded exponential backoff and jitter, a restart-window circuit breaker, a
fresh token/origin binding, and journal restoration. It does not enter an
infinite crash loop.

Claude uses no built-in tools, settings, plugins, or persistence. Codex runs
`app-server --stdio` in an isolated empty runtime directory with read-only,
no-network, never-approval policy; user MCP servers and all non-CAD surfaces are
disabled and attested before use.

## Protocol-v1 compatibility

Legacy `user_message`, `status`, `assistant_text_delta`, `assistant_done`,
`tool_call`, and `tool_result` messages remain accepted only by the
compatibility path. New renderer turns use v2. Compatibility completion is
emitted only for a successful v2 terminal; failure and cancellation never
masquerade as completion.
