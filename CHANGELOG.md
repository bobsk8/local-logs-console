# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/) and the project adheres to semantic versioning.

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
