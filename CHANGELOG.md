# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/) and the project adheres to semantic versioning.

## [1.4.1] - 2026-07-19

### Fixed

- **Regex search with an escaped slash.** A pattern like `/\/error/` (or any `/.../ ` containing `\/`) was cut off at the escaped slash and fell back to a literal match. The clause scanner now skips backslash-escaped characters. Affects both the dashboard search and `search_logs`.

### Changed

- **`get_error_context` accepts a `correlationId`/`traceId` in `errorId`.** Listing tools (`get_errors_since`, `search_logs`) expose correlation ids but not the internal entry id, so passing one into `errorId` used to fail. It now anchors on that request's latest error and returns the whole request; the error message when nothing matches distinguishes an unknown id from a correlation id.
- **Clearer time-filter docs.** Tool descriptions now state that `HH:mm(:ss)` filters use the machine's **local** time while entry timestamps are ISO/UTC — the parser was already correct; this removes the confusion.
- **Marketplace discoverability.** Added the `AI` category and agentic-debugging keywords (`mcp`, `claude code`, `cursor`, `cline`, `copilot`, `agentic debugging`, `nestjs`, `pino`, `winston`) so people searching for an MCP log server for their coding agent can actually find the extension. The description now leads with the embedded MCP server.

## [1.4.0] - 2026-07-18

Agent-first MCP upgrade — the embedded MCP server is now purpose-built for the debugging loop: token-aware and request-correlated, instead of a raw "grep the logs" wrapper.

### Added

