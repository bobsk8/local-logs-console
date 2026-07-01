# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`local-log-viewer` (marketplace display name "Local Logs Console", publisher `bobsk8`) is a VS Code extension that captures local application logs — either by running a command and streaming its stdout/stderr, or by tailing an existing log file — and renders them in a filterable webview dashboard. No proposed VS Code APIs are used (Marketplace compatibility) and no logs leave the machine.

## Commands

```bash
npm install
npm run compile     # clean out/ then tsc -p ./  (required before running tests)
npm run watch       # tsc -watch, used by the F5 "Launch Extension" debug config
npm test            # compiles, then runs test/test-parser.js against out/logParser.js
npm run package      # builds a .vsix via @vscode/vsce
```

- Run the extension: press **F5** in VS Code ("Launch Extension" in `.vscode/launch.json`), which starts the `watch` task and opens an Extension Development Host.
- There is **no linter** and **no test framework** — `npm test` is a single plain-Node assertion script. To run one case, edit `test/test-parser.js` directly. Because tests `require('../out/logParser.js')`, you must `npm run compile` after any change to `src/logParser.ts` before testing.
- CI (`.github/workflows/ci.yml`) runs compile + test on ubuntu/macos/windows — cross-platform behavior matters (see process termination below).

## Architecture

The extension has two runtime sides that communicate only through VS Code's webview `postMessage` bridge:

**Extension host (TypeScript, compiled to `out/`):**
- `src/extension.ts` — the entire activation lifecycle lives here as nested closures inside `activate()`. Registers commands, spawns/captures processes, tails files, and owns all cleanup (`runningChildren`, `activeWatchers`, `mutedProcessPids` sets). `runAndCapture()` spawns the command inside a `vscode.Pseudoterminal` so output is visible in an integrated terminal *and* forwarded to the dashboard. `startTailFile()` uses `fs.watch` + ranged `createReadStream` to stream only newly-appended bytes.
- `src/logDashboard.ts` — `LogDashboard` is a **singleton** webview panel (`LogDashboard.currentPanel`). It owns the in-memory log history (`_allLogs`, capped at `MAX_HISTORY_RECORDS = 10000`, FIFO), builds the webview HTML with a strict CSP, and pushes each parsed entry to the webview via `postMessage`.
- `src/logParser.ts` — `LogParser.parseLine()` turns a raw string into a `LogEntry`. Tries, in order: an injected `[LVL:LEVEL] ...` marker, then `JSON.parse` (pulling `level`/`timestamp`/`message`/`correlationId`/`traceId` from common field aliases), then a plaintext keyword heuristic. Returns `null` for blank lines. Uses `crypto.randomUUID` with a `Math.random` fallback for portability.
- `src/models/logEntry.ts` — the `LogEntry` / `LogLevel` shared types.

**Webview (plain JS/CSS, NOT compiled — shipped as source):**
- `src/webview/script.js` — client-side dashboard: **virtualized log list** (only rows in the viewport are in the DOM; `ROW_HEIGHT`/`BUFFER` drive the windowing), severity filters, text search, and the JSON detail panel. Communicates back with `stopAll` / `clearLogs` / `loadMore` / `ready` messages.
- `src/webview/style.css` — styling, uses VS Code theme CSS variables.

### Things that will bite you

- **Webview assets are loaded from `src/webview/` at runtime**, not from `out/`. `tsc` only compiles `.ts`, so `logDashboard.ts` references `src/webview/style.css` and `src/webview/script.js` directly via `asWebviewUri`. This is why `.vscodeignore` excludes `**/src/**` but re-includes `!src/webview/**`, and why `package.json`'s `files` array ships `src/webview/**`. Do not move these files into `out/` or rename the folder without updating all three.
- **Log-level detection is duplicated.** `extension.ts` has its own `detectLevel()` used for terminal coloring/forwarding, and `logParser.ts` has independent JSON+heuristic logic. Changing level rules usually means editing both.
- **Process termination is cross-platform and deliberate.** Stopping a capture escalates SIGINT → SIGTERM → SIGKILL across the whole process tree: `taskkill /T /F` on Windows, process-group kill (`process.kill(-pid)`, enabled by `detached: true` on spawn) with a recursive PPID-walk fallback on POSIX. `mutedProcessPids` suppresses dashboard output from a process that is being intentionally killed. Preserve this when touching capture code, or child processes (e.g. `npm run dev`'s subprocesses) will leak.
- **`src/store/logStore.ts` and `src/events/logEventBus.ts` are currently dead code** — defined but not referenced anywhere. History is held directly in `LogDashboard._allLogs`. Don't assume they are the source of truth.

## Contributes

Two user-facing commands (`package.json`): `local-log-viewer.openDashboard` and `local-log-viewer.runAndCapture`. A third command, `local-log-viewer.stopAllCaptures`, is registered in code and invoked internally (from the webview Stop button and on panel dispose) but is **not** declared in `contributes.commands`, so it is not in the Command Palette.
