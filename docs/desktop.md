# EnvCAD Windows desktop application

## Install and launch

EnvCAD v0.2.1 is packaged for Windows x64 with Electron Forge and Squirrel.

```powershell
npm ci
npm run desktop:make
```

The installer is produced under:

```text
out\make\squirrel.windows\x64\EnvCAD-0.2.1 Setup.exe
```

Install it, then launch EnvCAD from the Desktop shortcut or Start menu. The
application is single-instance. A second launch focuses the existing window.
The renderer is served by an embedded random-port loopback server; Vite and Node
are not required after installation.

The current installer is unsigned. Record `Get-AuthenticodeSignature`, SHA-256,
size, and exact path during release acceptance.

## Provider prerequisites

Claude Code:

- required version: `2.1.220`;
- authenticate interactively with `claude auth login`;
- EnvCAD uses the existing subscription login through the Claude Agent SDK.

OpenAI Codex:

- required version: `0.145.0`;
- authenticate interactively with `codex login`;
- EnvCAD requires `codex login status` to report ChatGPT login;
- dynamic CAD tools use the experimental `codex app-server --stdio` protocol.

Neither provider is required for CAD editing. Missing, signed-out, incompatible,
or failed providers remain visible with provider-specific recovery instructions.

EnvCAD rejects provider API-key/token environment variables. It does not copy,
read, log, or package provider auth files.

## Process architecture

```text
EnvCAD.exe (Electron main)
  ├─ embedded random-port renderer server (127.0.0.1)
  ├─ sandboxed renderer
  └─ AI utility process
       ├─ authenticated random-port WebSocket (127.0.0.1)
       ├─ Claude Agent SDK → installed Claude Code
       └─ Codex JSONL client → codex app-server --stdio
```

Electron main creates a unique empty directory:

```text
%LOCALAPPDATA%\EnvCAD\ai-runtime\session-<pid>-<random>
```

Codex uses it as its working directory. The directory is removed during normal
shutdown. The sidecar, provider subprocesses, WebSocket server, and embedded
renderer server are closed before Electron exits.

Provider discovery is asynchronous and independent. The utility process and
main window start even if both providers are unavailable.

## Security controls

Desktop:

- `nodeIntegration: false`;
- `contextIsolation: true`;
- renderer sandbox enabled;
- packaged DevTools disabled;
- all permission requests denied;
- untrusted navigation and windows blocked;
- external navigation restricted to HTTPS;
- IPC sender origin and `webContents` identity verified;
- preload exposes only runtime status, log-folder open, and strict AI
  preference get/save methods.

Sidecar:

- binds loopback only on an operating-system-selected port;
- requires exact renderer origin, protocol version, and per-launch token;
- limits complete serialized WebSocket messages to 2 MiB and rejects oversized
  requests in the renderer before `send`, preserving the draft and connection;
- strictly validates every message and CAD tool name;
- serializes CAD calls and enforces timeouts;
- redacts provider diagnostics before logs or UI.

Claude:

- no built-in filesystem, shell, search, or web tools;
- only canonical `mcp__cad__*` tools;
- no settings sources, plugins, or skills;
- subscription authentication verified from SDK initialization metadata.

Codex:

- native process spawn with `shell: false`;
- stdio app-server only;
- exact CLI version and ChatGPT authentication required;
- official OpenAI provider and ChatGPT backend pinned at process launch;
- `account/read` re-attested before catalog discovery and each conversation;
- a short-lived, zero-turn `config/read` probe extracts only validated user MCP
  names without exposing transports, then closes;
- a separate production process disables every discovered MCP through CLI
  overrides and thread configuration;
- production `config/read` and bounded `mcpServerStatus/list` attestation require
  each user MCP to be disabled and inert and reject unexpected `codex_apps`;
- read-only/no-network sandbox and `never` approvals;
- project instructions, environment context, web, apps, connectors, shell,
  skills, plugins, hooks, remote control, and subagents disabled;
- runtime settings are treated as an attestation and validated;
- any forbidden command/file/web/app/MCP/subagent event fails closed.

Child environments are allowlisted for Windows runtime discovery and provider
login. API keys and unrelated secret-bearing variables are not forwarded. The
non-secret `ENVCAD_ACCEPTANCE_EVIDENCE_PATH` opt-in is forwarded only so the
release harness can write provider-boundary hashes, lengths, and sentinel
positions to an absolute `.jsonl` path; it never records prompt bodies, and the
path is removed again before launching either provider binary.

## Preferences and logs

AI preferences live under Electron `userData` as `ai-preferences.json`.
They contain only schema version, provider/model/effort identifiers, and optional
benchmark recommendations. Writes are strict, bounded, secret-rejecting, and
atomic. A corrupt file falls back to Claude Code for existing users.

Logs live at:

```text
%APPDATA%\EnvCAD\logs\main.log
```

Use **File → Open Log Folder**. Session tokens, API keys, auth output, and raw
provider stderr are not logged.

## Troubleshooting

| Status | Action |
| --- | --- |
| Claude Code missing | Install Claude Code, then refresh. |
| Claude signed out | Run `claude auth login`, then refresh. |
| Claude incompatible | Install Claude Code `2.1.220`. |
| Codex CLI missing | Install Codex CLI, then refresh. |
| Codex signed out | Run `codex login`, then refresh. |
| Codex incompatible | Install Codex CLI `0.145.0`. |
| Codex configuration probe failed | Repair Codex configuration; EnvCAD disables Codex rather than weakening isolation. |
| Codex isolation attestation failed | Refresh after checking Codex configuration; EnvCAD will not enable Codex while any MCP or app surface remains active. |
| Provider rate limit | Wait until the provider-specific reset time shown in chat. |
| Sidecar offline | CAD remains usable; open the log folder and relaunch. |

An unavailable provider never triggers automatic cross-provider fallback.

## Developer and release commands

```powershell
npm run desktop:dev
npm run desktop:package
npm run test:desktop
npm run desktop:make
```

`test:desktop` packages the application and drives the production ASAR without a
browser or Vite server. It checks launch, CAD open/render/zoom/layers/page setup,
sidecar authentication, invalid-token rejection, single-instance behavior,
provider failure states, secret redaction, and shutdown cleanup.

The explicit live benchmark is:

```powershell
npm run benchmark:ai -- --live
```

See [ai-benchmark.md](ai-benchmark.md) for prompts, scoring, turn budget, and
sanitized results.

## Uninstall and retained files

Uninstall through Windows Settings. Squirrel removes application binaries and
shortcuts. User-created drawings and user-selected exports are not application
installation files and must remain untouched. The v0.1.1 launch-cleanup helper
is retained so stale install roots do not prevent the upgraded application from
launching.
