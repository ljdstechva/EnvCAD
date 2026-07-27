# EnvCAD

EnvCAD is a browser-based CAD viewer and editor for environmental site
drawings — DXF/DWG plans, site boundaries, monitoring points, and the sheet
layouts used to plot them — with an AI drafting assistant built in. The
assistant can inspect the drawing, select and edit entities, add annotations,
and answer questions about the site, all through natural-language chat next
to the canvas.

The app is a Vue 3 + Vite single-page app. A small local sidecar process
gives the browser access to the Claude Agent SDK over a WebSocket, so the
assistant can call CAD tools (move, measure, annotate, import) against the
drawing open in your browser.

## Setup

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Install and log in to [Claude Code](https://claude.com/claude-code) on
   this machine (`claude` on your PATH, authenticated). The sidecar drives
   the Claude Agent SDK through your existing Claude Code session — **there
   is no API key anywhere in this project, and none should ever be added.**
   The sidecar actively refuses to start if an `ANTHROPIC_API_KEY`
   environment variable is set, specifically to keep it off the metered API
   and on your Claude Code subscription.

3. Start the app:

   ```powershell
   npm run dev
   ```

   This runs the Vite dev server and the sidecar together (via
   `concurrently`) and prints both processes' output to one terminal. Open
   the printed local URL — the AI Assistant tab will be usable once the
   sidecar connects; if the sidecar isn't running, that tab shows an offline
   banner and the chat input is disabled.

Because the assistant runs through Claude Code, every message you send it
draws on your Claude plan's rate limits — the same limits Claude Code itself
uses. There's no separate quota or billing to think about.

## Feature tour

The canonical workflow exercises most of the app:

1. **Open a drawing** — `Ctrl+O` or the toolbar's Open button, and pick a
   `.dxf`/`.dwg` file.
2. **Select entities** — click or drag-select on the canvas.
3. **Ask the assistant to edit them** — e.g. *"Move these 5 metres east"* in
   the AI Assistant chat panel. The assistant sees your selection, calls a
   CAD tool to make the edit, and the canvas updates live; `Ctrl+Z` undoes it
   like any other edit.
4. **Add dimensions and annotations** — ask the assistant to measure and label
   features (e.g. *"Dimension the site frontage"*); it draws linear and radius
   dimensions, leaders, and text on an annotation layer.
5. **Set up a sheet** — `F2` or the Page Setup button to choose paper size,
   orientation, scale, margins, and a title block template.
6. **Export a PDF** — the Sheet Preview tab renders the plotted sheet;
   Export PDF produces the final drawing.

Other things worth knowing:

- **Keyboard shortcuts**: `Ctrl+O` open, `Ctrl+S` save DXF, `Ctrl+Z`/`Ctrl+Y`
  undo/redo, `Delete` deletes the selection, `Escape` clears it, `F2` opens
  Page Setup. None of these fire while you're typing in the chat box or any
  other text field.
- **Autosave**: while a drawing is open and has unsaved changes, EnvCAD
  snapshots it to your browser's local storage every two minutes and again
  when you close the tab. Reopening the app offers to restore it.
- **Theme**: the toolbar's sun/moon button toggles light and dark mode; your
  choice is remembered.
- **Offline handling**: if the sidecar isn't running or crashes mid-session,
  the assistant tab shows an offline banner instead of failing silently, and
  reconnects automatically once the sidecar is back.

## Testing

- [`TESTING.md`](TESTING.md) — how to run the Vitest unit/integration suite
  and the Playwright end-to-end suite (which runs against a scripted fake
  sidecar, never the real Claude Agent SDK).
- [`docs/agent-test-plan.md`](docs/agent-test-plan.md) — manual live-agent
  dialogues for changes that touch prompts, tool descriptions, or
  conversational behavior; these use the real sidecar and your Claude Code
  session and aren't part of the automated suites.
- [`docs/agent-protocol.md`](docs/agent-protocol.md) — the WebSocket protocol
  between the browser and the sidecar, if you're changing either side.
