---
name: add-command
description: Use when adding a new VS Code command to this extension, or wiring a new log source / capture action. Covers the manifest + registration wiring, the command-ID naming convention, the service composition in activate(), and where capture lifecycle state must be registered so processes and watchers get cleaned up.
---

# Adding a command / capture action

Commands follow a fixed pattern. Miss a step and the command either won't appear, won't fire, or will leak processes.

## The wiring checklist

1. **Declare it** in `package.json` → `contributes.commands` with a `command` id and human `title`. Convention: id is `local-log-viewer.<verb>` (e.g. `local-log-viewer.openDashboard`), title is prefixed `Local Logs Console: <Action>`.
2. **Register it** in `src/extension.ts` inside `activate()` with `vscode.commands.registerCommand(...)` pushed into the single `context.subscriptions.push(...)` block. `extension.ts` is a thin composition root — command handlers should call into the services built at the top of `activate()` (`CaptureManager`, `FileTailManager`, `LogPipeline`, `SessionRegistry`, `CommandStore`, `McpServerManager`), not contain capture logic themselves.
3. **Command IDs must match exactly** between manifest and code, or you get "command not found".
4. **Activation:** `activationEvents` is `onStartupFinished`, so the extension is always active once VS Code finishes starting.

### Internal-only commands

A command can be registered in code WITHOUT a `contributes.commands` entry — it then works via `executeCommand` but is hidden from the Command Palette. Use this for internal wiring you don't want users to invoke directly (later phases also hide arg-taking commands via `menus.commandPalette` with `"when": "false"`).

## If the command opens/uses the dashboard

Call `LogDashboard.createOrShow(context.extensionUri, store, bus)` (the `openDashboard` closure in `activate()` already binds the deps) — it's a singleton, so this reveals the existing panel or creates one. **Never write to the dashboard directly**: feed lines through `LogPipeline.ingest(rawLine, { source, sessionId, overrideLevel? })` and the dashboard picks them up from the event bus.

## If the command starts a capture (process or file) — cleanup is mandatory

Every live capture MUST register a `CaptureSession` in the `SessionRegistry` (id, kind, label, `stop()`), which is what `stopAllCaptures`, the status-bar count, and `deactivate()` rely on:

- Spawned child processes → follow `CaptureManager.runAndCapture()`: add to `runningChildren`, remove on `close`, stop via `stopChildProcess(proc, mutedPids)` from `src/core/processTree.ts` (SIGINT→SIGTERM→SIGKILL escalation across the tree, cross-platform). Spawn with `detached: process.platform !== 'win32'` so the process group can be signalled, and build the env with `buildChildEnv()` semantics (respects `localLogViewer.capture.inheritEnvironment`).
- File watchers → follow `FileTailManager.follow()` / `TailSession`: the session's `dispose()` closes the watcher and removes it from the registry.
- `mutedProcessPids` suppresses dashboard output from a process being intentionally killed — `stopChildProcess`/`interruptChildProcess` handle the muting; don't invent new lifecycle handling.

## Optional surfaces

- **Status bar:** an item exists showing the active-capture count (driven by `SessionRegistry.onDidChangeSessions`); it points at `openDashboard`.
- **Settings:** add new keys under the `localLogViewer.*` namespace in `contributes.configuration` and expose a typed accessor in `src/core/config.ts`.
- **Confirmation for risky commands:** `runLastCommand` shows a modal `showWarningMessage` gated by `localLogViewer.confirmRunLastCommand` — mirror that pattern for anything that executes stored shell commands without the user typing them.

## Verify

`npm run compile` (catches manifest/id typos only at runtime, so also) press **F5** to launch the Extension Development Host and confirm the command appears in the Command Palette and fires. If it starts a capture: start it, then run "Stop All Captures" and confirm no orphan processes (`pgrep` the child) and the status-bar count returns to zero.
