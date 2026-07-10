# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`local-log-viewer` (marketplace display name "Local Logs Console", publisher `bobsk8`) is a VS Code extension that captures local application logs — either by running a command and streaming its stdout/stderr, or by tailing an existing log file — and renders them in a filterable webview dashboard. No proposed VS Code APIs are used (Marketplace compatibility) and no logs leave the machine. The extension declares `untrustedWorkspaces.supported: false` (it executes arbitrary shell commands) — keep it that way.

## Commands

```bash
npm install
npm run compile     # clean out/ + media/, tsc (host), webview typecheck, esbuild bundle
npm run watch       # parallel tsc -watch (host) + esbuild --watch (webview), used by F5
npm run lint        # ESLint flat config (eslint.config.mjs) — host and webview blocks
npm test            # compiles + build:test-libs, then test/run-all.js runs every test/test-*.js
npm run package      # builds a .vsix via @vscode/vsce (prepublish = production/minified build)
```

- Run the extension: press **F5** in VS Code ("Launch Extension" in `.vscode/launch.json`), which starts the `watch` task and opens an Extension Development Host.
- There is **no test framework** — tests are plain-Node assertion scripts (`test/test-*.js`) run by `test/run-all.js` against compiled output (`out/` for host and shared modules, `out/test-libs/` for the bundled webview libs), so you must `npm run compile` after any `src/` change before testing. Suites: parser, commandStore, redactor, lineCleaner, processTree, search, exporter, mcp-protocol, mcp-tools, mcp-setup, mcp-server (integration, stubbed vscode). A new `test/test-*.js` file is picked up automatically. `scripts/mcp-smoke.sh <port> <token>` runs live curl checks against an F5 session.
- CI (`.github/workflows/ci.yml`) runs lint + compile + test + `vsce package` on ubuntu/macos/windows — cross-platform behavior matters (see process termination below).
- `docs/demo.gif` is documentation only (referenced by absolute URL in README) — do NOT move it back into `resources/`, and keep `files` as an explicit icon allow-list or the VSIX balloons back to 4 MB.

## Architecture

The extension has two runtime sides that communicate only through VS Code's webview `postMessage` bridge.

**Extension host (TypeScript, compiled to `out/`):**

Every captured line flows through one path: capture source → `LogPipeline.ingest` (clean → redact → parse → tag) → `LogStore` (history) + `LogEventBus` (live fan-out) → subscribers (`LogDashboard`). Capture sources never write to the dashboard directly.

