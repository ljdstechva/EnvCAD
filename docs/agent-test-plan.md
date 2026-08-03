# AI Assistant scripted acceptance dialogues

The sidecar must verify the exact pinned upstream CAD/DXF skill sources at
startup, compile their bounded manifests, and visibly activate `cad-core` and
`dxf-core` before every accepted turn. Full skill sources must not be duplicated
in each provider prompt. Large read
sets must be consumed through all continuation pages before the first edit;
large mutations must be preflighted and automatically completed through
bounded operation batches without asking the user to reselect entities.

These dialogues exercise CAD behavior end to end:
real chat UI → provider-neutral sidecar → selected Claude/Codex adapter →
canonical CAD tool → browser executor → drawing database. Each case names the
tool calls and observable result, so a regression is concrete.

The run log below is the historical Claude Code pass from 2026-07-26. EnvCAD
v0.2.4 applies the same catalog and schemas to both providers; the installed
cross-provider deterministic creation/annotation evidence is recorded in
`docs/ai-benchmark.md`.

## Environment

| | |
|---|---|
| App | `npm run dev` — Vite plus the provider-neutral sidecar; packaged builds use random loopback ports. |
| Auth | Claude uses the installed subscription login; Codex uses the installed ChatGPT login. API-key/token variables are rejected. Live dialogue runs consume the selected provider's usage allowance. |
| Drawing | `test/fixtures/sample-site.dxf` — `$INSUNITS = 6` (Meters); layers `BOUNDARY`, `BUILDINGS`, `ANNOTATION`, `FACILITIES`; 7 entities |
| Fixture geometry | BOUNDARY: closed polyline 100 m × 60 m (area 6 000 m²). BUILDINGS: closed polylines 20 × 15 m at (10,10) and 25 × 12 m at (45,10). ANNOTATION: three MTEXT labels. FACILITIES: circle r = 8 m at (85,45). |
| Sheet defaults | A3 landscape, 1:200, drawing unit m, no title-block template |

Entity ids in this document (`35`, `36`, …) are the handles this fixture
produces on a clean load. They are stable per load, not across edits.

For v0.2.4 visual release acceptance, unit tests intentionally corrupt a valid
PNG's reported SHA-256 and require rejection independently at the renderer-send
and sidecar-receive boundaries. Claude tests also require one streaming query
across multiple turns, `persistSession: false`, and no `resume`. The installed
suite snapshots exact EnvCAD-runtime Claude project keys before and after both
providers run; the final count and new/modified file count must both be zero.
The full installed-ASAR suite is complemented by OS-level automation through
the real Windows shortcut for live Claude and Codex turns, screenshot evidence,
normal close, and runtime/port cleanup.

## How the dialogues are driven

Each dialogue is a fresh start:

1. Reload `sample-site.dxf` through the toolbar's file input, so geometry,
   layers, and undo history are identical every time.
2. Click **New chat** and wait for its revision acknowledgement so the sidecar
   starts a new selected-provider conversation and the turn cannot inherit
   context from the previous dialogue.
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

`get_selected_entities` appears in the public log without private frozen IDs.
The renderer injects those IDs from its turn-local snapshot only at browser
execution time. It also strips the private drawing-revision binding before
showing the call in the UI — see "Selection snapshot semantics" in
`docs/agent-protocol.md`.

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

### Drawing-wide discovery and large selections

- **No-selection scope:** a prompt such as `Inspect the ANNOTATION layer and
  format the ST-01 notes` must use `get_drawing_context`, `list_entities`, and
  Sheet Preview inspection. An empty selection is not a refusal condition
  because the named layer and text provide discoverable scope.
- **Large selection:** selecting 209 or more entities must not create an
  inaccessible provider file. `get_selected_entities` returns bounded pages;
  the agent follows every `nextCursor` until `hasMore` is false without asking
  the user to select smaller batches.
- **Turn safety:** changing the live selection after Send does not change the
  frozen turn selection. Undo, Redo, Open, or another content edit during the
  turn invalidates delayed tool calls, which must fail before execution.
- **Long values:** truncated text previews continue through `get_entity_text`;
  truncated polyline previews continue through `get_polyline_vertices`.
- **Layers and colors:** `get_drawing_context`/`list_layers` report layer
  states and counts. `list_entities` distinguishes explicit true white from
  ByLayer color; `set_entity_color` and `set_layer_properties` are undoable.
- **Overprinting:** `find_text_overlaps` reports connected TEXT/MTEXT collision
  clusters without requiring the user to identify or select each label. A
  209-member cluster is returned as bounded, lossless member segments.

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

These historical dialogue results ran on 2026-07-26 against the live app, against
`@mlightcad/data-model` 1.12.0 / `@mlightcad/cad-simple-viewer` 1.5.8, with the
sidecar on the Claude Code subscription login. They are not presented as a
v0.2.1 Codex benchmark.

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
| D13 rectangle dimensions | `get_selected_entities` → `add_linear_dimension` → `add_linear_dimension` | PASS |
| D14 leader | `add_leader` | PASS |
| D15 radius dimension | `get_selected_entities` → `add_radius_dimension` | PASS |
| S1 undo invariant | — | PASS |
| S2 no invented dimension | — | PASS |

