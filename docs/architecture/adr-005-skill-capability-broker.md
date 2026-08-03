# ADR-005: Verified skills and app-owned capability broker

- Status: Accepted
- Date: 2026-07-29
- Owners: EnvCAD skill and capability runtime

## Context

V1 reloads and injects complete CAD/DXF skill sources on every turn, while tool
definitions live in the sidecar and are imported by renderer protocol code.
Providers need a smaller, deterministic capability surface without arbitrary
access to user MCP configuration, the shell, or the filesystem.

## Decision

Bundled skills are compiled into signed or digested manifests at sidecar
startup. `cad-core` and `dxf-core` activate before every accepted turn. Intent
classification conditionally activates drawing analysis, geometry, layer,
annotation, sheet, import, environmental, and visual-QA skills.

The runtime checks cached manifest integrity at startup and rechecks metadata
and digest before mutation when source inputs change. It emits visible
`skill_activated` events. Failure of a mandatory skill blocks AI mutation while
leaving manual CAD, conversation, and diagnostics available.

One app-owned `CapabilityBroker` is the only provider tool boundary. It exposes
allowlisted capabilities from:

- native CAD commands and queries;
- the drawing read model;
- revision-bound vision;
- bounded input retrieval; and
- explicitly approved MCP adapters.

Every capability declares schema, data scope, timeout, output bound,
mutability, retry safety, idempotency requirement, redaction, audit behavior,
and external approval policy. Providers never receive arbitrary MCP, shell, or
filesystem configuration.

`shared/agent-contracts/tool-manifest.ts` is the neutral canonical policy
catalog. Sidecar Zod schemas and renderer validation must agree with it. The
renderer no longer imports definitions from `sidecar/src`.

## Consequences

- Skill source is not redundantly injected into multiple instruction fields.
- Tool bundles can be registered by intent.
- Unapproved MCP capabilities are unreachable by construction.
- Integrity and activation become visible release invariants.
