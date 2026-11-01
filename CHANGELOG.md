# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/) and the project adheres to semantic versioning.

## [2.0.0] - 2026-11-01

The daily-driver release: a quieter, keyboard-first dashboard, and the tools that close the loop between a log line and your code.

### Added

- **Clickable stack traces.** Frames in the detail panel (Node, Python, Java/Kotlin, .NET, Go — including `file://` and webpack paths, and container paths like `/app/src/…` mapped onto the workspace) open the file at the exact line and column. Your own frames are highlighted, dependency frames dimmed. Only files inside the workspace (or the capture's folder) open directly; anything else asks first.
- **Problems panel.** A runtime error whose stack points into your workspace becomes a diagnostic on the line that threw (deduplicated, capped). Cleared by the dashboard's Clear and when the capture runs again. `localLogViewer.problems.enabled`.
- **Debug Console capture.** Press F5 as usual — the program's stdout/stderr from the debugger becomes a capture in the dashboard, no command needed (stable `DebugAdapterTracker` API, any debugger). Stop/restart work from the dashboard and sidebar. `localLogViewer.capture.debugSessions`.
- **Project scripts in the run picker.** Every `package.json` script of every workspace folder is listed, run with the folder's package manager (npm, pnpm, yarn or bun, from the lockfile) in that folder.
- **Restart the last capture** from anywhere: `Ctrl/Cmd+Alt+R` (`Local Logs Console: Restart Last Capture`). A running capture is stopped first. Sidebar restart now works on running captures too.
- **Capture chips** above the list: status dot, exit code, restart/stop, and one click to show only that capture (a restarted capture keeps the filter).
- **Search autocomplete** — field names learned from your logs, their most frequent values, `level:` values and `since:` durations. `Tab` completes. Matches are highlighted in the message column.
- **Live / Paused** pill and a floating **"N new ↓"** button; `Space` pauses and resumes.
- **Detail tabs:** Overview (message, clickable stack, attributes), **Context** (the surrounding lines of the same capture, plus "show only this request" for correlated entries) and JSON.
- **Time column modes** — clock, time since the previous line (gaps over 1 s stand out) and time since the first line. `t` or click the column header.
- **Bookmarks** — `b` marks a line, `is:bookmarked` filters to them.
- **Back to the previous filter.** Filters applied from the detail panel (an attribute, "show only this request", the new **Similar** message button) remember where you were: `Backspace`, the ← button next to the search or the mouse back button restore the search, levels, capture filter and the selected line.
- **Clear button** (✕) in the search box.
- **Jump between errors** with `e` / `Shift+E`, and a **`?` shortcut sheet**.
- **Inline attributes** — up to three short structured fields (`userId=42 route=/users`) shown dimmed after the message.
- The status bar shows **errors that arrived while the dashboard was hidden**; opening it clears the count.
- The dashboard **comes back after restarting VS Code** (`WebviewPanelSerializer`), with its filters and selection.

### Changed

- New minimalist chrome: one toolbar line (search, severity, count, live, clear, `⋯` menu), native codicons instead of emoji, color reserved for severity. Paste, export, stop-all, time format, density and shortcuts live in the `⋯` menu.
- `Space` now pauses/resumes the live follow; `Enter` opens details.
- A `field:` typed without a value no longer empties the list while you finish typing it.
- Accessibility: rows expose position and set size, menus and tabs are arrow-key navigable, focus returns to the list when details or dialogs close, high-contrast themes use borders instead of tints.

## [1.5.0] - 2026-11-01

Foundation release: how lines become log events. Stack traces are now one entry, plain-text and logfmt logs keep their own time and fields, and finished captures stay visible.

### Added

- **Multi-line events.** A stack trace is now **one** entry instead of one per line: Node/Java/.NET frames (`at …`), Java `Caused by:` / `... N more`, Python tracebacks (shown as their `ZeroDivisionError: …` line), Go frames, and multi-line object dumps. The row shows a `+N` badge, the detail panel shows the frames, frames are searchable (`UserService`, `stack:user.service.ts`), included in text exports, and sent to agents (top 25 frames, budgeted). Works for commands, followed files and pasted text.
- **Plain-text timestamps.** Lines that start with their own time (ISO, `2026-11-01 10:00:00,123`, NestJS's `11/1/2026, 12:53:23 PM`, `14:02:11.123`) use it instead of the arrival time — so the histogram and time filters are right for tailed files and pasted logs.
- **logfmt.** `time=… level=warn msg="slow query" ms=812` (Go, logrus, zap, slog, Rails) is parsed into level, message, time and searchable fields (`ms:812`, `request_id` → correlation).
- **Finished captures stay listed** in the sidebar with their outcome (✓ exited 0, ✗ exited 1, stopped) and a **Restart** action; Clear in the dashboard removes them. `list_captures` reports `endedAt` and `exitCode`.
- `stream:stdout` / `stream:stderr` search field for command captures.
- `npm run bench` — host ingest benchmark (~95k lines/s on a laptop).

### Changed

- **stderr is no longer "error".** npm, webpack, Vite and Python logging write ordinary output to stderr; those lines now default to INFO (tagged `stream: stderr`) and real errors are recognized by their level keyword or stack trace.
- The history store keeps indexes (id, correlation/trace id, session, level counts), so agent tools like `get_request_trace` and `get_error_context` no longer scan the whole history.
- The Stop button is disabled when nothing is running.

## [1.4.2] - 2026-11-01

A correctness and robustness release from an end-to-end review. No new features — everything here is a fix.

### Fixed

- **Text with `[` was corrupted on every capture.** The ANSI cleaner treated any `[` followed by a letter as an escape code, so `[INFO] ready` became `NFO] ready`, NestJS's `[Nest] … [RoutesResolver]` lost letters, and `[ERROR]` lines lost their level. Escape codes now require the ESC byte.
- **Pino timestamps.** Pino's default `time` (epoch milliseconds) was stored as a raw number string, so the time column showed `1730000000000`, the histogram and `after:`/`before:` filters ignored those lines, and MCP `since` tools skipped them. Timestamps are now normalized to ISO from epoch seconds/ms/µs/ns, ISO strings, `YYYY-MM-DD HH:mm:ss,SSS`, and the `timestamp`/`time`/`ts`/`@timestamp` fields.
- **Level detection.** JSON levels like `warning`, `fatal`, `critical`, `notice`, `verbose` (and the `severity`/`levelname`/`@l`/`log.level` fields) were all shown as INFO; an HTTP `status: 500` no longer reads as a level. Plain-text detection now matches whole words and the level token at the start of the line, so "Compiled with 0 errors", "failover" or "errorHandler" are no longer flagged as errors, while `TypeError:` and `NullPointerException` are.
- **Regex search could freeze VS Code.** The ReDoS guard missed patterns such as `(a+?)+b`, `(\w+\s?)*$` and `(a|aa)+$`, which then hung inside the guard's own probe. A deterministic structural check now refuses them instantly (in the dashboard, `search_logs`/`wait_for_logs`, and custom redaction patterns).
- **Redaction gaps.** `Authorization: Basic …` (and `Token`/`Digest`) leaked the credential; numeric JSON secrets (`"password": 123456`) and `--password x` CLI flags were not masked; CDN URLs like `…/npm/pkg@1.0.0` were wrongly masked.
- **Accented and emoji characters** split across output chunks turned into `�`. Output is now decoded as a UTF-8 stream.
- **Following a log file** could read the whole file at start, deliver lines out of order under bursts, keep reading after Stop, and silently stop after log rotation. Reads are now serialized, rotation (rename/delete + recreate) and truncation are handled, a polling safety net covers platforms where file events are unreliable, and the initial seed no longer starts with a half line.
- **Commands:** Enter now reaches interactive prompts (`y/N`); the terminal stays open after the process ends so crash output isn't lost; a non-zero exit is reported in the dashboard and to agents as an ERROR entry; the extension host's own `ELECTRON_RUN_AS_NODE` no longer leaks into child processes; stopping a process no longer re-signals a PID that may have been reused; captures are shut down properly when VS Code closes.
- **Dashboard performance.** Entries now reach the dashboard in batches, level counts are maintained incrementally, and the history is an O(1) ring buffer — bursts of thousands of lines per second no longer freeze the panel. The dashboard also keeps to the history limit instead of growing without bound (which also made "Export → current view" miss rows).
- **Dashboard UI:** typing `/` in the Paste dialog no longer jumps to search; selecting the newest histogram bar no longer hides logs that arrive afterwards; histogram drags stay stable while logs stream in; click-to-filter works for keys like `x-request-id`/`@timestamp` and values with spaces or quotes; selected rows are readable in light and high-contrast themes; the list stays pinned to the bottom when the detail panel opens or a filter changes; the narrow (stacked) layout no longer shows a stray resizer or a fixed-width panel; Clear keeps your search and level filters; the selection survives history trimming.
- **MCP server:** when a list response is cut by the token budget, the *newest* entries are returned (older ones via `expand`); `get_error_context` says so when it had to fall back to an error before `since`; an aborted `wait_for_logs` frees its slot immediately instead of holding it for up to 60 s; pending long-polls are answered before shutdown; oversized requests get a clean 413; the `Bearer` scheme is case-insensitive; client JSON-RPC responses are acknowledged with 202.

### Changed

- `since:5m`-style relative times now work inside dashboard / `search_logs` queries, not just in `get_errors_since`.
- Opening the dashboard from the status bar or sidebar no longer pops the "choose a log source" picker when there are already logs to show.
- Running a command no longer switches the panel to the Output channel (the terminal stays in front), and captured lines are no longer duplicated into the Output channel.
- `localLogViewer.historyLimit` is clamped to 100000 even when edited directly in settings.json.
- `@vscode/vsce` is pinned as a dev dependency; the test runner reports every failing suite instead of stopping at the first.

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
