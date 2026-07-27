# EnvCAD testing

Normal automated suites are deterministic and never send a real Claude or Codex
model request. Live provider calls require the separate `--live` benchmark flag.

## Prerequisites

```powershell
npm ci
```

Browser E2E requires the Playwright Chromium runtime. Desktop tests use the
Electron binary installed in `node_modules`.

## Unit and integration suite

```powershell
npm run test
npm run typecheck
```

Coverage includes:

- CAD geometry, measurements, annotations, import, sheets, autosave, and file
  safety;
- the canonical CAD tool catalog and equivalent Claude/Codex schemas;
- argument validation before browser dispatch, serialization, timeouts, tool
  failure propagation, and one-call/one-undo behavior;
- concurrent independent provider discovery, single-flight refresh, cached/final
  catalog state, and turn/configuration exclusion during refresh;
- Claude model/effort mapping, subscription auth enforcement, API-key
  rejection, rate limits, lifecycle, and authoritative close when interrupt
  acknowledgement is wedged;
- Codex executable/version/auth discovery, paginated live catalog mapping,
  JSONL app-server requests, dynamic tools, runtime-settings attestation,
  passive-event schema/identity checks, ChatGPT auth-change rejection,
  forbidden-event rejection, redaction, timeout, and process shutdown;
- strict protocol catalogs, revisions, metrics, malformed messages, and reset
  acknowledgement;
- atomic/corrupt preference behavior and the Claude existing-user default;
- renderer fallback, persistence projection, no cross-provider fallback,
  turn-time configuration locking, stale acknowledgement handling, and
  socket-generation isolation after an interrupted turn.

Provider tests use deterministic fake adapters. They do not invoke installed
provider executables.

## Browser E2E

```powershell
npm run test:e2e
```

Playwright builds the renderer with `.env.e2e` and starts
`test/fakeSidecar.ts`. The fake sidecar advertises provider-specific Claude and
Codex model catalogs and performs a deterministic CAD move.

The suite verifies:

- real DXF open/render pixels, theme, page setup, DXF/PDF download, and
  undo/redo;
- provider/model/effort dropdown population and model-dependent efforts;
- keyboard selection and 280/420 px chat-panel layout without overflow;
- turn-time control locking, response provider/model/effort/metrics labels, and
  new-conversation boundaries;
- provider missing/auth-required recovery while CAD stays usable;
- strict one-message/one-browser-tool behavior;
- malformed DXF recovery and sidecar reconnect.

No Anthropic or OpenAI endpoint is contacted.

## Packaged desktop suite

```powershell
npm run test:desktop
```

This first packages the production application, then launches the ASAR with
Playwright Electron. It checks:

- a visible production window without Vite;
- sandboxed preload and absence of renderer `require`;
- sample DXF rendering and normal CAD operations;
- authenticated WebSocket round-trip and invalid-token rejection;
- single-instance behavior;
- strict persisted AI preferences;
- CAD availability with blocked key variables;
- Claude/Codex missing and signed-out/incompatible-style failure states through
  isolated environments;
- secret redaction, shutdown, and dynamic-port cleanup.

Desktop screenshots and traces are written only to ignored `output/` and
`test-results/`.

## Build, package, and dependency gates

```powershell
npm run build
npm run desktop:make
npm audit --omit=dev
git diff --check
```

Release acceptance also inspects the complete diff, staged files, installer
signature/hash/size, and the final installed version.

### Dependency-audit findings

As of 2026-07-28, `npm audit --omit=dev` reports one high and two moderate
findings from the same `lodash-es` package already present in the v0.1.1
dependency graph:

- `lodash-es` is pinned transitively by `@mlightcad/cad-simple-viewer`; npm
  offers no fixed version. The viewer imports only `defaults` and `debounce`,
  not the advisory-affected `template`, `unset`, or `omit` APIs.

The lockfile also advances the Claude SDK's compatible peer dependencies from
`@modelcontextprotocol/sdk` 1.29.0 to 1.30.0 and `@hono/node-server` 1.19.15 to
2.0.12. That non-breaking update removes the former Windows `serve-static`
advisory; EnvCAD's reviewed in-process MCP use remains unchanged. The mlightcad
chain has no available audit fix, so its unused-code-path findings remain a
documented upstream risk rather than being hidden by a breaking replacement.

## Live provider benchmark

```powershell
npm run benchmark:ai -- --live
```

Resume an interrupted run only from its checkpoint directory:

```powershell
npm run benchmark:ai -- --live --resume 'D:\path\to\output\desktop\ai-benchmark\<run>'
```

The command refuses to run without `--live`. It resolves the Squirrel stub to
the exact installed, versioned `app.asar` and launches that artifact through the
matching development Electron binary so Playwright can attach despite the
production inspector fuses. It then uses a generated empty metre-unit DXF,
captures the live catalogs, runs one excluded warm-up per provider,
representative smoke checks, and the two deterministic benchmark tasks. The
harness enforces at most 16 additional turns so earlier protocol probes plus
the benchmark remain within the authorized 20-turn ceiling.

`benchmark-progress.json` is replaced atomically before every provider prompt
and after every completed stage. Resume skips completed warm-ups, smoke checks,
Task A stages, full configurations, and retained failed turns. It never retries
a turn merely because later screenshot or file capture failed. Provider/tool
failures are captured as scored evidence so the remaining matrix can continue.
DXF downloads are assigned and checked through Electron's main-session
`will-download` event because Playwright Electron does not reliably expose them
as renderer `download` events.

For each full configuration it captures:

- provider discovery and conversation startup;
- first text/tool and total monotonic timing;
- tool count, retries, and reported safe token counts;
- assistant IDs and canonical tool inputs/results;
- exact model-space geometry and layer true color from saved DXF;
- save/reopen geometry fingerprints and metre units;
- screenshots and provider/model/effort actually used.

Raw evidence stays under ignored `output/desktop/ai-benchmark/`. Only the
sanitized comparative table and recommendations belong in
`docs/ai-benchmark.md`.

The benchmark uses installed Claude Code subscription and Codex ChatGPT logins.
It never uses API keys and never uploads a client drawing.

## Installed release acceptance

After making and installing v0.2.0:

1. launch the Desktop shortcut five consecutive times;
2. inspect provider/model/effort controls at normal and narrow width;
3. confirm preferences and benchmark recommendations after relaunch;
4. verify Task A for both providers from saved/reopened DXF evidence;
5. repeat sample DXF open, selection, pan/zoom, layers, page setup, save/reopen,
   and searchable vector PDF;
6. verify single-instance behavior and provider failure states;
7. close the app and confirm no EnvCAD-owned utility, Claude, Codex app-server,
   updater, port, or runtime directory remains;
8. leave v0.2.0 installed with no related process running.
