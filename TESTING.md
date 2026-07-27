# EnvCAD testing

EnvCAD has browser/unit suites plus a production-ASAR desktop suite. All are
deterministic and can run without sending a Claude model message.

## Prerequisites

Install the locked npm dependencies, then install Playwright's Chromium binary:

```powershell
npm ci
npx playwright install chromium
```

The browser binary is installed in Playwright's user cache and is not committed
to the repository.

## Unit and headless integration suite

```powershell
npm run test
```

This runs Vitest once and exits. The suite covers:

- sheet layout math for all nine paper sizes, portrait and landscape, meter
  and millimeter drawing units, and scales 1:50, 1:100, 1:200, 1:500, and
  1:1000;
- scale-bar label output for every built-in template, including explicit
  absence checks for templates without a scale bar;
- sheet rendering, fixture integrity, protocol validation, browser bridge
  queuing, and sidecar bridge sessions;
- autosave snapshot round-trips, recent-file bookkeeping, and the
  storage-quota path (a rejected write is reported once, keeps the previous
  snapshot, and warns again after a recovery);
- pure agent and predicate geometry, public polyline/bulge extraction,
  import parsing, and environmental symbol footprints;
- real executor dispatch against a headless `AcDbDatabase`, including CSV and
  GeoJSON imports, containment extraction for points/lines/polylines/circles/
  symbols, overlap, exact clearance and annotation undo, monitoring-point
  undo, and every `calculate_area`/`calculate_length` entity branch.

`@mlightcad/data-model` can create and mutate an in-memory database in Node, so
the integration suite uses the actual database and transaction manager. The
small `setCadToolTestDatabase` seam bypasses only the viewer/WebGL document
manager; it does not replace executor logic.

No numeric coverage package is installed because the only permitted new
package is Playwright. Executor coverage is maintained as an explicit
entity-branch matrix in `src/agent/handlers.integration.test.ts`.

## Browser E2E suite

```powershell
npm run test:e2e
```

Playwright builds EnvCAD in an explicit E2E mode, starts `vite preview`, starts
`test/fakeSidecar.ts`, runs Chromium with one worker, and cleans up both
servers. The E2E-only build exposes `window.__cadTest` for deterministic
selection and geometry inspection; ordinary production builds do not expose
it.

The fake sidecar implements the documented WebSocket protocol but never
imports or starts the Claude Agent SDK. It emits assistant text, calls
`move_entities` using the IDs attached to the real chat message, waits for the
matching browser `tool_result`, and completes the turn. A localhost-only
control endpoint pauses and restarts its WebSocket listener for offline and
reconnect testing.

The five browser checks cover:

1. opening `test/fixtures/sample-site.dxf`, model entity presence, and actual
   non-blank canvas pixel variance;
2. A4 portrait Page Setup and the outer Sheet Preview SVG viewBox
   `0 0 210 297`;
3. non-empty PDF and DXF downloads, with `BOUNDARY` present in the DXF text;
4. the real chat UI, tool chip, exact +5 movement of two attached BUILDINGS
   entities, correlated fake-sidecar result, and exact Ctrl+Z restoration;
5. offline banner/disabled input followed by automatic reconnect when the fake
   sidecar listener starts.

The configuration fails immediately if any `ANTHROPIC_*` environment variable
is present, and each browser test asserts that no request targets an Anthropic
hostname.

## Packaged desktop suite

```powershell
npm run test:desktop
```

Electron Forge first packages the x64 production application and writes the
ASAR to `out\EnvCAD-win32-x64`. Playwright then drives that ASAR with
Electron's test binary; the shipped executable itself keeps its security fuses
and inspector disabled.

The suite checks:

1. production renderer startup, the narrow preload API, sample DXF loading,
   non-blank canvas rendering, and the zoom, layers, and page-setup controls;
2. live installed-Claude discovery/authentication and sidecar connection
   without sending a model message;
3. invalid WebSocket token rejection and second-instance focus behavior;
4. graceful application exit and a closed sidecar loopback listener;
5. fail-closed `ANTHROPIC_API_KEY` behavior without logging a test value;
6. a clean profile with no Claude executable, where the AI-specific setup
   message is shown and CAD remains usable.

The resulting screenshot is written under `output/desktop`.

## Live-agent manual pass

The automated suites deliberately do not send a real Claude model message,
consume an API key, or evaluate model judgment. The packaged desktop suite may
start the installed-Claude sidecar for a non-billable discovery,
authentication-status, and connection check; it sends no query. After changes
to prompts, tool descriptions, authentication, or conversational behavior, run
the applicable live-agent dialogues in
[`docs/agent-test-plan.md`](docs/agent-test-plan.md). Those manual checks cover
OAuth/session behavior, model tool choice, wording, and multi-turn reasoning;
they are not prerequisites for deterministic unit or fake-sidecar E2E runs.