15 / 15 dialogues behaved as documented, with no tool-call deviations, no
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

- **Bulge-dependent measurements.** `src/agent/polyline.ts` gets positions from
  public `getPoint3dAt` and bulges from the public `properties` accessor used by
  the property palette. Bulges are trusted only when the property array has the
  same length as the public point list *and* every entry's x/y matches; on any
  mismatch it falls back to straight vertices. `src/agent/__tests__/polyline.test.ts`
  drives the fallback branches and cross-checks the closed-form arc area
  against the package's own tessellated `AcDbPolyline.area`. No `_geo` access
  exists in the application source.
- **Dependency pinning.** For that reason the `@mlightcad/*` versions in
  `package.json` are pinned exactly, with no `^`. An upgrade is a deliberate
  step: bump the pins, run `npx vitest run src/agent`, and re-run D7 and D12
  from this plan.
- The fixture contains no bulged polyline, so D7 exercises the straight-vertex
  path only; the arc path is covered by unit tests.

## Technical annotation dialogues

These dialogues extend the live acceptance run for the annotation tools. As
with D1-D12, prompts are sent through the visible chat UI and the recorded tool
calls come from the browser bridge.

### D13 — Dimension the selected building rectangle

- **Selection:** the closed building rectangle.
- **Prompt:** `Add dimensions to this. Show its width below the rectangle and its height to the right.`
- **Expected:** `get_selected_entities` first, using the returned polyline
  vertices as the actual definition points, then two separate
  `add_linear_dimension` calls. The width uses `orientation: "horizontal"` and
  a negative outside offset; the height uses `orientation: "vertical"` and a
  positive outside offset. Labels show the exact values to two decimals on
  `DIMENSIONS`.
- **Result: PASS.** `get_selected_entities {"ids":["36"]}` returned the
  rectangle's four public vertices. The agent then called
  `add_linear_dimension` with `(10,10)` → `(30,10)`, offset `-3`,
  `horizontal`, followed by `(30,10)` → `(30,25)`, offset `+3`, `vertical`.
  The returned inserts were `6F` and `77`; the visible labels were `20.00` and
  `15.00`. One Ctrl+Z removed only `77` and left `6F` with `canUndo: true`; a
  second Ctrl+Z removed `6F` and returned `canUndo: false`.

### D14 — Leader with text

- **Selection:** none.
- **Prompt:** `Add a leader pointing to (30, 25) with the text "Sampling point". Put the text at (42, 34).`
- **Expected:** one `add_leader` call with the exact target, text, and text
  position. The returned leader and MTEXT ids are reported, both are on
  `DIMENSIONS`, and one Ctrl+Z removes both.
- **Result: PASS.** One `add_leader` call used target `(30,25)`, text
  `Sampling point`, and text position `(42,34)`, returning leader `81` and
  MTEXT `80`. A single Ctrl+Z removed both ids while leaving the earlier
  dimension inserts in the drawing.

### D15 — Radius dimension on the tank circle

- **Selection:** the tank circle.
- **Prompt:** `Add a radius dimension to this tank circle at 45 degrees.`
- **Expected:** `get_selected_entities` first, followed by one
  `add_radius_dimension` call using the returned circle id and
  `angleDeg: 45`. The displayed label is `R ` plus the database radius to
  exactly two decimals.
- **Result: PASS.** `get_selected_entities {"ids":["3B"]}` returned the tank
  circle at `(85,45)` with radius `8`. `add_radius_dimension
  {"circleEntityId":"3B","angleDeg":45}` returned insert `86` and displayed
  `R 8.00`. A supplementary 135° radius call returned insert `94`; one
  Ctrl+Z removed `94` while the previously reopened insert `86` remained.

### Annotation round-trip and rendering

After D13-D15, Save DXF produced a 9,562-byte file containing three
`ENVCAD_DIM_*` block definitions, filled `SOLID` arrowheads, MTEXT labels
`20.00`, `15.00`, and `R 8.00`, and three model-space `INSERT` entities on
`DIMENSIONS`. Reopening that exact downloaded DXF in EnvCAD restored block
references `6F`, `7F`, and `86` with non-empty extents and visibly rendered
the two rectangle dimensions and the tank radius annotation. (The height
insert is `7F` in the saved file because it was re-added after the granular
undo check.)

The first granular undo attempt exposed two keyboard listeners handling the
same Ctrl+Z: EnvCAD's application listener and the viewer's built-in global
shortcut. `src/App.vue` now leaves undo/redo keyboard ownership to the viewer,
whose command also refreshes the toolbar. D13 was rerun after that fix, and
the one-tool-call/one-undo-step assertions above are from the corrected run.

As an extra tool check, `add_mtext` placed `Inspection note` at `(50,50)` with
height `2` on `DIMENSIONS`, returned entity `90`, and one Ctrl+Z removed it.

