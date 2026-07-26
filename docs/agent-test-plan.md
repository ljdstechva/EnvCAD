# AI drafting agent — scripted acceptance dialogues

Twelve scripted dialogues that exercise the CAD agent end to end: real chat
UI → `src/agent/bridge.ts` → sidecar → Claude → CAD tool → browser executor →
drawing database. Each one names the tool calls it must produce and the
behaviour it must show, so a regression shows up as a diff against this file
rather than as "the agent felt worse".

Every dialogue below was run against the live application. Results are
recorded in the **Result** column and in [Run log](#run-log).

## Environment

| | |
|---|---|
| App | `npm run dev` — Vite on `http://localhost:5173`, sidecar on `ws://127.0.0.1:8787` |
| Auth | The sidecar's Claude Code OAuth subscription login. The sidecar refuses to start if `ANTHROPIC_API_KEY` is set, and aborts a turn unless the SDK reports `apiKeySource` `oauth`/`none`. Running this plan consumes subscription quota. |
| Drawing | `test/fixtures/sample-site.dxf` — `$INSUNITS = 6` (Meters); layers `BOUNDARY`, `BUILDINGS`, `ANNOTATION`, `FACILITIES`; 7 entities |
| Fixture geometry | BOUNDARY: closed polyline 100 m × 60 m (area 6 000 m²). BUILDINGS: closed polylines 20 × 15 m at (10,10) and 25 × 12 m at (45,10). ANNOTATION: three MTEXT labels. FACILITIES: circle r = 8 m at (85,45). |
| Sheet defaults | A3 landscape, 1:200, drawing unit m, no title-block template |

Entity ids in this document (`35`, `36`, …) are the handles this fixture
produces on a clean load. They are stable per load, not across edits.

## How the dialogues are driven

Each dialogue is a fresh start:

1. Reload `sample-site.dxf` through the toolbar's file input, so geometry,
   layers, and undo history are identical every time.
2. Click **New chat** so the sidecar starts a new Agent SDK session and the
   turn cannot inherit context from the previous dialogue.
3. Set the selection with the dev-only `window.__cadTest` helper
   (`src/agent/testHarness.ts`) — `selectByLayer('BUILDINGS')`, `select(ids)`,
   or `clearSelection()`. This replaces canvas-pixel clicking so the selection
   is deterministic.
4. Type the prompt into the real chat textarea and press Enter. Nothing is
   injected into the bridge directly; the message goes through
   `useChatTimeline` → `captureSelectionSnapshot()` → `sendUserMessage`, exactly
   as a user's would.
5. Wait for the panel status to return to **Idle**, then read the tool calls
   from the `[agent-bridge]` protocol log that `src/agent/bridge.ts` emits in
   dev builds.

`get_selected_entities` always appears in the log with the ids the sidecar
substituted from the frozen snapshot, not with whatever Claude passed — see
"Selection snapshot semantics" in `docs/agent-protocol.md`.

## The dialogues

Legend for expected tool calls: `→` means "then". A call in *(italics)* is
permitted but not required.

### D1 — Move a multi-entity selection

- **Selection:** both BUILDINGS polylines (`36`, `37`)
- **Prompt:** `Move these 5 metres east.`
- **Expected:** `get_selected_entities` → `move_entities` with
  `{entityIds: ["36","37"], dx: 5, dy: 0}`. Exactly one `move_entities` call
  for both entities, not one per entity. Reply names both ids and states the
  offset **with units**.
- **Result: PASS.** `move_entities {"entityIds":["36","37"],"dx":5,"dy":0}`.
  Reply: "Moved entities 36, 37 (both Polyline, layer BUILDINGS) by dx=+5 m,
  dy=0 m (5 metres east)."

### D2 — Copy a selection

- **Selection:** first BUILDINGS polyline (`36`)
- **Prompt:** `Copy the selected building 20 m north.`
- **Expected:** `get_selected_entities` → `copy_entities` with
  `{entityIds: ["36"], dx: 0, dy: 20}`. Entity count goes 7 → 8. Reply gives
  **both** the source id and the new copy id, and says the original is
  unchanged.
- **Result: PASS.** `copy_entities {"entityIds":["36"],"dx":0,"dy":20}`;
  7 → 8 entities. Reply: "Copied building `36` → new entity `55`, offset
  dx=0 m, dy=+20 m (north). The original `36` is unchanged…"

### D3 — Rotate about the default pivot

- **Selection:** first BUILDINGS polyline (`36`)
- **Prompt:** `Rotate this 30 degrees counter-clockwise.`
- **Expected:** `get_selected_entities` → `rotate_entities` with
  `{entityIds: ["36"], angleDeg: 30}`. Because no pivot was given, the handler
  uses the combined bounding-box center — the reply **must disclose** that,
  since it is not the same as rotating about the entity's own base point.
- **Result: PASS.** `rotate_entities {"entityIds":["36"],"angleDeg":30}`.
  Reply: "Rotated entity **36** … by **30° counter-clockwise**, pivoting about
  **(20.0, 17.5) m** — the center of its bounding box, since no pivot was
  specified."

### D4 — Scale a selection

- **Selection:** FACILITIES circle (`3B`)
- **Prompt:** `Scale the selected tank up by a factor of 1.5.`
- **Expected:** `get_selected_entities` → `scale_entities` with
  `{entityIds: ["3B"], factor: 1.5}`, optionally with an explicit `center`.
  Reply states the base point used and the resulting size, with units.
- **Result: PASS.** `scale_entities {"entityIds":["3B"],"factor":1.5,"center":{"x":85,"y":45}}`.
  Reply: "Scaled the tank (circle **3B**…) by a factor of 1.5, pivoting about
  its own center (85, 45) m. Radius went from 8 m to 12 m…"

### D5 — Change layer

- **Selection:** first BUILDINGS polyline (`36`)
- **Prompt:** `Put these on the BOUNDARY layer.`
- **Expected:** `get_selected_entities` → *(`get_drawing_context`)* →
  `set_entity_layer` with `{entityIds: ["36"], layerName: "BOUNDARY"}`. The
  handler creates a missing layer silently, so the agent should confirm the
  layer exists first and must say whether one was created.
- **Result: PASS.** `get_selected_entities` → `get_drawing_context` →
  `set_entity_layer {"entityIds":["36"],"layerName":"BOUNDARY"}`. Reply: "The
  BOUNDARY layer already exists… Moved entity **36** … to the **BOUNDARY**
  layer — that layer already existed, so nothing new was created."

### D6 — Change text

- **Selection:** first ANNOTATION MTEXT (`38`, "ADMIN BUILDING")
- **Prompt:** `Change the selected label to read "MAINTENANCE BUILDING".`
- **Expected:** `get_selected_entities` → `change_text` with
  `{entityId: "38", newText: "MAINTENANCE BUILDING"}`. Reply quotes the old and
  new text and the id.
- **Result: PASS.** `change_text {"entityId":"38","newText":"MAINTENANCE BUILDING"}`.
  Reply: "Changed entity **38** (MText on layer ANNOTATION) from \"ADMIN
  BUILDING\" to **\"MAINTENANCE BUILDING\"**."

### D7 — Area calculation

- **Selection:** BOUNDARY polyline (`35`)
- **Prompt:** `What is the area of the site boundary I have selected?`
- **Expected:** `get_selected_entities` → `calculate_area` with
  `{entityIds: ["35"]}`. The agent must **not** derive 100 × 60 itself from the
  geometry summary. Reply quotes the tool's number with squared units and no
  modification is made (`canUndo` stays false).
- **Result: PASS.** `calculate_area {"entityIds":["35"]}` →
  `{"units":"Meters²","totalArea":6000}`. Reply: "…has an area of **6,000 m²**."
  No database edit; Undo stayed disabled.

### D8 — Sheet setup

- **Selection:** none
- **Prompt:** `Set up an A3 landscape sheet at 1:250 with the site plan title block, project 'ABC Sanitary Landfill'`
- **Expected:** `get_sheet_setup` (to resolve the real template id) →
  `set_sheet_definition` with `paper: "A3"`, `orientation: "landscape"`,
  `scaleDenominator: 250`, `templateId: "builtin-site-plan"`, and
  `fields: {PROJECT: "ABC Sanitary Landfill"}`. All four must land in the Sheet
  Preview tab. Reply notes that page setup is not undoable.
- **Result: PASS.** `get_sheet_setup {}` → `set_sheet_definition
  {"paper":"A3","orientation":"landscape","scaleDenominator":250,
  "templateId":"builtin-site-plan","fields":{"PROJECT":"ABC Sanitary Landfill"}}`.
  Sheet Preview verified after the turn: SVG `viewBox="0 0 420 297"` (A3
  landscape in mm), site-plan title block rendered with north arrow and scale
  bar, `SCALE` cell reads `1:250`, `PROJECT` cell reads `ABC Sanitary Landfill`.
  Reply: "…(page setup only — not undoable with Ctrl+Z)".

### D9 — Create geometry

- **Selection:** none
- **Prompt:** `Draw a closed rectangle on the FACILITIES layer from (10, 40) to (35, 55), in drawing units.`
- **Expected:** *(`get_drawing_context`)* → `draw_rectangle` with
  `{corner1: {x:10,y:40}, corner2: {x:35,y:55}, layer: "FACILITIES"}`. Entity
  count 7 → 8. Reply gives the new id, the corners, and the layer.
- **Result: PASS.** `get_drawing_context {}` → `draw_rectangle
  {"corner1":{"x":10,"y":40},"corner2":{"x":35,"y":55},"layer":"FACILITIES"}`;
  7 → 8 entities. Reply: "Drew a closed rectangle (entity id **48**) on the
  **FACILITIES** layer, from corner (10, 40) m to corner (35, 55) m — a
  25 m × 15 m rectangle."

### D10 — Ambiguous referent, nothing attached

- **Selection:** none
- **Prompt:** `Move it 3 m east.`
- **Expected:** **no modifying tool call.** *(`get_selected_entities`)* is
  allowed; `move_entities` is a failure. The agent must say nothing was
  selected and ask the user to select and resend — it must not pick "the last
  entity", "the only building", or anything else.
- **Result: PASS.** No tool calls; drawing unchanged; Undo stayed disabled.
  Reply: "Nothing is currently selected — I can't tell which entity you mean by
  \"it\". Please select the entity (or entities) you want moved and send your
  request again…"

### D11 — No-selection refusal on a destructive verb

- **Selection:** none
- **Prompt:** `Delete the selected entities.`
- **Expected:** **no `delete_entities` call**, no deletion, and an explicit
  statement that the selection snapshot was empty.
- **Result: PASS.** No tool calls; 7 entities before and after. Reply:
  "Nothing is currently selected — the selection snapshot came back empty.
  Please select the entities you want deleted and send the request again…"

### D12 — Multi-step compound command

- **Selection:** none
- **Prompt:** `Create a layer called SETBACK coloured #ff8800, make it current, then draw a line from (0, 70) to (100, 70) on it and tell me how long it is.`
- **Expected:** four separate, reviewable calls in order — `create_layer` →
  `set_current_layer` → `draw_line` → `calculate_length`. The steps must not be
  collapsed, and the length must come from the tool, not from arithmetic on the
  endpoints.
- **Result: PASS.** `create_layer {"name":"SETBACK","colorCss":"#ff8800"}` →
  `set_current_layer {"name":"SETBACK"}` → `draw_line
  {"start":{"x":0,"y":70},"end":{"x":100,"y":70},"layer":"SETBACK"}` →
  `calculate_length {"entityIds":["49"]}` → `{"units":"Meters","totalLength":100}`.
  Reply enumerates all three changes and reports "**100 m**".

## Supplementary checks

These are not part of the twelve, but they verify invariants the dialogues
depend on.

### S1 — One tool call is exactly one undo step

Driven the same way, then a single global Ctrl+Z (the shortcut added in
`0095f9f`, pressed with focus outside the chat textarea):

| Operation | Tool call | After the edit | After **one** Ctrl+Z |
|---|---|---|---|
| Multi-entity move (`36`, `37`) | one `move_entities` | both moved +5 m in x | **both** back at x = 10 / 45; `canUndo` false |
| Copy | one `copy_entities` | 7 → 8 entities | 8 → 7 entities; `canUndo` false |
| Layer change that also creates the layer | one `set_entity_layer` | 2 entities on new `STRUCTURES` | both back on `BUILDINGS`; `canUndo` false |

`canUndo` returning to `false` after a single undo is the real assertion: it
proves the operation produced exactly one undo record, not one per entity and
not one per internal mutation. **PASS** for all three.

The same run also covers the `0095f9f` fix: the toolbar **Undo** button was
`disabled: true` before the agent's edit and `disabled: false` after it,
confirming `canUndo` now refreshes from the viewer's `undo-stack-changed`
event rather than only after toolbar-initiated undo/redo/open.

Sheet tools are deliberately outside this invariant — they mutate the reactive
sheet store, not the drawing database, so Ctrl+Z does not revert them. The tool
descriptions and system prompt both say so, and D8's reply repeated it.

### S2 — No invented regulatory dimension

- **Selection:** BOUNDARY polyline (`35`)
- **Prompt:** `Add the required regulatory buffer around the site boundary.`
- **Expected:** no drawing tool call; the agent asks for the distance and the
  governing source instead of supplying a "typical" setback.
- **Result: PASS.** Only `get_selected_entities` was called. Reply: "I can't
  add this buffer without knowing the required distance and the regulation that
  sets it. Buffer/setback distances vary by jurisdiction, permit type, and site
  conditions, so I can't assume a 'typical' value…" and asks for the distance
  in metres plus its source.

## Run log

All dialogues run on 2026-07-26 against the live app, against
`@mlightcad/data-model` 1.12.0 / `@mlightcad/cad-simple-viewer` 1.5.8, with the
sidecar on the Claude Code subscription login.

| Dialogue | Expected tool calls | Result |
|---|---|---|
| D1 move | `get_selected_entities` → `move_entities` | PASS |
| D2 copy | `get_selected_entities` → `copy_entities` | PASS |
| D3 rotate | `get_selected_entities` → `rotate_entities` | PASS |
| D4 scale | `get_selected_entities` → `scale_entities` | PASS |
| D5 layer change | `get_selected_entities` → *(`get_drawing_context`)* → `set_entity_layer` | PASS |
| D6 text change | `get_selected_entities` → `change_text` | PASS |
| D7 area | `get_selected_entities` → `calculate_area` | PASS |
| D8 sheet setup | `get_sheet_setup` → `set_sheet_definition` | PASS |
| D9 draw | *(`get_drawing_context`)* → `draw_rectangle` | PASS |
| D10 ambiguous referent | none (refusal) | PASS |
| D11 no selection | none (refusal) | PASS |
| D12 compound | `create_layer` → `set_current_layer` → `draw_line` → `calculate_length` | PASS |
| S1 undo invariant | — | PASS |
| S2 no invented dimension | — | PASS |

12 / 12 dialogues behaved as documented, with no tool-call deviations, no
sidecar or protocol errors, and no unintended database edits.

### Changes made before this run

The tool descriptions and system prompt were changed during the code review
that preceded these runs, specifically to close gaps this plan tests for. No
further adjustment was needed once the dialogues ran.

- `rotate_entities` / `scale_entities` descriptions claimed the pivot defaults
  to "each entity's own origin/base point"; the handler actually uses the
  combined bounding-box center. The descriptions now state the real default and
  tell the model to disclose it — which is what D3 exercises.
- `set_entity_layer` said the destination layer "must already exist"; the
  handler creates it. The description now says so and tells the model to check
  `get_drawing_context` first — which is what D5 exercises.
- `get_sheet_setup` is new. Template ids (`builtin-site-plan`) and title-block
  field keys (`PROJECT`) were not discoverable through any tool, so D8 would
  have depended on guessing them; `set_sheet_definition` now also rejects an
  unknown `templateId` with the list of valid ids.
- `systemPrompt.ts` was rewritten around unit discipline, granular reviewable
  tool calls, never inventing regulatory or missing dimensions, an
  affected-ids-and-values summary after every modification, and refusing
  unresolved referents.

## Regression notes

- **Bulge-dependent measurements.** `src/agent/polyline.ts` recovers per-vertex
  bulges from `AcDbPolyline`'s private `_geo` field, because the public API
  exposes positions only. Positions always come from the public
  `getPoint3dAt`, and bulges are trusted only when the internal array has the
  same length as the public vertex list *and* every entry's x/y matches; on any
  mismatch it falls back to straight vertices, so a representation change
  degrades a curved polyline to its chord polygon rather than producing a wrong
  number. `src/agent/__tests__/polyline.test.ts` drives every fallback branch
  and cross-checks the closed-form arc area against the package's own
  tessellated `AcDbPolyline.area`.
- **Dependency pinning.** For that reason the `@mlightcad/*` versions in
  `package.json` are pinned exactly, with no `^`. An upgrade is a deliberate
  step: bump the pins, run `npx vitest run src/agent`, and re-run D7 and D12
  from this plan.
- The fixture contains no bulged polyline, so D7 exercises the straight-vertex
  path only; the arc path is covered by unit tests.
