# EnvCAD agent architecture v2

- Status: Implemented safety baseline; incremental decomposition continues
- Date: 2026-07-29
- Scope: renderer, Electron main/utility process, sidecar, provider adapters,
  native CAD boundary

## Live dependency flow

```text
Assistant Workbench
  -> AgentBridge compatibility facade
       -> DurableTurnSession / TurnProjection / DraftStore
       -> InputIngestionClient
       -> OperationCoordinator
  -> authenticated loopback protocol-v2 transport
       -> BridgeSession transport adapter
            -> TurnOrchestrator / TurnExecution
            -> SkillRegistry / CapabilityBroker / ContextBudgetManager
            -> ProviderSupervisor
                 -> Claude adapter
                 -> Codex adapter
  -> CAD ports
       -> durable operation ledger
       -> mlightcad transaction handlers
       -> revision-keyed DrawingReadModel
       -> DrawingVisionService
```

Neutral contracts in `shared/agent-contracts` are the only contract authority.
Application/domain code does not depend on Vue, Electron, WebSocket, provider
SDKs, or mlightcad.

## Enforced invariants

### Turns

- IDs are assigned before send.
- Draft plus acknowledgment is journaled before `turn_accepted`.
- Server events have stable IDs and monotonic per-session sequences.
- A duplicate submit replays journaled events without provider execution.
- A state machine permits exactly one terminal outcome.
- Reconnect uses `(sessionId, turnId, lastSequence)` and preserves partial text.
- Electron startup reconciles abandoned turns to an actionable terminal state.
- Packaged renderer cursors, composer drafts, and queues use fixed-key,
  `safeStorage`-protected main-process persistence across random origins.

### Mutations

- Every write has a deterministic idempotency key and complete expected
  workspace revision.
- `pending` is durable before the CAD transaction starts.
- The single writer holds a global unresolved-operation barrier.
- Postconditions execute inside the transaction callback.
- Timeout or lost acknowledgment becomes `unknown` and is reconciled by
  `get_operation_status`; it is never blindly retried.
- A repeated key returns the prior receipt and stored result.
- One assistant action maps to one undo group.

### Input and context

- Composer length is not an arbitrary product limit.
- Text above 128 KiB becomes an authoritative local reference.
- Chunks are at most 256 KiB and each chunk plus the complete artifact is
  SHA-256 verified.
- The default content quota is 1 GiB with an early free-space check.
- Retrieval is active-turn scoped and output-bounded.
- Context accounting reserves write-result capacity before mutation.
- A 100 MiB fixture proves exact start, middle, and end retrieval.

### Skills and capabilities

- `cad-core` and `dxf-core` are verified and activated before every accepted
  turn.
- Local intent routing controls conditional skill activation.
- Mandatory integrity failure blocks AI writes, not manual CAD.
- One app-owned broker validates schema, skills, capabilities, timeout, output,
  data scope, context, and audit policy for every provider call.
- No provider receives arbitrary MCP, shell, filesystem, web, connector, app,
  plugin, skill, or subagent authority.

### Drawing awareness

- The complete workspace revision covers document identity, document content,
  sheet, and view.
- `DrawingReadModel` indexes entity, layer, type, text, bounds, visibility,
  model/paper space, and annotation kind.
- Relevant visual requests capture revision-bound evidence before planning.
- Layout/annotation/visibility changes capture post-edit evidence.
- Visual claims require validated digests; otherwise verification is explicitly
  database-only.

### Recovery and privacy

- Provider failures use a structured taxonomy and bounded recovery ladder.
- Ordinary CAD/domain errors do not become security shutdowns.
- Sidecar and provider supervisors use health state, bounded backoff, cached
  discovery, circuit breakers, and make-before-break replacement.
- Cross-provider fallback is disabled unless the user persistently enables it;
  unresolved writes and security failures prohibit fallback.
- Default logs contain identifiers, counts, timings, and safe codes, not
  prompts, DXF bodies, images, credentials, or provider authentication output.

## Assistant Workbench

