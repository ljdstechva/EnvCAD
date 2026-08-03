# ADR-003: Structured failure taxonomy and recovery budgets

- Status: Accepted
- Date: 2026-07-29
- Owners: EnvCAD turn orchestration

## Context

V1 tool results use free-form error strings, provider adapters make
provider-specific interruption decisions, and raw backend diagnostics can
reach the timeline. Ordinary CAD validation failures are therefore difficult
to repair safely and may be confused with security violations.

## Decision

Application boundaries use `StructuredFailure` from
`shared/agent-contracts/failures.ts`. Each failure has a stable kind and code,
safe user message, retry classification, optional field errors and delay, and
explicit recovery actions. Developer diagnostics remain redacted and collapsed
by default.

Recovery policy is centralized:

1. repair invalid arguments in the same conversation, at most twice;
2. rehydrate and replan once for missing drawing context or stale revision;
3. retry transient read-only work with bounded jitter;
4. reconcile mutation status before any replay decision;
5. recreate an unhealthy conversation or provider process within its circuit
   breaker;
6. use cross-provider fallback only under a persisted user policy; and
7. finish as degraded, needs-input, or failed with an actionable state.

Security, authentication, permission, and domain failures remain distinct.
Security violations fail closed. Domain and validation failures are returned to
the same model when repair is safe; they do not terminate a provider process.

## Presentation

User-facing failures always answer:

1. what happened;
2. what EnvCAD already tried;
3. whether the drawing changed; and
4. what the user can do next.

Raw Zod issues, stack traces, JSON-RPC payloads, SDK exceptions, CLI output, and
provider authentication output are not normal timeline content.

## Consequences

- Provider adapters translate, but do not define, failure policy.
- Recovery is bounded, visible, measurable, and consistent across providers.
- Tests can assert behavior by code rather than brittle prose.
