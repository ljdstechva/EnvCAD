# ADR-006: Provider supervision and fallback privacy

- Status: Accepted
- Date: 2026-07-29
- Owners: EnvCAD provider infrastructure

## Context

V1 closes the active provider conversation before a replacement starts and has
no persistent cross-provider consent policy. A provider crash can therefore
lose the conversation, while automatic fallback could silently disclose
prompts or drawings to another provider.

## Decision

`ProviderSupervisor` owns provider health, capability discovery, prewarming,
circuit breakers, bounded restarts, and conversation recreation. Configuration
changes are make-before-break: the working provider remains active until the
replacement proves ready.

Cross-provider fallback is disabled by default. It requires a persisted,
user-enabled policy that identifies permitted providers and data classes. Each
fallback is disclosed in the timeline before data is sent. A security failure
or unresolved mutation status never triggers provider fallback.

Provider adapters translate lifecycle and SDK events into neutral application
events. They receive only the intent-specific capability bundle from the
app-owned broker. Ordinary CAD domain or validation errors remain recoverable
model observations and do not call a security shutdown path.

After a crash, the supervisor restores the execution journal. It skips
committed receipts, reconciles pending or unknown mutations, and recreates the
conversation only when replay is safe. Authentication failures mark one
provider unavailable; another provider is used only under the fallback policy.

Default logs contain identifiers, phases, durations, counts, outcomes, and
redacted codes. They exclude prompts, input bodies, DXF content, drawing
images, credentials, tokens, and authentication output.

## Consequences

- Working configuration is not destroyed by a failed replacement.
- Provider recovery and provider switching are separate operations.
- Privacy policy is explicit, durable, and testable.
- Provider-specific failures do not leak into renderer state or prose.
