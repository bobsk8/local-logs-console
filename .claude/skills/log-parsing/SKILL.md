---
name: log-parsing
description: Use when changing how log lines are parsed, how severity levels are detected, or how secrets are redacted in this extension — adding a supported log format, a new field alias (correlationId/traceId/etc.), a level keyword, a LogLevel, or a redaction pattern. Covers the ingest pipeline order and the compile-before-test requirement.
---

# Editing log parsing, level detection & redaction

Parsing is the core of this extension. Every captured line flows through **one** pipeline (`src/core/logPipeline.ts`): `cleanLine` → `Redactor.redact` → `LogParser.parseLine` → store + event bus. Order matters — redaction happens on the raw line *before* parsing.

## Level detection is unified

`detectLevel(line, fallback)` exported from `src/logParser.ts` is the **single** heuristic: JSON `level` field first, then keywords (`ERROR`/`EXCEPTION`/`FAIL` → ERROR, `WARN`/`AVISO` → WARN, then `INFO`, `DEBUG`, `TRACE`), then the fallback. It is used by:
- `LogParser.parseLine`'s plaintext fallback, and
- `CaptureManager` (`src/core/captureManager.ts`) for pseudoterminal coloring and the stream default.

Change level rules in `detectLevel` only — do NOT reintroduce a second copy.

`parseLine` precedence:
- `[LVL:LEVEL] ...` injected marker → uses that level, sets `raw.__hasLevelMarker = true` (prevents `LogPipeline.ingestPrepared` from overriding it with the stream default).
- `JSON.parse` success → reads `level`/`status`, `timestamp`/`time`, `message`/`msg`, `service`/`source`, `correlationId`/`correlationID`, `traceId`.
- plaintext fallback → `detectLevel(trimmed, 'INFO')`.
- blank line → `null`.

## Redaction (`src/core/redactor.ts`)

Pure class, options injected (`enabled`, `useDefaultPatterns`, `customPatterns`); `LogPipeline` builds it from the `localLogViewer.redaction.*` settings and rebuilds on config change. **Hard rule for new patterns:** a JSON line must stay valid JSON after redaction (replace only value characters between the quotes, never the quotes or structure), or the line falls back to plaintext parsing and loses level/timestamp. Key-based rules allow prefix/suffix around the keyword (`DB_PASSWORD`, `X-Api-Key`) — test both forms.

## Adding a new LogLevel

`LogLevel` is a union in `src/models/logEntry.ts`. To add one you must touch every switch/list that enumerates levels:
- `models/logEntry.ts` — the union type.
- `logParser.ts` — `normalizeLevel()` allow-list, `detectLevel()` allow-list + keyword branch, and the `[LVL:...]` regex.
- `core/captureManager.ts` — `terminalColor()` switch.
- `src/webview/script.js` + `style.css` — filter badges, `activeLevels`, and per-level CSS classes (see the `webview-ui` skill).

## Testing (order matters)

Tests are plain-Node assertion scripts that `require('../out/...')` — they read **compiled** output, so source edits are invisible until you recompile:

```bash
npm test    # runs compile first, then all test/test-*.js
```

Relevant suites: `test/test-parser.js` (parseLine + detectLevel), `test/test-redactor.js` (every default pattern + JSON-validity round-trips), `test/test-line-cleaner.js`. Keep using `assert` — no framework.

## Gotchas

- `String(value)` is used liberally in `parseLine` — a JSON `message` that is an object becomes `"[object Object]"`. The full object is still preserved in `raw` and shown in the webview JSON tree, so prefer reading `raw` for structured data.
- The webview filters/searches over `JSON.stringify(log.raw)`, not `message` — so anything you want searchable must end up in `raw`.
- Don't break the `__hasLevelMarker` contract: `LogPipeline.ingestPrepared` checks `parsed.raw.__hasLevelMarker` to decide whether an `overrideLevel` may replace the parsed level.
- `LogEntry` now carries `redacted?: boolean` and `sessionId?: string` — the pipeline sets both; parsers should not.