The workbench defaults to 400 px, resizes from 340 to 560 px by pointer or
keyboard, and keeps the composer editable while a turn runs. It exposes queued
follow-ups, attachments, instruction breakdown, verified skills, phase/tool
progress, verification evidence, recovery actions, cancellation, grouped undo,
before/after comparison, and redacted diagnostic export.

Long activity history is windowed to a bounded accessible DOM. Status and
terminal messages use live regions, focus moves to recovery actions, controls
have semantic labels and visible focus, and reduced motion is honored.

## Provider registration boundary

Claude creates its MCP server after intent activation and registers only the
broker-permitted names.

The installed Codex app-server schema exposes experimental `dynamicTools` only
on `thread/start`; it does not expose per-turn tool replacement. Recreating a
thread per turn would discard or duplicate conversation history, so Codex keeps
the canonical thread schema while the broker denies every name outside the
active intent. This preserves conversation continuity and fail-closed authority.
When app-server supports safe per-turn replacement, registration can be narrowed
without changing the broker or canonical manifest.

## Incremental decomposition boundary

Safety-critical behavior has moved behind focused modules even though the
legacy facades remain large:

- `src/agent/bridge.ts` delegates durable turns, projections, drafts, input, and
  operations to `src/agent/runtime` and `src/cad/operations`.
- `sidecar/src/bridgeSession.ts` delegates turn lifecycle, recovery, skills,
  input, context, and capability policy to application/domain modules.
- `src/agent/handlers.ts` delegates multi-entity mutation behavior to
  `src/cad/tools/entities`; remaining tool-category extraction is mechanical
  migration debt.
- provider lifecycle supervision is separated, while event-router and
  app-server client code still share legacy adapter files.

This is intentionally not a big-bang rename. New and refactored domain modules
target the agreed size/function limits; compatibility facades are reduced in
later behavior-preserving slices.

## Verification map

| Gate | Primary evidence |
| --- | --- |
| Exactly one terminal | `turnStateMachine`, `turnOrchestrator`, durable journal tests |
| Exactly-once write | mutation idempotency, operation ledger, 31-second reconciliation |
| Partial-result rollback | transaction postcondition and mutation fault tests |
| Reconnect/reload | connection resume unit and `agent-recovery.spec.ts` |
| Full app restart draft | packaged desktop restart test |
| Sidecar/provider crash | runtime and provider supervisor tests |
| Long input/context/quota | input ingestion, context budget, `large-input.spec.ts` |
| Skills/broker/corruption | skill registry, capability broker, skill E2E |
| Read performance | 100,000-entity drawing-read fixture |
| Vision integrity | vision evidence unit and visual-verification E2E |
| Accessibility | Assistant Workbench accessibility E2E |

See the six ADRs in this directory for individual decisions and
`docs/agent-protocol.md` for the wire contract.

## Verified release baseline

The 2026-07-29 implementation pass completed these local gates:

- 673 unit/integration tests in 73 files;
- 32 Chromium end-to-end scenarios;
- 4 freshly packaged Electron/Windows scenarios, including close/relaunch
  recovery of an exact Unicode draft through Windows protected storage;
- TypeScript project checks and the production Vite build;
- `git diff --check`;
- visual inspection of the packaged CAD/Assistant Workbench screenshot.

The 100 MiB UTF-8 input test and 100,000-entity cached read-model fixture are
part of the normal unit suite. Automated provider tests use deterministic
adapters and do not contact Anthropic or OpenAI.

The measured service-level fields (`acceptedMs`, first progress/text, provider
startup, tool timing, retries, and total duration) are implemented, but warm
provider p50, fleet-wide 95% recovery, and 99.9% terminal-outcome objectives
remain operational targets rather than claims derived from one workstation.
Cross-provider fallback remains disabled. Provider-adapter and CAD-handler
compatibility facades also remain explicit incremental decomposition debt.

`npm audit --omit=dev` currently reports the documented transitive
`lodash-es` findings from pinned `@mlightcad/*` packages (one high and two
moderate) with no npm-provided fixed version; see `TESTING.md`.
