# EnvCAD Agent Protocol

This document is the exact wire protocol between the browser (the CAD app,
which owns the drawing database and executes all tools) and the local Node
sidecar (which owns the Claude Agent SDK loop). It is authoritative — later
work should build against this document, not against a guess at the code.

Canonical TypeScript types live in [`src/agent/protocol.ts`](../src/agent/protocol.ts)
and are imported by both sides (the browser bundle via Vite, the sidecar via
`tsx`, using a relative import). This document explains the semantics; the
`.ts` file is the source of truth for shapes.

## Transport

- A single `ws://127.0.0.1:8787` WebSocket server, hosted by the sidecar
  (`sidecar/src/index.ts`).
- The server accepts browser connections only from local HTTP(S) origins
  (`localhost`, `127.0.0.1`, or `::1`). Other origins and clients without an
  Origin header are rejected before a session is created.
- The browser is the client. It connects on startup and reconnects with
  exponential backoff if the connection drops (e.g. the sidecar process was
  killed and later restarted).
- Every message is a single JSON object with a `type` field used as a
  discriminant. There is no batching or partial-frame handling — one WS
  message is one complete JSON object.
- Both peers validate decoded messages before processing them. Malformed JSON,
  unsupported message types, invalid fields, mismatched selection counts, and
  unknown CAD tool names are rejected with a visible protocol error.
- The sidecar holds one `BridgeSession` per WebSocket connection. Each
  session owns its own Claude Agent SDK session id, so two browser tabs
  connecting at once get independent agent conversations. Only one browser
  tab is expected to be open during this phase of the project.

## Client → Server messages

Sent by the browser (`src/agent/bridge.ts`).

### `user_message`

Sent when the user submits a new message to the agent.

```ts
{
  type: 'user_message'
  text: string
  selectionSnapshot: {
    /** Entity object ids selected in the viewer at SEND time. */
    ids: string[]
    count: number
    /** Human-readable drawing unit name, e.g. "Millimeters". */
    units: string
  }
  sheet: {
    paper: string
    orientation: 'portrait' | 'landscape'
    scaleDenominator: number
    drawingUnit: string
    templateId?: string
    fields?: Record<string, string>
  }
}
```

`selectionSnapshot` is captured from `view.selectionSet.ids` at the moment the
browser sends the message — **not** whatever happens to be selected later,
while the agent is still working. See [Selection snapshot semantics](#selection-snapshot-semantics)
below for how the sidecar uses it. `sheet` is the current
`sheetStore.current` value, given so the agent has drafting context (paper
size, scale, active title-block template) without a tool round trip.

### `tool_result`

Sent in reply to a `tool_call` from the server, once the browser has run the
corresponding handler.

```ts
{
  type: 'tool_result'
  callId: string   // echoes the tool_call's callId
  result: {
    data?: unknown   // present on success
    error?: string   // present on failure; data is omitted
  }
}
```

`result` is intentionally *not* shaped like an MCP `CallToolResult` — the
browser only ever thinks in plain `{ data }` / `{ error }` terms. The sidecar
translates this into the MCP content-block shape the Agent SDK expects (see
[Tool forwarding](#tool-forwarding)).

### `interrupt`

```ts
{ type: 'interrupt' }
```

Stops the agent mid-turn. The sidecar calls the Agent SDK's
`Query.interrupt()` on whichever `query()` call is currently running for this
connection. No-op if the agent is idle.

### `reset`

```ts
{ type: 'reset' }
```

Ends the current Agent SDK session. The next `user_message` on this
connection starts a brand new session (no `resume`), so the agent has no
memory of anything before the reset.

## Server → Client messages

Sent by the sidecar (`sidecar/src/bridgeSession.ts`).

### `assistant_text_delta`

```ts
{ type: 'assistant_text_delta'; text: string }
```

A chunk of assistant-authored text. One is emitted per `text` content block
found in each `assistant` message the Agent SDK yields for the turn. This is
chunk-level (per content block), not per-token — the SDK's `query()` helper
does not expose token-level streaming the way `messages.stream()` does on the
raw Claude API. A single turn may emit several deltas if Claude interleaves
text and tool calls.

### `assistant_done`

```ts
{ type: 'assistant_done' }
```

Sent once after the agent loop finishes the turn (the `result` message from
the SDK has been consumed). Marks the end of the streamed response for this
`user_message`.

### `tool_call`

```ts
{ type: 'tool_call'; callId: string; name: string; input: unknown }
```

Sent from inside a CAD tool's handler (registered on the in-process MCP
server — see [`sidecar/src/cadTools.ts`](../sidecar/src/cadTools.ts)) the
moment Claude invokes that tool. `name` is the bare tool name (e.g.
`draw_line`), not the MCP-qualified `mcp__cad__draw_line`. `callId` is
generated by the sidecar per call and must be echoed back unchanged in the
matching `tool_result`.

The sidecar waits up to **30 seconds** for the matching `tool_result`. If it
times out, the pending call is resolved with
`{ error: "Timed out waiting for the browser to respond to <name> after 30s" }`
and the agent loop continues as if the browser had reported that error.

### `status`

```ts
{ type: 'status'; state: 'thinking' | 'idle' }
```

`thinking` is sent the moment a `user_message` starts a turn; `idle` is sent
once the turn fully completes (after `assistant_done`) or the turn errors.
This is a coarse "is the agent doing anything right now" signal, distinct
from the browser's own WebSocket `connectionState` (see
[`src/agent/bridge.ts`](../src/agent/bridge.ts)), which reflects whether the
sidecar process is reachable at all.

### `error`

```ts
{ type: 'error'; message: string }
```

Sent when the Agent SDK's `query()` loop throws (e.g. the underlying Claude
Code process failed, or the session could not be resumed). Always followed
by a `status: 'idle'` message.

