# Current agent characterization

Date: 2026-07-29

This document records the baseline before protocol-v2 migration. It describes
the inspected worktree, including its existing uncommitted changes.

This is intentionally historical. The implemented v2 state and remaining
incremental decomposition boundary are recorded in
[`agent-architecture-v2.md`](agent-architecture-v2.md).

## Verified baseline

- `npm run typecheck` passes.
- `npm test` passes 46 files and 537 tests.
- Loopback origin and subprotocol authentication are enforced by
  `sidecar/src/server.ts`.
- Client and server protocol messages use strict parsers in
  `src/agent/protocol.ts`.
- Renderer tool dispatch checks the frozen document/content revision before
  execution and validates image digests before returning results.
- Sidecar and renderer serialize CAD tool calls.
- Provider adapters expose only the EnvCAD CAD tool surface.

## Characterized gaps

| Area | Current behavior | Required migration |
| --- | --- | --- |
| Turn identity | Inferred from one socket and `thinking` state | Durable message/turn IDs and sequenced events |
| Terminal state | `assistant_done` is emitted from `finally`, including after failure | Exactly one typed terminal outcome |
| Reconnect | Active turn and partial response are cleared | Resume by session, turn, and sequence |
| Revision | Document/content only | Document identity plus document, content, sheet, and view revisions |
| Mutation timeout | Returns a free-form timeout error | Unknown receipt then ledger reconciliation |
| Idempotency | WebSocket call IDs only | Durable operation IDs and idempotency keys |
| Postconditions | `copy_entities` count check occurs after commit | Validate all postconditions inside transaction |
| Tool policy | Definitions originate in sidecar and protocol imports them | Neutral canonical shared manifest |
| Tool timeout | Per-spec value exists but bridge uses one global value | Manifest timeout is authoritative |
| Skills | Full sources loaded for each turn | Verified startup registry and compiled fragments |
| Input | Full prompt in one bounded WebSocket message | Local chunk store and retrieval references |
| Provider switch | Old conversation closes before replacement starts | Make-before-break supervisor |
| Sidecar crash | One-shot process reports failure | Bounded restart and journal restore |
| UI | Fixed chat lifecycle tied to connection | Resizable resumable workbench |

## Existing characterization coverage

- `sidecar/src/__tests__/bridgeSession.test.ts`: provider/configuration,
  message validation, tool timeout, revision forwarding, and completion.
- `src/agent/__tests__/bridge.test.ts`: renderer connection, frozen selection,
  configuration revisions, serialized tools, image validation, and disconnect.
- `src/agent/__tests__/protocol.test.ts`: strict protocol parsing.
- `sidecar/src/__tests__/providerManager.test.ts`: discovery and provider
  replacement behavior.
- `desktop/__tests__/sidecarProcess.test.ts`: current one-shot utility-process
  lifecycle.
- `src/agent/handlers.integration.test.ts`: deterministic CAD mutations and
  transaction behavior.

These tests are retained as compatibility characterization while new v2 domain
invariant tests are added.
