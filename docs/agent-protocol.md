# EnvCAD AI Assistant protocol

This document describes the v0.2.0 renderer-to-sidecar contract. The protocol is
provider-neutral: Claude Code and OpenAI Codex share configuration, lifecycle,
streaming, metrics, and CAD tool messages.

## Transport and authentication

The packaged renderer connects to a random loopback WebSocket port created by
the Electron utility process. The HTTP upgrade must satisfy all three checks:

1. exact renderer `Origin`;
2. subprotocol `envcad.v1`;
3. a per-launch `envcad.session.<token>` subprotocol.

The 256-bit token exists only in Electron main/preload/utility-process memory.
Payloads are limited to 2 MiB. The app-server used by Codex is stdio-only and
never exposes a network port.

Every decoded object is strict: unknown fields, unknown message types, invalid
provider IDs, non-canonical tool names, unsupported effort values, and
unbounded strings/arrays are rejected.

## Capability and configuration lifecycle

The utility process starts even when neither provider is installed. It sends an
initial catalog with `checking` statuses, discovers both providers concurrently,
then sends provider-specific updates.

Client:

```json
{ "type": "refresh_ai_capabilities" }
```

Server:

```json
{
  "type": "ai_capabilities",
  "refreshing": false,
  "providers": [
    {
      "id": "claude-code",
      "displayName": "Claude Code",
      "status": "ready",
      "statusMessage": "Claude Code is ready.",
      "executableVersion": "2.1.220",
      "discoveryMs": 820,
      "models": [
        {
          "id": "default",
          "invocationName": "default",
          "resolvedModel": "claude-opus-5",
          "displayName": "Default",
          "description": "Provider description",
          "supportedEfforts": [
            {
              "value": "high",
              "displayName": "High",
              "isDefault": true
            }
          ],
          "defaultEffort": "high",
          "isDefault": true
        }
      ]
    }
  ]
}
```

The cached catalog uses `"refreshing": true`; the final catalog always uses
`"refreshing": false`. Discovery is single-flight. While either the initial
discovery or a manual refresh is pending, the renderer and sidecar both reject
turns and configuration changes so an in-flight catalog cannot invalidate a
conversation silently.

An individual discovery completion is:

```json
{ "type": "ai_provider_status", "provider": { "...": "ProviderCapability" } }
```

Statuses are `checking`, `ready`, `missing`, `authentication-required`,
`incompatible`, or `failed`. Unavailable providers remain visible. One provider
failure does not disable the other provider or CAD editing.

Configuration is revisioned:

```json
{
  "type": "set_ai_configuration",
  "revision": 7,
  "configuration": {
    "provider": "openai-codex",
    "model": "gpt-5.6-sol",
    "effort": "high"
  }
}
```

The sidecar validates the provider, live model invocation name, and advertised
effort before closing the old conversation and creating the new one. It replies:

```json
{
  "type": "ai_configuration_applied",
  "revision": 7,
  "configuration": {
    "provider": "openai-codex",
    "model": "gpt-5.6-sol",
    "effort": "high"
  },
  "newConversation": true
}
```

or:

```json
{
  "type": "ai_configuration_rejected",
  "revision": 7,
  "message": "OpenAI Codex does not support effort \"max\" for this model."
}
```

The renderer ignores stale acknowledgements and cannot send a prompt until its
latest revision is applied. Provider/model/effort changes are rejected while a
turn is running.

If the authenticated sidecar socket drops during a turn, the renderer ends the
partial response, resets its local turn state, and starts a replacement
conversation after reconnecting. Late messages and CAD-tool results remain
bound to the old socket and are never forwarded into the replacement session.

Starting a new chat also uses a revision, so input stays disabled while the old
provider conversation is closed and a replacement is created:

```json
{ "type": "reset", "revision": 8 }
```

Completion is the same `ai_configuration_applied` message with revision 8 and
`newConversation: true`.

## Turns

The renderer sends the exact applied revision:

```json
{
  "type": "user_message",
  "text": "Move these five metres east.",
  "configurationRevision": 8,
  "selectionSnapshot": {
    "ids": ["3A", "3B"],
    "count": 2,
    "units": "Meters"
  },
  "sheet": {
    "paper": "A3",
    "orientation": "landscape",
    "scaleDenominator": 500,
    "drawingUnit": "m"
  }
}
```