The same message shape is also used for visible transport and protocol
failures, such as a second `user_message` received while a turn is already
running or a `tool_result` with an unknown `callId`.

## Selection snapshot semantics

The browser captures `view.selectionSet.ids` at the moment it sends a
`user_message`, attaching them as `selectionSnapshot`. The sidecar keeps the
most recent `user_message`'s `selectionSnapshot` on the `BridgeSession` and:

1. Appends a short context note to the prompt text passed to `query()`, e.g.
   `Selection attached: 3 entities, ids [h1a, h1b, h1c]` or
   `Selection attached: none` when `count` is 0.
2. When the `get_selected_entities` tool is invoked (regardless of what
   arguments Claude passes to it), the sidecar substitutes the ids from that
   turn's snapshot before forwarding the call to the browser as a
   `tool_call`. This is deliberate: it guarantees the browser always answers
   from the snapshot attached to the message that triggered the turn, not
   whatever the live selection happens to be by the time the tool call
   actually runs.

The system prompt (`sidecar/src/systemPrompt.ts`) instructs Claude to always
call `get_selected_entities` before acting on "this/these/selected", and to
ask the user rather than guess when no selection is attached.

## Tool forwarding

Every CAD tool registered on the sidecar's in-process MCP server
(`createSdkMcpServer` + `tool()`, see `sidecar/src/cadTools.ts`) shares one
forwarding path:

1. The tool handler calls `BridgeSession.callTool(name, input)`.
2. That generates a `callId`, sends `{ type: 'tool_call', callId, name, input }`
   to the browser, and returns a promise that resolves when the matching
   `tool_result` arrives (or after the 30s timeout).
3. The resolved `{ data?, error? }` is converted to the MCP `CallToolResult`
   shape the Agent SDK expects:
   - `{ error }` → `{ content: [{ type: 'text', text: error }], isError: true }`
   - `{ data }` → `{ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }`

The full list of registered tool names is `CAD_TOOL_NAMES` in
`src/agent/protocol.ts`: `get_selected_entities`, `get_drawing_context`,
`move_entities`, `copy_entities`, `rotate_entities`, `scale_entities`,
`delete_entities`, `set_entity_layer`, `change_text`, `calculate_area`,
`calculate_length`, `draw_line`, `draw_polyline`, `draw_rectangle`,
`draw_circle`, `draw_arc`, `draw_text`, `draw_hatch`, `create_layer`,
`set_current_layer`, `zoom_extents`, `set_sheet_definition`,
`set_title_block_fields`.

The browser (`src/agent/handlers.ts`) implements every registered tool.
Database modifications use the viewer's transaction mechanism so one tool
operation is one undoable step; sheet tools update the reactive sheet store.
Pure rotation, bounding-box, area, and length math lives in
`src/agent/geometry.ts`.

## Session and credentials

The sidecar calls the Agent SDK's `query()` with `permissionMode: 'dontAsk'`
and `tools: []` (which removes every built-in tool — Bash, Read, Write, Edit,
Glob, Grep, WebSearch, WebFetch — from Claude's context entirely), plus
`allowedTools: ['mcp__cad__*']` so the CAD tools run without any interactive
permission prompt. `model` is pinned to `'sonnet'`.

One `BridgeSession` keeps a single Agent SDK session id across turns
(captured from the `system`/`init` message's `session_id` field) and passes
it as `resume` on every subsequent `query()` call, so the conversation has
memory. A `reset` client message clears the stored session id, so the next
turn starts a fresh Agent SDK session.

**No API key is ever set, logged, or used.** Startup fails closed when a
non-empty `ANTHROPIC_API_KEY` is present, without reading or printing its
value. For every query, the sidecar also verifies that the Agent SDK
`system/init` message reports either `apiKeySource: 'oauth'` or the runtime
`'none'` value used by Claude Code 2.1.220 when no API-key source exists.
Actual key sources (`user`, `project`, `org`, or `temporary`) end the turn
before CAD tools are accepted. The SDK's bundled Claude Code binary therefore
uses the existing Claude Code OAuth subscription login on this machine.

## Development acceptance hook

In development builds, `src/agent/testHarness.ts` installs:

```ts
window.__agentTest(text: string): Promise<{
  assistantText: string
  toolCalls: Array<{
    callId: string
    name: string
    input: unknown
    result?: { data?: unknown; error?: string }
  }>
}>
```

It captures the selection and sheet snapshots, sends one real bridge message,
correlates each browser executor result with its `tool_call`, and resolves only
after `assistant_done`. It rejects on sidecar, protocol, authentication, or
timeout errors. This hook is intentionally nonvisual; P5c will add the
user-facing chat interface later.