- `src/extension.ts` — thin composition root: instantiates the services below, registers commands, wires the status bar (shows active-capture count) and disposal.
- `src/core/logPipeline.ts` — the single ingest path. Owns the `Redactor` (rebuilt on config change via `refreshConfig()`). `ingest()` for raw lines (file tail); `ingestPrepared()` for already-cleaned/redacted lines (command capture, which needs the redacted text early for terminal echo).
- `src/core/captureManager.ts` — `runAndCapture()` inside a `vscode.Pseudoterminal` (output visible in terminal *and* forwarded to the pipeline). Owns `runningChildren`/`mutedProcessPids` and honors `localLogViewer.capture.inheritEnvironment` (minimal env when off).
- `src/core/fileTail.ts` — `FileTailManager`/`TailSession`: `fs.watch` + ranged `createReadStream` reads only newly-appended bytes; resets offset on truncation/rotation; seed size from `localLogViewer.tail.seedBytes`.
- `src/core/pasteImport.ts` — `importPastedText(pipeline, text, label)`: splits pasted text into lines, feeds each through `LogPipeline.ingest()` (raw path, includes clean/redact/parse). **Deliberately NOT registered in `SessionRegistry`** — pasted snapshots have no `stop()` semantics. Entries are tagged with a synthetic `paste-N` sessionId for grouping/filtering.
- `src/core/processTree.ts` — cross-platform tree termination (see bites). Exports pure `parsePsTable()` for tests.
- `src/core/redactor.ts` — pure `Redactor` class masking secrets (AWS/GitHub/Slack/Google tokens, JWTs, bearer tokens, URL credentials, password-ish key/value pairs) with `[REDACTED]` **before parsing**, so secrets never reach the store, webview, or exports. JSON-pair rules replace only the value between quotes so redacted JSON lines still parse. Settings: `localLogViewer.redaction.*`.
- `src/core/lineCleaner.ts` — pure `cleanLine()` (ANSI/OSC/shell-integration stripping).
- `src/core/sessionRegistry.ts` — `CaptureSession` records for every live capture; feeds the status bar count and stop-all (and the future sidebar).
- `src/core/config.ts` — typed accessors for the `localLogViewer.*` settings.
- `src/store/logStore.ts` — the log history (single source of truth, survives panel dispose). FIFO cap from `localLogViewer.historyLimit`.
- `src/events/logEventBus.ts` — `vscode.EventEmitter<LogEntry>` fan-out for live entries.
- `src/store/commandStore.ts` — saved commands in `workspaceState` (MRU, deduped, cap 20, `replace()` for in-place edit).
- `src/ui/commandPicker.ts` — `pickCommand()` (run flow) and `manageSavedCommands()` (edit/remove QuickPick).
- `src/mcp/` — the embedded MCP server for coding agents. `mcpProtocol.ts` (pure JSON-RPC/MCP dispatcher) and `mcpTools.ts` (six read-only tools over structural deps; reuses the shared search grammar; `wait_for_logs` long-polls the event bus) must **never import vscode at runtime** — only `import type`. `mcpServerManager.ts` owns the `node:http` lifecycle (127.0.0.1, Bearer token persisted in `SecretStorage`, Origin validation, body cap, prompt shutdown). `mcpVsCodeProvider.ts` feature-detects the VS Code ≥1.101 MCP provider API through local structural types (engines stay ^1.75). `mcpSetup.ts` builds the copy-paste snippets.
- `src/shared/search.ts` — the **pure query engine** (parseQuery/matchesQuery/compileSafeRegex/parseDateTimeValue/parseSinceValue), shared by the webview filter and the MCP tools. DOM-free and vscode-free.
- `src/logDashboard.ts` — `LogDashboard` is a **singleton** webview panel and a pure view: subscribes to the bus, serves history from the store, builds the HTML with a strict CSP (nonce'd script tag).
- `src/logParser.ts` — `LogParser.parseLine()` turns a raw string into a `LogEntry`. Tries, in order: an injected `[LVL:LEVEL] ...` marker, then `JSON.parse` (field aliases), then the keyword heuristic. Also exports `detectLevel()` — the **single** level-detection heuristic shared by the parser fallback and the terminal coloring in `captureManager.ts`.
- `src/models/logEntry.ts` — the `LogEntry` / `LogLevel` shared types (incl. `redacted`, `sessionId`).

**Webview (TypeScript, bundled by esbuild into `media/`):**
- `src/webview-src/main.ts` — orchestrator: DOM wiring, persisted-state restore, message handling, filters/search. Feature modules (`virtualList.ts`, `histogram.ts`, `detailPanel.ts`) receive deps/callbacks from main — no cross-imports between them. `lib/format.ts` and `lib/filter.ts` are pure and DOM-free (plain-Node testable); the search grammar itself lives in `src/shared/search.ts`. Communicates back with `stopAll` / `clearLogs` / `pasteLogs` / `loadMore` / `ready` messages. Inline modal wiring for paste input (`pasteLogs` postMessage handler, open/close/import lifecycle).
- `src/webview-src/style.css` — styling, uses VS Code theme CSS variables.
- `src/shared/protocol.ts` — the typed postMessage protocol, imported by BOTH sides.

### Things that will bite you

- **Webview assets are built to `media/` by `esbuild.mjs`** (gitignored — never edit `media/` by hand). Three coupling points must stay in sync: the esbuild entry points/outdir, the `asWebviewUri(... 'media', ...)` calls in `logDashboard.ts`, and `media/**` in `package.json` `files`. esbuild does not type-check — `npm run compile` also runs `tsc -p tsconfig.webview.json` (noEmit). The host tsconfig has **no DOM lib**; only `src/shared/` and `src/models/` are shared between host and webview. Packaging uses only the `files` allow-list — `vsce` refuses to build if a `.vscodeignore` is reintroduced alongside it, so don't add one back.
- **Process termination is cross-platform and deliberate.** Stopping a capture escalates SIGINT → SIGTERM → SIGKILL across the whole process tree: `taskkill /T /F` on Windows, process-group kill (`process.kill(-pid)`, enabled by `detached: true` on spawn) with a ps-table PPID-walk fallback on POSIX (a single `ps -A -o pid=,ppid=` — BSD/macOS `ps` has no `--ppid`). `mutedProcessPids` suppresses dashboard output from a process that is being intentionally killed. Preserve this when touching capture code, or child processes (e.g. `npm run dev`'s subprocesses) will leak.
- **Redaction runs before parsing.** Any new redaction pattern must keep a JSON line valid JSON (replace only the value characters, never quotes/structure), or redacted JSON logs will fall back to plaintext parsing and lose level/timestamp.
- **Closing the dashboard does NOT stop captures** — sessions keep running (sidebar + status bar give control). Don't reintroduce `stopAllCaptures` into `LogDashboard.dispose()`.
- **`src/mcp/mcpProtocol.ts` and `src/mcp/mcpTools.ts` must never import vscode at runtime** (structural interfaces + `import type` only) — the plain-Node test suites `require` their compiled output and fail at load time otherwise. `test/test-mcp-server.js` stubs the vscode module via a `Module._load` hook to boot the real manager; keep the manager's vscode surface small so that stub stays trivial.

## Contributes

- **Commands**: `openDashboard`, `runAndCapture`, `followFile` (accepts an optional `Uri` from the explorer context menu), `manageCommands`, `runLastCommand` (modal confirmation, gated by `localLogViewer.confirmRunLastCommand`), `stopAllCaptures`, `exportLogs`, `pasteLogsFromClipboard` (shown in sidebar + palette, clipboard → auto-open dashboard → import). Hidden/programmatic: `pasteLogs` (webview modal → import with custom label, invoked via postMessage). Sidebar item commands (`stopCapture`, `runSavedCommand`, `editSavedCommand`, `deleteSavedCommand`) take tree items as args and are hidden from the palette via `menus.commandPalette` `"when": "false"`. **UX Note**: Paste is not in the dashboard toolbar (where Export/Clear/Stop live) — it belongs in the sidebar as a "add logs" action and in empty state, separate from log management actions.
- **Sidebar**: Activity Bar container `localLogsConsole` → view `localLogsConsole.captures`, fed by `src/sidebar/capturesTreeProvider.ts` (sections from `SessionRegistry` + `CommandStore`; always includes `DashboardItem` at root if there are any captures or commands, returns `[]` root when both empty so `viewsWelcome` shows onboarding). `CommandStore.onDidChange` uses plain callbacks, NOT `vscode.EventEmitter`, so the store stays requireable from plain-Node tests.
- **Export**: `src/export/serialize.ts` is the pure part (tested by `test/test-exporter.js`); `src/export/logExporter.ts` owns the VS Code flow (filtered scope uses the `requestVisibleIds`/`visibleIds` webview round-trip on `LogDashboard`).
- **Dashboard dispose does NOT stop captures** (since 0.3.0) — they keep running under sidebar/status-bar control; a one-time notice (`globalState`) explains this.
- Keybindings: `ctrl/cmd+alt+l` (dashboard), `ctrl/cmd+alt+shift+l` (run last). Explorer context menu follows `.log`/`.txt`/`.log.N` files.
- **MCP**: `copyMcpSetup` command, `mcpServerDefinitionProviders` contribution (ignored by VS Code <1.101), server enabled by default. `McpServerManager` lives in the composition root like the other services; config changes under `localLogViewer.mcp` trigger `syncWithConfig()`.
- **Settings** live under the `localLogViewer.*` namespace (`historyLimit`, `tail.seedBytes`, `redaction.enabled|useDefaultPatterns|patterns`, `confirmRunLastCommand`, `capture.inheritEnvironment`, `mcp.enabled`, `mcp.port`) — add new settings there and read them via `src/core/config.ts`.
