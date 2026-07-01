---
name: add-command
description: Use when adding a new VS Code command to this extension, or wiring a new log source / capture action. Covers the manifest + registration + activation wiring, the command-ID naming convention, and where capture lifecycle state must be registered so processes and watchers get cleaned up.
---

# Adding a command / capture action

Commands in this extension follow a fixed pattern. Miss a step and the command either won't appear, won't fire, or will leak processes.

## The wiring checklist

1. **Declare it** in `package.json` → `contributes.commands` with a `command` id and human `title`. Convention: id is `local-log-viewer.<verb>` (e.g. `local-log-viewer.openDashboard`), title is prefixed `Local Logs Console: <Action>`.
2. **Register it** in `src/extension.ts` inside `activate()` with `vscode.commands.registerCommand('local-log-viewer.<verb>', handler)` and push the disposable onto `context.subscriptions` (or `context.subscriptions.push(vscode.commands.registerCommand(...))`).
3. **Command IDs must match exactly** between manifest and code, or you get "command not found".
4. **Activation:** `activationEvents` is `onStartupFinished` and VS Code ≥1.74 auto-detects contributed commands, so no extra activation entry is needed. The extension is effectively always active once VS Code finishes starting.

### Internal-only commands

A command can be registered in code WITHOUT a `contributes.commands` entry — it then works via `executeCommand` but is hidden from the Command Palette. `local-log-viewer.stopAllCaptures` is exactly this (called from the webview Stop button and on panel dispose). Use this pattern for internal wiring you don't want users to invoke directly.

## If the command opens/uses the dashboard

Call `LogDashboard.createOrShow(context.extensionUri)` — it's a singleton, so this reveals the existing panel or creates one. Feed lines to the dashboard with `LogDashboard.currentPanel?.addLogLine(rawLine, overrideLevel?)`.

## If the command starts a capture (process or file) — cleanup is mandatory

The extension tracks live captures so `stopAllCaptures` and `deactivate()` can tear them down. Any new capture MUST register into this bookkeeping or it will leak child processes / file watchers:

- Spawned child processes → add to the `runningChildren: Set<ChildProcess>`, remove on `close`, and stop via `stopChildProcess()` (which escalates SIGINT→SIGTERM→SIGKILL across the process tree, cross-platform). Spawn with `detached: process.platform !== 'win32'` so the whole process group can be signalled.
- File watchers → add to `activeWatchers: Set<fs.FSWatcher>`, remove on error/close.
- `mutedProcessPids` suppresses dashboard output from a process being intentionally killed — mirror the existing `runAndCapture`/`startTailFile` patterns rather than inventing new lifecycle handling.

Follow the shape of `runAndCapture()` (spawn + `vscode.Pseudoterminal`) or `startTailFile()` (`fs.watch` + ranged read) as templates.

## Optional surfaces

- **Status bar:** an item already exists pointing at `openDashboard`. Add more via `vscode.window.createStatusBarItem` and push to `context.subscriptions`.
- **Keybindings / menus / settings:** add `contributes.keybindings`, `contributes.menus`, or `contributes.configuration` in `package.json` — none exist yet, so you'd be establishing the pattern.

## Verify

`npm run compile` (catches manifest/id typos only at runtime, so also) press **F5** to launch the Extension Development Host and confirm the command appears in the Command Palette and fires.
