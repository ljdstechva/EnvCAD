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

EnvCAD v0.2.4 targets Windows 11 x64. Install the generated Squirrel
`EnvCAD-0.2.4 Setup.exe`, then launch **EnvCAD** from the Desktop shortcut or
Start menu. The installer is currently unsigned, so Windows may show a
SmartScreen warning.

Version 0.2.4 lets either supported AI provider inspect the actual Sheet Preview
through a bounded, in-memory image generated from the same final SVG shown in
the UI. It also removes selection as a prerequisite for drawing/layer work and
provides cursor-based continuation and bounded operation batches so the AI can
work through large selections and drawing catalogs instead of receiving one
inaccessible oversized result. **Inspect with AI**
uses the selected provider, model, and effort without switching providers or
granting screen, browser, shell, or filesystem access.

At sidecar startup EnvCAD loads, integrity-checks, and compiles the bundled,
pinned CAD and DXF `SKILL.md` sources from
[`earthtojake/text-to-cad`](https://github.com/earthtojake/text-to-cad) through
EnvCAD's native compatibility layer. Every accepted turn activates the verified
`cad-core` and `dxf-core` manifests before acknowledgment; intent-specific
compiled fragments are added without repeatedly injecting the complete source
corpus. The UI shows every activation and its integrity status. Attribution and
the MIT license are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

Revision-bound sheet, model, region, selection, comparison, and overlay
captures carry dimensions, render settings, evidence IDs, and SHA-256 digests.
The renderer and sidecar independently validate image metadata and content
before a provider can receive it. Claude runs one non-persistent streaming SDK
session per in-app conversation, so preview Base64 is not written to Claude
project transcripts; the upgrade also removes only legacy EnvCAD-runtime
transcript directories created by earlier development builds.
The explicit document lifecycle, deterministic **Fit Drawing**, per-drawing
sheet setup, and unit/clipping safeguards from 0.2.2 remain intact.

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
- Start a clean document with **New Drawing**, then render, pan, zoom, select,
  inspect layers, and use deterministic **Fit Drawing**.
- Draw and transform lines, polylines, rectangles, circles, arcs, text, hatches,
  dimensions, leaders, and environmental symbols.
- Ask the AI to inspect the whole drawing or any layer without selecting
  objects first. Large selections, entity catalogs, layer catalogs, long text,
  and long polylines expose lossless continuation pages that the agent is
  required to consume; large edits use internal operation batches with no
  total entity-count limit.
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
- Both adapters are generated from one neutral 54-capability catalog, including
  bounded local-input retrieval and revision-bound vision.
- An app-owned broker re-authorizes every call against verified active skills,
  schemas, data scope, context capacity, and capability policy.
- Immutable reads may run concurrently. Mutations pass through one durable
  operation coordinator with complete workspace revisions, idempotency keys,
  receipts, postcondition checks, reconciliation, and AI-action undo groups.
- The providers receive no arbitrary renderer IPC.

Codex runs in an empty per-session directory under
`%LOCALAPPDATA%\EnvCAD\ai-runtime`, with a read-only sandbox, `never` approvals,
web/shell/apps/connectors/plugins/skills/subagents disabled, and every
user-configured MCP server explicitly disabled. A short-lived zero-turn
`config/read` probe discovers validated MCP names; a separate production process
then proves those servers are disabled and inert and that no unexpected
`codex_apps` surface exists before account/model access or conversation startup.
EnvCAD validates runtime settings and passive-notification schemas, requires
ChatGPT authentication to remain active, pins the official OpenAI provider and
ChatGPT backend, re-attests the account before discovery and every conversation,
and treats command, file, web, app, connector, MCP, or subagent events as
security failures.

User prompts have no fixed character-count limit. Inline UTF-8 instructions up
to 128 KiB use one protocol-v2 turn envelope; larger text and attachments are
streamed in independently hashed 256 KiB chunks to a 1 GiB-quota local
authoritative store. Providers receive a reference plus bounded outline,
search, chunk, range, and metadata tools. A conservative context budget counts
system instructions, the current prompt, tool results, and image reserves.
Exact selection IDs stay frozen inside the renderer and do not get copied into
the model prompt. Each AI turn and operation is bound to the complete workspace
revision (document identity plus document, content, sheet, and view revisions);
stale commands are rejected before CAD execution.
`ultra` is never advertised as an effort, and a model whose provider default is
`ultra` is omitted because EnvCAD is intentionally single-agent.

Accepted turns are journaled before acknowledgment and emit monotonic,
replayable protocol-v2 events through exactly one terminal outcome. Drafts,
queued follow-ups, partial output, turn cursors, and operation receipts survive
reconnects and renderer reloads. In the packaged Windows app, renderer recovery
state is atomically mirrored under Electron `userData` and encrypted with
Windows protected storage so it also survives the random loopback origin
changing after an application restart. The sidecar and provider supervisors
use bounded restart, backoff, health, and circuit-breaker policies; EnvCAD never
silently switches providers.

Claude is configured with no built-in tools and may invoke only
`mcp__cad__*`. Its settings, skills, and plugins are excluded. Its SDK query is
streaming and non-persistent (`persistSession: false`) and never resumes a
disk-backed transcript.

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

The installed visual acceptance is also opt-in and requires the M-01 drawing:

```powershell
npm run acceptance:visual-installed -- --live --scope=full --drawing "C:\path\to\M-01.dxf"
```

It sends bounded Sheet Preview images to both selected subscription providers
and writes screenshots plus a machine-readable report outside the source tree.
Release acceptance additionally drives both live providers through the actual
installed Windows shortcut with OS-level UI automation, records the installed
process path and screenshots, verifies normal close/runtime cleanup, and merges
that evidence into the report.

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