- **`get_error_context`** — the fast path for debugging: give it an error (by id, or the most recent via `since`) and get that error **plus its whole request** back, pre-filtered. Lines are grouped by a shared correlation/trace id (scoped to the capture session so reused request ids don't bleed across runs); when there's no id it returns the time-adjacent lines instead.
- **`get_request_trace`** — reconstruct the full ordered story of one request from a `traceId` or `correlationId`.
- **`expand`** — paginate any response that was token-capped, via an opaque `handle`.
- **Zero-instrumentation correlation** — `correlationId`/`traceId` are now auto-detected from the fields Node/Nest loggers actually emit: nested `req.id`, `reqId`, `requestId`, `request_id`, `x-request-id`, and `trace_id`. **nestjs-pino / pino-http** users get request correlation with no code changes. (`spanId` is deliberately not mapped — it would shatter request grouping.)
- **Searchable aliases** — `reqId:` / `requestId:` / `request_id:` resolve to `correlationId`, and `trace_id:` to `traceId`, in both the dashboard search and `search_logs`.

### Changed

- **Every MCP response is now token-budgeted.** Responses have a hard token ceiling; a single giant log line or JSON payload is trimmed automatically, and when there's more to see the tool returns a small slice plus a `handle` to `expand` — no more flooding the agent's context window. Applies to `get_recent_logs`, `search_logs`, `get_errors_since`, and `wait_for_logs` as well as the new tools.
- **Responses are text-only by default.** The server no longer duplicates each payload as `structuredContent`, roughly halving the wire size. Clients that read structured output exclusively can opt back in.

## [1.2.4] - 2026-07-04

### Changed

- **README repositioned around the MCP/agentic-debugging workflow.** Leads with the embedded MCP server and the run → capture → query → fix loop for Claude Code, Cursor, and Copilot agent mode; the dashboard, search, and performance features now support that story instead of leading it.

## [1.2.3] - 2026-07-04

### Fixed

- **MCP endpoint now survives VS Code restarts.** In auto mode (`localLogViewer.mcp.port: 0`) the server used to pick a new random port on every start, silently invalidating any saved agent configuration (Claude Code, `.mcp.json`, Cursor) and causing `ConnectionRefused`. The auto-selected port is now remembered per workspace and reused, so copied configs keep resolving to a live endpoint. If the remembered port is ever taken by another process, the server transparently picks a new one and prompts you to re-copy the setup.
- **Claude Code CLI snippet is now idempotent.** "Copy MCP Setup" emits `claude mcp remove local-logs; claude mcp add …`, so re-running it after a port change no longer fails with "already exists" (works in bash, zsh, and PowerShell).

## [1.2.1] - 2026-07-03

### Changed

- Updated the README demo GIF to show the MCP workflow.

## [1.2.0] - 2026-07-03

### Added

- **Embedded MCP server** — coding agents (Claude Code, Cursor, VS Code Copilot agent mode) can now read your captured logs directly while debugging. Six read-only tools: `get_log_stats`, `get_recent_logs`, `search_logs` (full query grammar), `get_errors_since` (relative times like `"5m"`), `list_captures`, and `wait_for_logs` (long-poll for run-then-observe loops).
- Security posture: `127.0.0.1` only, mandatory Bearer token persisted in the OS keychain (saved agent configs survive restarts), `Origin` validation against DNS rebinding, request body cap, strictly read-only — and everything served was already secret-redacted at ingest.
- `Local Logs Console: Copy MCP Setup for Coding Agents…` command with ready-to-paste formats (Claude Code CLI, `.mcp.json`, `.cursor/mcp.json`, plain endpoint+token).
- Automatic discovery in VS Code ≥1.101 via the MCP server definition provider API (feature-detected; older versions unaffected).
- Settings: `localLogViewer.mcp.enabled` (default on), `localLogViewer.mcp.port` (0 = random; pin per workspace for stable configs). Status bar tooltip shows the endpoint.
- Search values for `since`-style filters now accept relative durations (`30s`, `5m`, `2h`, `1d`).

### Changed

- The pure search engine moved to `src/shared/` so the dashboard and the MCP tools share one query grammar (internal).

## [1.1.0] - 2026-07-02

### Added

- **Copy raw JSON from any row**: a hover "⧉ JSON" button on each list row (and the `c` key on a selected row) copies the entry's full structured payload — handy for pasting into an AI assistant or a bug report.
- **Date/time search filters**: `after:` / `before:` (aliases `since:` / `until:`) in the search box, accepting `HH:mm(:ss)` (today), `YYYY-MM-DD` or ISO date-times — e.g. `after:14:30 before:15:00 level:error`.

### Changed

- Severity filter pills no longer use the theme's blue badge for their counters — counts are now neutral chips that inherit the pill's severity color, so the blue no longer competes with the severity colors. The visible/total counter and the time-range chip were neutralized to match.

## [1.0.0] - 2026-07-02

First stable release — the 0.1–0.3 features hardened for production use.

### Added

- ESLint (flat config, host/webview aware) with a CI lint gate; consolidated plain-Node test runner (`test/run-all.js`).
- CI now also packages the extension on all three OSes and uploads the `.vsix` as a build artifact.
- `SECURITY.md` gained a real reporting channel (GitHub Security Advisories + email) and a documented threat model.
- README rewritten for the Marketplace: badges, feature tour, search-syntax reference, settings and keyboard-shortcut tables, security section.

### Changed

- The demo GIF moved out of the package (`docs/`, referenced by absolute URL) and `resources` is packaged as an explicit icon allow-list — the VSIX shrinks from ~4 MB to well under 1 MB.

## [0.3.0] - 2026-07-02

### Added

- **Activity Bar sidebar** with a Captures view: live capture sessions (inline stop) and saved commands (run / edit / remove inline), plus a first-run welcome view with "Run a Command" and "Follow a Log File" actions.
- **Log export**: `Local Logs Console: Export Logs…` (also in the dashboard `⋯` menu and the sidebar toolbar) writes NDJSON, JSON or plain text; scope can be all logs or the currently filtered dashboard view. Exports are redacted by construction.
- Explorer context menu: right-click a `.log`/`.txt` (or rotated `.log.N`) file → "Follow Log File".
- Keyboard shortcuts: `Ctrl/Cmd+Alt+L` opens the dashboard, `Ctrl/Cmd+Alt+Shift+L` runs the last command.
- `Local Logs Console: Follow Log File` is now a first-class palette command.

### Changed

- **Closing the dashboard no longer stops captures** — they keep running in the background, visible in the sidebar and the status bar count (a one-time notice explains this). Stop them from the sidebar, the `⋯` menu or `Stop All Captures`.

## [0.2.0] - 2026-07-02

### Added

- **Advanced search**: multi-term AND, `"quoted phrases"`, `-negation`, `field:value` filters (`level:`, `source:`, dotted paths like `user.name:`), and safe `/regex/i` with ReDoS protection and inline invalid-pattern feedback. Focus popover documents the syntax.
- **Full keyboard navigation**: `/` or `Ctrl/Cmd+F` focuses search, `↑/↓` navigates rows, `Enter` opens details, `Esc` closes, `Home/End` jumps, `Ctrl/Cmd+End` resumes live tail.
- **Accessibility**: listbox/option roles with active-descendant, pressed-state pills, live region announcing new logs and filter results, labeled histogram bars, reduced-motion support.
- Empty states: onboarding panel with "Run a command" / "Follow a log file" actions, "no results" panel with a clear-filters shortcut, loading skeleton.
- Histogram: drag to select a time range, active-range chip in the toolbar with one-click clear; the selected range now persists across reloads.
- TRACE severity pill; severity pills now show live per-level counts (replacing the separate counters row).
- Density toggle (comfortable/compact rows) in the new `⋯` menu; Clear and Stop moved there.
- Detail panel: copy-to-clipboard for message and JSON, shield badge on entries with redacted values.
- Timestamps in the list now include milliseconds; full date on hover.

### Changed

- Cleaner single-row toolbar (title and counters row removed); themed custom scrollbars; subtle motion (respecting `prefers-reduced-motion`).
- Virtualized list rewritten on a fixed node pool: no per-scroll DOM allocation, and log content now renders exclusively through `textContent` (no HTML-injection surface).
- JSON tree opens with nested objects collapsed (top level expanded); "Expand all" still available.
- Search input is debounced (no full re-filter per keystroke).

## [0.1.0] - 2026-07-02

### Added

- **Secret redaction**: tokens, passwords, API keys, JWTs and URL credentials are masked with `[REDACTED]` before logs are stored or displayed (`localLogViewer.redaction.*` settings, custom patterns supported).
- Settings under the `localLogViewer.*` namespace: history limit, tail seed size, redaction, run-last-command confirmation, minimal child environment.
- `Local Logs Console: Stop All Captures` is now in the Command Palette.
- Status bar item shows the number of active captures.
- Workspace Trust and virtual-workspace declarations (`untrustedWorkspaces.supported: false`).
- Modal confirmation before `Run Last Command` re-executes a stored shell command.
- `Manage Saved Commands` is now a real management UI (run / edit / remove).

### Changed

- Internal architecture: single ingest pipeline (clean → redact → parse → store + event bus); log history now survives closing the dashboard panel.
- Webview migrated from plain JS to TypeScript bundled with esbuild (`media/`), with typed postMessage protocol shared between extension and webview.
- Webview CSP hardened with a script nonce.
- Log level detection unified into one heuristic (terminal colors and dashboard levels can no longer disagree); plaintext DEBUG/TRACE keywords are now detected.

### Fixed

- Process-tree termination fallback on macOS (BSD `ps` does not support `--ppid`).
- Removed the vestigial "Load Initial Logs" button.

## [0.0.13] - 2026-06-11

### Added

- Dashboard-based local log visualization in VS Code.
- Command execution and real-time stdout/stderr capture.
- Log file follow mode.
- Search, level filters, counters, and detail panel.
- Cross-platform process stop support.

### Changed

- Improved terminal readability with structured line rendering.
- Improved stop behavior for Ctrl+C and explicit Stop action.
- Standardized user-facing language to English.
- Hardened webview security and lifecycle handling.

### Fixed

- WARN level detection for warning/aviso content.
- UI row stability when selecting items.
- Residual post-stop log forwarding edge cases.
