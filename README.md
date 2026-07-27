# EnvCAD

EnvCAD is a Windows environmental CAD application for opening, editing,
annotating, measuring, and exporting DXF/DWG drawings. Its AI Assistant can use
either Claude Code or OpenAI Codex to perform the same strictly bounded CAD tool
operations.

The desktop application works as a normal CAD editor when one or both AI
providers are unavailable. Provider, model, and effort controls are populated
from the installed runtimes; EnvCAD does not maintain a stale model allowlist in
the renderer.

## Windows installation

EnvCAD v0.2.0 targets Windows 11 x64. Install the generated Squirrel
`EnvCAD-0.2.0 Setup.exe`, then launch **EnvCAD** from the Desktop shortcut or
Start menu. The installer is currently unsigned, so Windows may show a
SmartScreen warning.

The AI Assistant requires whichever local provider you intend to use:

- Claude Code `2.1.220`, authenticated with an existing Claude subscription
  login (`claude auth login`).
- Codex CLI `0.145.0`, authenticated with an existing ChatGPT login
  (`codex login`).

EnvCAD deliberately rejects `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `CODEX_API_KEY`, and
`CODEX_ACCESS_TOKEN`. It neither reads nor packages provider authentication
files.

After launch, open **AI Assistant**, select a provider, choose one of its live
models, and optionally choose an advertised effort. **Default** delegates effort
selection to that provider. A prompt is not sent until the sidecar acknowledges
the exact provider/model/effort configuration. Switching configuration starts a
new conversation; there is no provider-to-provider fallback.

## Core CAD features

- Open ASCII DXF and supported DWG files.
- Render, pan, zoom, select, inspect layers, and use Zoom Extents.
- Draw and transform lines, polylines, rectangles, circles, arcs, text, hatches,
  dimensions, leaders, and environmental symbols.
- Measure area, length, overlap, containment, and clearance using drawing
  database geometry.
- Import CSV boundaries and GeoJSON geometry.
- Configure page size, scale, orientation, and title blocks.
- Save searchable DXF and export vector PDF.
- Autosave, undo/redo, single-instance desktop behavior, and clean
  install/uninstall lifecycle.

## Multi-provider architecture

The packaged renderer runs on a random loopback origin with Electron context
isolation and sandboxing enabled. A token- and origin-authenticated loopback
WebSocket connects it to one Electron utility process.

The utility process contains a provider-neutral coordinator:

- `ClaudeProvider` uses the installed Claude Agent SDK and Claude Code
  subscription login.
- `CodexProvider` uses `codex app-server --stdio` with the existing ChatGPT
  login.
- Both adapters are generated from one canonical 35-tool CAD catalog.
- Browser CAD tool calls are schema-validated, serialized, bounded by timeouts,
  and each mutating call remains one undo step.
- The providers receive no arbitrary renderer IPC.

Codex runs in an empty per-session directory under
`%LOCALAPPDATA%\EnvCAD\ai-runtime`, with a read-only sandbox, `never` approvals,
web/shell/apps/connectors/plugins/skills/subagents disabled, and every
user-configured MCP server explicitly disabled. EnvCAD validates the runtime
settings and passive-notification schemas, requires ChatGPT authentication to
remain active, pins the official OpenAI provider and ChatGPT backend, re-attests
the account before discovery and every conversation, and treats command, file,
web, app, connector, MCP, or subagent events as security failures.
`ultra` is never advertised as an effort, and a model whose provider default is
`ultra` is omitted because EnvCAD is intentionally single-agent.

Claude is configured with no built-in tools and may invoke only
`mcp__cad__*`. Its settings, skills, and plugins are excluded.

See [desktop architecture](docs/desktop.md), [agent protocol](docs/agent-protocol.md),
and [benchmark method](docs/ai-benchmark.md).

## Source development

Prerequisites:

- Windows 11
- Node.js 24 or a compatible current Node.js release
- npm
- Provider runtimes only when exercising live AI

```powershell
git clone https://github.com/ljdstechva/EnvCAD.git
Set-Location EnvCAD
npm ci
npm run dev
```

For the Electron application:

```powershell
npm run desktop:dev
```

The browser development server uses the deterministic fake sidecar for E2E
tests. Normal automated tests never send real provider requests.

## Verification

```powershell
npm run test
npm run typecheck
npm run build
npm run test:e2e
npm run test:desktop
npm run desktop:make
npm audit --omit=dev
git diff --check
```

The explicit live benchmark is opt-in:

```powershell
npm run benchmark:ai -- --live
```

It uses only a generated metre-unit drawing and the two deterministic benchmark
prompts. Raw transcripts, DXFs, screenshots, and machine-specific timings are
written under ignored `output/desktop/ai-benchmark/`. The command refuses to
make a model call without `--live` and enforces its own turn budget.

See [TESTING.md](TESTING.md) for suite boundaries and installed-app checks.

## Keyboard and appearance

- `Ctrl+O` — open a drawing
- `Ctrl+S` — save DXF
- `Ctrl+Z` / `Ctrl+Y` — undo / redo
- `Delete` — erase selected entities
- Middle-button drag — pan
- Mouse wheel — zoom
- Theme toggle — light/dark canvas and UI

## File safety

EnvCAD validates obvious invalid files before opening, keeps unrelated files
untouched, and writes user-selected DXF/PDF outputs only. AI preferences contain
provider/model/effort identifiers and optional benchmark recommendations—never
credentials. Corrupt preferences recover to the existing-user default of Claude
Code.
