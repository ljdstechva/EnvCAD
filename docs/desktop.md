# EnvCAD Windows desktop application

This document covers the installed Electron application. The existing
browser/PWA workflow remains supported and uses the same Vue renderer and CAD
code.

## Install and launch

Requirements:

- 64-bit Windows 10 or Windows 11;
- Claude Code `2.1.220`, installed for the current user;
- an active Claude Code subscription login (`claude auth login`).

Run `EnvCAD Setup.exe`. The Squirrel installer installs per-user under
`%LOCALAPPDATA%\EnvCAD`, creates a Desktop shortcut and a Start menu shortcut,
and starts EnvCAD. It does not require Node.js, npm, a terminal, or
administrator privileges on the target computer.

The current installer is not code-signed. Windows may therefore show an
unknown-publisher or reputation warning. Distribute the installer and its
matching `.nupkg` only through a trusted channel. Code signing is a release
prerequisite before broad distribution.

The application starts the CAD interface and AI bridge together. There is no
separate sidecar command. A second launch activates the existing window and
exits instead of creating a second application session.

## Claude Code and authentication

EnvCAD uses the installed Claude Code executable and the user's existing
subscription authentication. On each launch it:

1. checks `PATH` and the supported current-user installation directories;
2. resolves the executable to a canonical `claude.exe` file;
3. runs `claude --version` without a shell;
4. requires the exact Claude Code version `2.1.220`, matching the Agent SDK;
5. runs `claude auth status --json` without logging the response;
6. passes the verified executable path to the Agent SDK.

EnvCAD never asks for, stores, or supplies an Anthropic API key. If a non-empty
`ANTHROPIC_API_KEY` is present, the AI utility process is not started and the
UI explains how to remove the variable. The variable's value is never logged.

Missing, incompatible, or signed-out Claude Code affects only the AI
Assistant. CAD viewing, editing, saving, and sheet/PDF workflows remain
available.

Sending a chat message uses the Claude Code subscription and its normal usage
limits. Startup, version, authentication-status, connection, and UI tests do
not send a model message.

## Process and network architecture

```text
Windows shortcut
  -> Electron main process
       -> sandboxed BrowserWindow
            -> packaged Vue renderer on 127.0.0.1:<random>
       -> Electron utility process
            -> Claude Agent SDK / installed claude.exe
            -> WebSocket on 127.0.0.1:<random>
```

The main process owns the application lifecycle, menu, log path, internal
renderer server, and utility process. The preload exposes only three narrow
operations: read the desktop runtime configuration, subscribe to AI status,
and open the log folder. It does not expose raw Electron, IPC, filesystem, or
process APIs.

The packaged renderer is served from a loopback-only HTTP server on an
operating-system-assigned port. The AI bridge is a separate Electron utility
process with its own loopback-only, operating-system-assigned WebSocket port.
Both listeners bind to `127.0.0.1`; no fixed production port is required.

The renderer-to-sidecar connection requires:

- the exact renderer origin selected for that launch;
- WebSocket protocol `envcad.v1`;
- a cryptographically random, per-launch token carried as a second WebSocket
  protocol value.

Missing or incorrect origins, protocols, or tokens are rejected before a
bridge session is created. The token is kept in memory, redacted from logs,
and changes on every launch.

## Security controls

The production `BrowserWindow` uses:

- `nodeIntegration: false`;
- `contextIsolation: true`;
- `sandbox: true`;
- `webSecurity: true`;
- DevTools disabled;
- denied permission requests and checks;
- denied popups and untrusted in-window navigation;
- HTTPS-only external-link handoff.

The packaged renderer carries a restrictive Content Security Policy. The
application is stored in ASAR and the packaged executable has Electron fuses
set to disable `RunAsNode`, Node options, CLI inspect arguments, file-protocol
privileges, and alternate V8 snapshots; ASAR integrity, cookie encryption, and
Wasm trap handlers are enabled, and Electron may load the application only
from its ASAR.