## Environmental siting and import dialogues

These four dialogues were run through the visible chat UI on 2026-07-26. The
fixture drawing unit was **Meters**. Browser snapshots recorded every tool
input/result and the final assistant reply; rendered screenshots were inspected
for the clearance annotation and monitoring-well symbols.

### D16 — Import a five-point CSV boundary

- **Selection:** none
- **Prompt:**

  ```text
  Import this 5-point CSV boundary on BOUNDARY and report the computed area and perimeter:
  x,y
  0,0
  100,0
  100,60
  0,60
  0,0
  ```

- **Expected:** one `import_boundary_from_csv` call with the five CSV rows and
  `layer:"BOUNDARY"`. The duplicated closing point is accepted, one closed
  four-vertex polyline is created, and the reply reports code-computed area
  `6000 m²` and perimeter `320 m`.
- **Result: PASS.** `import_boundary_from_csv` returned entity `57`,
  `inputRowCount:5`, `vertexCount:4`, `area:6000`, `perimeter:320`, and
  `units:"Meters"`. The visible reply reported **6000 m²** and **320 m**. The
  Undo button changed from disabled to enabled after this single tool call.

### D17 — Are the selected tanks inside the property boundary?

- **Selection:** fixture building polylines `36` and `37` (intentionally used
  to verify the acceptance fixture; the assistant was expected to disclose
  that these selected entities were BUILDINGS, despite the prompt calling them
  tanks).
- **Prompt:** `Are the selected tanks inside the property boundary? Use the closed BOUNDARY polyline with entity id 35.`
- **Expected:** `get_selected_entities` first, then
  `check_inside_boundary {"entityIds":["36","37"],"boundaryEntityId":"35"}`.
  No visual inference. Both fixture buildings are `inside`.
- **Result: PASS.** The exact two calls ran in order. The predicate returned
  `36:inside`, `37:inside`, and no degradation notes. The reply reported both
  statuses and correctly disclosed that the selected objects were building
  footprints, not tank symbols.

### D18 — Clearance between the generator and nearest building, drawn

- **Setup:** `insert_symbol` placed a scale-1, rotation-0 generator at `(80,16)`
  as entity `5C`; its exact footprint was x=`77..83`, y=`14..18`. The nearest
  fixture building was entity `37`, whose footprint ends at x=`70`.
- **Selection:** generator `5C` and building `37`.
- **Prompt:** `Measure the clearance between the selected generator and its nearest building. Draw the clearance annotation with draw:true.`
- **Expected:** `get_selected_entities`, then
  `measure_clearance {"fromEntityId":"5C","toEntityId":"37","draw":true}`.
  Exact clearance is `77 - 70 = 7 m`; the closest points belong to the correct
  entities. A dashed line and computed label are added on `CLEARANCE` in one
  undo record.
- **Result: PASS.** The tool returned distance `7`, generator closest point
  `(77,14)`, building closest point `(70,14)`, dashed-line id `5F`, label id
  `60`, and label `7.00 Meters`. The rendered line and label were visibly
  present. One Ctrl+Z removed both `5F` and `60` while preserving generator
  `5C` and all nine pre-annotation model-space entities, proving the annotation
  was one undo step.

### D19 — Place MW-1 through MW-3

- **Selection:** none
- **Prompt:** `Place monitoring wells at (20,40), (40,40), and (60,40), using the default MW prefix so they are labelled MW-1 through MW-3.`
- **Expected:** one `place_monitoring_points` call with the three coordinate
  objects and no explicit prefix (therefore the `MW` default). Three circle +
  crosshair + label blocks are created on `MONITORING`.
- **Result: PASS.** One call returned block-reference ids `67`, `6D`, and `73`
  with labels `MW-1`, `MW-2`, and `MW-3`. Visual inspection confirmed all
  three circle/crosshair symbols and all three labels at the requested
  positions, with no clipping or overlap.

### Additional runtime verification

- The toolbar **Import** menu exposed both **CSV boundary** and **GeoJSON**.
  Importing `test/fixtures/boundary-5-point.csv` through the menu produced
  entity `74` and the visible status `area 4000, perimeter 260 Meters`, using
  the same `executeCadTool` path as the agent registry.
- Importing `test/fixtures/environmental-features.geojson` through that menu
  created one point, one line string, and one polygon and visibly stated:
  `CRS reprojection was not performed.`
- A direct browser-registry check classified three imported test points as
  `inside`, `outside`, and `intersecting` against boundary `35`, respectively.
- `check_entity_overlap` on boundary `35` and buildings `36`/`37` returned
  exactly the two containment-overlap pairs and no building/building pair.
- Circle-to-polyline clearance (`3B` → `37`) returned
  `19.459060435491963 m`; the closest point ordering was verified as circle
  point `(80.62985775562463,38.29911522529109)` then building point `(70,22)`.

All four new dialogues passed after the implementation, and the toolbar paths,
predicate edge cases, rendered output, and granular undo behavior were also
verified live.
