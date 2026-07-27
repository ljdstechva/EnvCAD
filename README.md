# EnvCAD

EnvCAD is a Windows desktop CAD viewer and editor for environmental site
drawings — DXF/DWG plans, site boundaries, monitoring points, and the sheet
layouts used to plot them — with an AI drafting assistant built in. The
assistant can inspect the drawing, select and edit entities, add annotations,
and answer questions about the site, all through natural-language chat next
to the canvas.

The installed application packages the Vue 3 + Vite interface in Electron. A
separate utility process hosts the local Claude Agent SDK bridge, allowing the
assistant to call CAD tools (move, measure, annotate, import) against the
drawing open in EnvCAD without exposing Node.js or Electron APIs to the page.
The browser/PWA workflow remains available for development and deployment.

## Install EnvCAD on Windows

EnvCAD currently supports 64-bit Windows. Before installing, install
[Claude Code](https://claude.com/claude-code), update it to version `2.1.220`,
and sign in with your Claude subscription:

```powershell
claude --version
claude auth login
```

Then run **`EnvCAD Setup.exe`** from the release. A locally built installer is
written to:

```text
out\make\squirrel.windows\x64\EnvCAD Setup.exe
```

The Squirrel installer is per-user, requires no administrator access, launches
EnvCAD when installation finishes, and creates Desktop and Start menu
shortcuts. Launching the shortcut starts the UI and AI bridge together; no
terminal, Node.js installation, repository checkout, or separate sidecar
command is required.

EnvCAD uses the existing Claude Code subscription login. It does not accept an
Anthropic API key and disables the AI Assistant if `ANTHROPIC_API_KEY` is set.
If Claude Code is missing, incompatible, or signed out, EnvCAD displays a
specific setup message while CAD opening, editing, saving, and PDF export stay
available.

The current installer is not code-signed, so Windows can show an unknown
publisher or reputation warning. Obtain it only from a trusted EnvCAD release
or build it from this repository. See
[`docs/desktop.md`](docs/desktop.md) for architecture, security, logs,
troubleshooting, packaging, and uninstall details.

## Browser development setup

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Install and log in to [Claude Code](https://claude.com/claude-code) on
   this machine (`claude` on your PATH, authenticated). The sidecar drives
   the Claude Agent SDK through your existing Claude Code session — **there
   are no API keys required or supported by EnvCAD, and none should ever be
   added.**
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
   banner and the chat input is disabled while CAD editing remains available.

Because the assistant runs through Claude Code, every message you send it
draws on your Claude plan's rate limits — the same limits Claude Code itself
uses. There's no separate quota or billing to think about.

## Install with an AI coding agent

You can paste the following instruction into a terminal-capable coding agent
such as Codex CLI or Claude Code:

```text
You are installing EnvCAD from its public GitHub repository.

Repository:
https://github.com/ljdstechva/EnvCAD

Goal:
Safely clone EnvCAD, verify its prerequisites, install its locked dependencies, validate the installation, and start both the Vue application and Claude sidecar.

Use the native shell for this computer. Prefer PowerShell on Windows.

Safety requirements:

- Do not create, request, store, or use an Anthropic API key.
- Do not create an `.env` file containing credentials.
- Do not print existing environment-variable values or other secrets.
- EnvCAD must use an installed and authenticated Claude Code subscription.
- If `ANTHROPIC_API_KEY` is present, do not display its value. Stop and tell me that it must be removed or unset before EnvCAD can start.
- Do not use `--force`, bypass dependency checks, or modify EnvCAD source code merely to make installation pass.
- Do not overwrite an existing EnvCAD directory.
- Inspect repository scripts before executing them.
- Ask before performing an administrator-level or system-wide installation.

Perform these steps:

1. Check whether this is already an EnvCAD checkout.
   - If it is, inspect its Git status and do not clone another copy over it.
   - If it is not, clone:
     https://github.com/ljdstechva/EnvCAD.git

2. Enter the EnvCAD repository directory.

3. Read `README.md`, `package.json`, the lockfile, and the declared `postinstall` script before installing anything.

4. Verify that these prerequisites are available:
   - Git
   - A current supported Node.js LTS release
   - npm
   - Claude Code

5. Show only safe version information. Never display authentication tokens or secret environment-variable values.

6. Verify that Claude Code is logged in through the user's Claude subscription.
   - If interactive authentication is required, pause and guide me through the official Claude Code login.
   - Do not substitute an API key or metered API account.

7. Install the exact locked dependencies using:

   npm ci

   Allow the repository's documented `patch-package` postinstall step to run. If installation fails, diagnose the actual failure instead of deleting the lockfile or forcing an upgrade.

8. Validate the installation using:

   npm run test
   npm run typecheck
   npm run build

9. If validation passes, start EnvCAD using:

   npm run dev

10. Confirm that:
    - The Vite frontend starts.
    - The Claude sidecar starts.
    - A local application URL is printed.
    - No API key is being used.
    - The assistant reports connected or gives a clear login/setup instruction.

11. Give me:
    - The installation directory
    - Node.js and npm versions
    - Test, typecheck, and build results
    - The local EnvCAD URL
    - Any remaining action I must perform

Keep `npm run dev` available for me to use. If your execution environment cannot leave a persistent development server running, tell me to run `npm run dev` manually from the EnvCAD directory.
```

The installing AI agent needs terminal and filesystem access. You must complete
any interactive Claude authentication yourself; installation does not grant the
agent access to your Claude credentials. EnvCAD deliberately refuses API-key
mode. If you prefer, follow the ordinary
[browser development setup](#browser-development-setup) instead.

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

## Reliability and file safety

- **Transactional DXF opening**: EnvCAD parses a DXF into an isolated document
  before it replaces the active drawing. If a malformed or truncated DXF
  cannot be parsed, one friendly error is shown and the currently open drawing,
  including unsaved edits, remains available.
- **Autosave and recovery**: while a drawing is open and dirty, EnvCAD saves a
  browser-local snapshot every two minutes and again when the tab closes. At
  startup, EnvCAD offers to restore an available unsaved drawing.
- **Recent Files privacy**: the Recent Files list stores filenames only, not
  drawing contents or local file paths.
- **DXF saves**: Save DXF downloads the current drawing with a `.dxf` filename,
  including when the source drawing used another supported extension.

## Error handling and sidecar status

DXF parsing, PDF export, agent protocol, and sidecar failures are surfaced with
user-friendly notifications or status messages rather than raw application
errors. The Claude agent runs through the local sidecar and the logged-in
Claude Code subscription described in
[Install EnvCAD on Windows](#install-envcad-on-windows); EnvCAD has no API-key
mode.

If the sidecar is unavailable or disconnects during a session, the AI Assistant
shows an offline banner and disables chat. CAD viewing and editing remain
available, and the assistant reconnects automatically when the sidecar returns.
The installed app also writes a redacted lifecycle log to
`%APPDATA%\EnvCAD\logs\main.log`; use **File > Open Log Folder** to open it.

## Keyboard shortcuts and appearance

| Shortcut | Action |
| --- | --- |
| `Ctrl+O` | Open DXF |
| `Ctrl+S` | Save DXF |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` | Redo |
| `Delete` | Delete the current selection |
| `Escape` | Clear the current selection |
| `F2` | Open Page Setup |

CAD shortcuts are focus-aware: they do not fire while you are typing in chat or
another text field. The toolbar's sun/moon control switches between light and
dark themes, and the selected theme persists between sessions.

## Install as a PWA

EnvCAD can be installed as a standalone, desktop-style Progressive Web App in
supported Chromium browsers:

1. Open EnvCAD in Microsoft Edge or Google Chrome.
2. Use the browser's **Install EnvCAD** option or installation icon.
3. Launch EnvCAD from the installed-app shortcut.
4. EnvCAD opens in a standalone window without ordinary browser tabs or an
   address bar.

Installation requires a supported browser and a secure origin, such as an HTTPS
deployment or `localhost`.

## Testing

Run the automated tests and production checks with:

```powershell
npm run test
npm run test:e2e
npm run test:desktop
npm run typecheck
npm run build
npm run desktop:make
```

- [`TESTING.md`](TESTING.md) — how to run the Vitest unit/integration suite
  and the Playwright end-to-end suite (which runs against a scripted fake
  sidecar, never the real Claude Agent SDK).
- [`docs/agent-test-plan.md`](docs/agent-test-plan.md) — manual live-agent
  dialogues for changes that touch prompts, tool descriptions, or
  conversational behavior; these use the real sidecar and your Claude Code
  session and aren't part of the automated suites.
- [`docs/agent-protocol.md`](docs/agent-protocol.md) — the WebSocket protocol
  between the browser and the sidecar, if you're changing either side.
- [`docs/desktop.md`](docs/desktop.md) — Electron architecture, installer
  commands, security controls, logs, troubleshooting, and release limitations.