The utility process receives a sanitized environment without Anthropic API-key
or token variables. Claude discovery and authentication commands use explicit
argument arrays, bounded output, timeouts, hidden windows, and `shell: false`.
Closing EnvCAD cancels an in-progress discovery/authentication check, asks the
utility process to stop, waits for bounded graceful shutdown, and terminates
only that child if it does not exit in time.

## v0.1.0 dependency risk record

- `jsPDF` is pinned to `4.2.1`. EnvCAD's PDF path uses the supported `jsPDF`
  constructor, `svg2pdf.js`'s `pdf.svg(...)` extension, and `pdf.save(...)`;
  typechecking, browser tests, and installed-app PDF export are release gates.
- `@mlightcad/cad-simple-viewer` `1.5.8` requires `lodash-es` `4.17.21`.
  Inspection of its distributed modules found only the named imports
  `defaults` and `debounce`. EnvCAD does not import the vulnerable `template`,
  `unset`, or `omit` APIs, so the current lodash audit findings are not
  reachable through the application imports.
- The Claude Agent SDK dependency graph includes the vulnerable
  `@hono/node-server` `serveStatic` helper, but that helper is absent from the
  packaged utility-process bundle and is not reachable in the installed
  application.
- Re-evaluate these conclusions whenever the affected dependency versions,
  application imports, or utility-process bundle inputs change.

## Logs and troubleshooting

The redacted application log is:

```text
%APPDATA%\EnvCAD\logs\main.log
```

Open it from **File > Open Log Folder** or the AI Assistant's **Open logs**
button. Session tokens, API-key values, and Claude authentication details are
not logged.

Common states:

| UI message | Action |
| --- | --- |
| Claude Code was not found | Install Claude Code for the current user, then relaunch EnvCAD. |
| Claude Code is incompatible | Install Claude Code `2.1.220`, then relaunch. |
| Claude Code is installed but not signed in | Run `claude auth login`, complete the interactive login yourself, then relaunch. |
| `ANTHROPIC_API_KEY` is set | Remove the variable from the launching environment and relaunch. Do not paste or log its value. |
| AI Assistant process failed/stopped | Open the log folder. CAD remains usable; relaunch EnvCAD after resolving the reported cause. |
| Assistant is offline | Wait for the automatic reconnect or relaunch EnvCAD. The CAD document remains available. |

If the main UI fails to appear, inspect `main.log`, confirm the process is not
already running in another window, and retry the shortcut. Dynamic ports avoid
ordinary fixed-port conflicts.

## Developer commands

Install the locked dependencies:

```powershell
npm ci
```

Run the Electron development application:

```powershell
npm run desktop:dev
```

Package an unpacked 64-bit Windows application:

```powershell
npm run desktop:package
```

Build the Squirrel installer:

```powershell
npm run desktop:make
```

Artifacts:

```text
out\EnvCAD-win32-x64\
out\make\squirrel.windows\x64\EnvCAD Setup.exe
out\make\squirrel.windows\x64\EnvCAD-<version>-full.nupkg
out\make\squirrel.windows\x64\RELEASES
```

Run deterministic desktop acceptance tests:

```powershell
npm run test:desktop
```

The desktop suite packages the production ASAR, drives it with Electron's test
binary, and checks the renderer/preload boundary, sample drawing load and core
shell controls, invalid WebSocket token rejection, missing-Claude behavior,
API-key refusal, second-instance handling, sidecar listener shutdown, and
screenshot capture. It never sends a Claude model message.

Release validation should also run:

```powershell
npm run test
npm run test:e2e
npm run typecheck
npm run build
npm run desktop:make
```

Inspect the final installer's Authenticode status and Electron fuses before
publishing it. This repository does not currently configure a signing
certificate or an automatic-update feed.

## Uninstall and retained files

Uninstall EnvCAD from Windows **Installed apps**, or run the Squirrel
uninstaller while EnvCAD is closed. Uninstall removes application binaries,
shortcuts, and Squirrel's updater stubs after the updater exits. User-created
DXF and PDF files saved outside the install directory are not removed.

Logs and browser-style application data live under `%APPDATA%\EnvCAD`. Remove
that directory separately only when the logs, recent filenames, preferences,
and recovery data are no longer needed.
