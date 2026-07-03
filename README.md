# Local Logs Console

[![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/bobsk8.local-log-viewer?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=bobsk8.local-log-viewer)
[![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/bobsk8.local-log-viewer)](https://marketplace.visualstudio.com/items?itemName=bobsk8.local-log-viewer)
[![CI](https://github.com/bobsk8/local-logs-console/actions/workflows/ci.yml/badge.svg)](https://github.com/bobsk8/local-logs-console/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://github.com/bobsk8/local-logs-console/blob/main/LICENSE)

A fast, keyboard-friendly log dashboard for **local development** — run a command and stream its output, or follow a log file, and investigate with severity facets, full-text search, a volume timeline and structured JSON inspection. Ships an **embedded MCP server** so coding agents (Claude Code, Cursor, Copilot) can read your logs while they debug. **Logs never leave your machine**, and secrets are redacted before they are ever displayed.

![Local Logs Console Demo](https://raw.githubusercontent.com/bobsk8/local-logs-console/main/docs/demo.gif)

## Let your coding agent read the logs (MCP)

The extension runs a **local MCP server** so agents like **Claude Code**, **Cursor** and **VS Code Copilot agent mode** can query your captured logs directly. The debugging loop changes from *"copy the stack trace, paste it into the chat"* to:

> agent edits code → runs the app → **reads its own logs** (`get_errors_since {"since":"2m"}`) → fixes → repeats

Everything the agent sees was **secret-redacted before storage**, the server binds to `127.0.0.1` only, and every request requires a Bearer token.

**Setup** — run `Local Logs Console: Copy MCP Setup for Coding Agents…` from the Command Palette and pick your client:

- **Claude Code**: paste the copied `claude mcp add --transport http local-logs http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"` into a terminal.
- **Cursor**: paste the copied JSON into `.cursor/mcp.json`.
- **VS Code Copilot agent mode** (≥1.101): no setup — the server is auto-discovered via the MCP provider API.

> Tip: set `localLogViewer.mcp.port` in your workspace settings (`.vscode/settings.json`) so the saved config keeps working across restarts — the token is already persistent.

| Tool | What the agent gets |
|---|---|
| `get_log_stats` | counts by level/source, time range, history cap, running captures — orientation call |
| `get_recent_logs` | newest N entries (filter by level/source) |
| `search_logs` | full query grammar: `level:error timeout`, `"phrase"`, `-exclude`, `user.name:alice`, `after:14:30`, `/regex/i` |
| `get_errors_since` | errors newer than `"5m"`, `"2h"`, an `HH:mm` or ISO time |
| `list_captures` | running commands/file tails |
| `wait_for_logs` | long-poll: resolves when a matching log arrives — perfect for run-then-observe loops |

All tools are **read-only** — the MCP server cannot start or stop anything.

**In action** — a coding agent connected to the local MCP server, querying the captured logs while it debugs:

![Claude Code querying the local MCP server for captured logs](https://raw.githubusercontent.com/bobsk8/local-logs-console/main/docs/demo_img.png)

## Why this extension

Before production observability tools are available, local debugging means noisy terminals, mixed processes and log files spread across folders. Local Logs Console gives that output structure — inside VS Code, with zero runtime changes:

- **Any stack** that writes to stdout/stderr or a log file (plain text or JSON, mixed is fine).
- **Local-first and private**: no telemetry, no remote log shipping — the webview cannot make network requests at all (`connect-src 'none'`).
- **Secret redaction on ingest**: AWS keys, bearer tokens, JWTs, GitHub/Slack/Google tokens, password fields and URL credentials are masked with `[REDACTED]` before logs are stored, displayed or exported.
- **Intuitive by design**: onboarding actions right in the empty dashboard and the sidebar — no tutorial needed.

## Features

- **Live dashboard** — virtualized list that stays smooth at the 10,000-entry history cap, live-tail with a "jump to latest · N new" pill, millisecond timestamps, comfortable/compact density.
- **Advanced search** — terms are AND-ed; supports `"quoted phrases"`, `-exclusions`, `field:value` filters and safe `/regex/i` (see syntax below).
- **Severity facets** — one-click Error/Warn/Info/Debug/Trace pills with live counts.
- **Volume timeline** — stacked histogram by severity; click a bar to filter to that time bucket, drag to select a range, clear from the toolbar chip.
- **Detail panel** — flattened attribute table (click a value to add a `field:value` search token), message block, collapsible JSON tree, copy-to-clipboard.
- **Copy raw JSON anywhere** — hover any row (or press `c` on a selected row) to copy the entry's full structured payload, ready to paste into an AI assistant or a bug report.
- **Run & capture** — execute any shell command (e.g. `npm run dev`) in a real integrated terminal while the dashboard captures the stream. Saved commands with an MRU picker and a management UI.
- **Follow files** — tail `.log`/`.txt` files (rotation-aware), from the dashboard, the Command Palette or the explorer right-click menu.
- **Sidebar** — Activity Bar view with running captures (inline stop) and saved commands (run/edit/remove). Closing the dashboard does **not** kill captures; the status bar shows the active count.
- **Export** — NDJSON, JSON or plain text; all logs or just the current filtered view.
- **Safe process teardown** — stopping a capture terminates the whole process tree (SIGINT → SIGTERM → SIGKILL escalation; `taskkill /T /F` on Windows), so dev-server children never leak.
- **Accessible** — full keyboard navigation, screen-reader announcements, `prefers-reduced-motion` support.

## Getting started

1. Open the **Local Logs** icon in the Activity Bar (or press `Ctrl/Cmd+Alt+L`).
2. Pick **Run a Command** (e.g. `npm run dev`) or **Follow a Log File**.
3. Filter, search and click any row for structured details.

## Search syntax

| Query | Meaning |
|---|---|
| `error timeout` | entries containing *error* **and** *timeout* |
| `"connection refused"` | exact phrase |
| `-healthcheck` | exclude entries containing *healthcheck* |
| `level:error` | severity filter (`level:`, `source:`, `message:`, `correlationId:`, `traceId:`) |
| `user.name:alice` | dotted path into the structured payload |
| `after:14:30` · `before:2026-07-02T15:00` | date/time filters (aliases `since:`/`until:`); accepts `HH:mm(:ss)` for today, `YYYY-MM-DD`, or ISO date-times |
| `/timeout \d+ms/i` | regular expression (length-capped and ReDoS-guarded) |

Press `/` to focus the search box; a syntax popover appears on focus.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl/Cmd+Alt+L` | Open the dashboard |
| `Ctrl/Cmd+Alt+Shift+L` | Run the last command |
| `/` or `Ctrl/Cmd+F` | Focus search (Esc clears) |
| `↑` / `↓` | Move row selection |
| `Enter` / `Space` | Open details · `Esc` closes |
| `c` | Copy the selected entry's raw JSON |
| `Home` / `End` | Jump to first / last row |
| `Ctrl/Cmd+End` | Resume live tail |

## Commands

- `Local Logs Console: Open Dashboard`
- `Local Logs Console: Run and Capture Command`
- `Local Logs Console: Follow Log File`
- `Local Logs Console: Run Last Command` (asks for confirmation by default)
- `Local Logs Console: Manage Saved Commands`
- `Local Logs Console: Stop All Captures`
- `Local Logs Console: Export Logs…`

## Settings

| Setting | Default | Description |
|---|---|---|
| `localLogViewer.historyLimit` | `10000` | Max entries kept in history (FIFO) |
| `localLogViewer.tail.seedBytes` | `10240` | Trailing bytes loaded when a file tail starts |
| `localLogViewer.redaction.enabled` | `true` | Mask secrets before logs are stored/displayed |
| `localLogViewer.redaction.useDefaultPatterns` | `true` | Use the built-in secret patterns |
| `localLogViewer.redaction.patterns` | `[]` | Extra regex patterns to redact (case-insensitive) |
| `localLogViewer.confirmRunLastCommand` | `true` | Confirm before re-running the stored command |
| `localLogViewer.capture.inheritEnvironment` | `true` | Off = children get a minimal env (no secrets from env vars) |
| `localLogViewer.mcp.enabled` | `true` | Local MCP server for coding agents (127.0.0.1, token-protected) |
| `localLogViewer.mcp.port` | `0` | 0 = random port per start; pin per workspace for stable agent configs |

## Security

- **No network**: logs are never sent anywhere; the dashboard's Content Security Policy blocks all outbound connections and inline scripts (nonce-based CSP).
- **Redaction at ingest**: secrets are masked before entering history, so the UI, clipboard copies and exports are redacted by construction. Treat it as defense-in-depth, not a guarantee.
- **Workspace Trust**: the extension executes shell commands, so it is disabled in untrusted workspaces (`untrustedWorkspaces.supported: false`).
- **MCP server**: binds to `127.0.0.1` only, requires a Bearer token (stored in your OS keychain), validates the `Origin` header against DNS rebinding, and is strictly read-only — and since redaction happens at ingest, agents only ever see redacted content. Disable with `localLogViewer.mcp.enabled: false`.
- Commands run locally with your privileges — only run commands you trust.

See [SECURITY.md](https://github.com/bobsk8/local-logs-console/blob/main/SECURITY.md) for the threat model and how to report vulnerabilities.

## Compatibility

macOS, Windows and Linux (CI runs on all three). No proposed VS Code APIs, no runtime dependencies, VS Code ≥ 1.75.

## Development

```bash
npm install
npm run compile   # host tsc + webview typecheck + esbuild bundle
npm run watch     # parallel watchers, used by F5
npm run lint
npm test
npm run package   # build the .vsix
```

## Open source project standards

- Contribution guide: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Security policy: [`SECURITY.md`](SECURITY.md)
- Code of conduct: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)
- Release history: [`CHANGELOG.md`](CHANGELOG.md)

Contributions and issues are welcome.