Selection is frozen when the message is sent. `get_selected_entities` substitutes
those IDs in the sidecar; a model cannot change them.

Streaming messages:

```json
{ "type": "status", "state": "thinking" }
{ "type": "assistant_text_delta", "text": "I’ll move the two entities. " }
```

Completion includes the actual provider configuration and monotonic metrics:

```json
{
  "type": "assistant_done",
  "provider": "openai-codex",
  "model": "gpt-5.6-sol",
  "effort": "high",
  "metrics": {
    "providerReadyMs": 810,
    "conversationStartupMs": 310,
    "firstTextMs": 950,
    "firstToolCallMs": 1310,
    "totalMs": 4720,
    "toolCalls": 1,
    "retries": 0,
    "inputTokens": 840,
    "outputTokens": 95
  }
}
{ "type": "status", "state": "idle" }
```

Token counts are omitted when a provider does not report them. Hidden reasoning
is never transported to the renderer.

Interruption is:

```json
{ "type": "interrupt" }
```

## CAD tool forwarding

Both provider adapters are generated from `sidecar/src/cadToolSpecs.ts`. A tool
definition contains one strict Zod object schema, its generated Draft 7 JSON
Schema, description, timeout, and browser bridge handler.

Sidecar to renderer:

```json
{
  "type": "tool_call",
  "callId": "f8eb...",
  "name": "draw_rectangle",
  "input": {
    "corner1": { "x": 0, "y": 0 },
    "corner2": { "x": 20, "y": 10 },
    "layer": "AI_BENCHMARK"
  }
}
```

Renderer to sidecar:

```json
{
  "type": "tool_result",
  "callId": "f8eb...",
  "result": {
    "data": {
      "entityIds": ["42"],
      "corner1": { "x": 0, "y": 0 },
      "corner2": { "x": 20, "y": 10 },
      "layer": "AI_BENCHMARK"
    }
  }
}
```

A failure uses `{ "result": { "error": "..." } }`; `data` and `error` are
mutually exclusive. Invalid arguments are rejected before browser dispatch.
Unknown call IDs and tool names are protocol errors.

Tool calls are serialized in both sidecar and renderer. Each mutating browser
handler opens and commits one database transaction, preserving one-call/one-undo
semantics. A tool failure stops the provider workflow rather than becoming a
successful model observation.

The canonical catalog contains CAD operations only. It has no filesystem,
shell, process, network, web, connector, app, plugin, skill, or subagent tool.

## Provider boundaries

Claude:

- installed Claude Code subscription login only;
- `tools: []`;
- `allowedTools: ["mcp__cad__*"]`;
- `permissionMode: "dontAsk"`;
- no settings sources, skills, plugins, or built-in tools.

Codex:

- installed Codex CLI ChatGPT login only;
- `codex app-server --stdio`, experimental dynamic tools;
- process launch pins the `openai` model provider and official ChatGPT backend;
- zero-turn `account/read` re-attests ChatGPT authentication before model
  discovery and every conversation;
- empty `%LOCALAPPDATA%\EnvCAD\ai-runtime\session-*` working directory;
- read-only sandbox, `never` approvals, no model fallback;
- project instructions/context disabled;
- every configured MCP server explicitly disabled;
- shell, web, apps, connectors, plugins, skills, remote control, and
  multi-agent features disabled.

Codex `thread/started` and `thread/settings/updated` are validated against the
official model provider, expected model, effort, working directory, approval
policy, read-only/no-network sandbox, and explicit-request-only multi-agent
mode. Logout or any alternate authentication update fails closed. Command,
file-change, web, app, connector, MCP, or subagent events interrupt and fail the
turn.

## Preferences

The renderer does not use `localStorage` for AI selection. A narrow preload API
loads/saves strict JSON under Electron `userData`:

- selected provider;
- last selected model per provider;
- last effort per provider/model;
- optional benchmark recommendations;
- schema version.

Writes use a temporary file and atomic replacement. Credentials and secret-like
strings are rejected. Corrupt files recover to the existing-user Claude Code
default without automatically sending a message.
