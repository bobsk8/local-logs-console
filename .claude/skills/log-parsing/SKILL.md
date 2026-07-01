---
name: log-parsing
description: Use when changing how log lines are parsed or how severity levels are detected in this extension — adding a supported log format, a new field alias (correlationId/traceId/etc.), a level keyword, or a LogLevel. Warns about the duplicated level-detection logic and the compile-before-test requirement.
---

# Editing log parsing & level detection

Parsing is the core of this extension. The tricky part: **level detection lives in two independent places** and the test suite runs against compiled output, not source.

## The two sources of truth

1. `src/logParser.ts` — `LogParser.parseLine(line)`. Turns a raw string into a `LogEntry`. This is what actually populates the dashboard history (`LogDashboard.addLogLine` → `LogParser.parseLine`). Precedence:
   - `[LVL:LEVEL] ...` injected marker → uses that level, sets `raw.__hasLevelMarker = true` (prevents `LogDashboard` from overriding it with the stream default).
   - `JSON.parse` success → reads `level`/`status`, `timestamp`/`time`, `message`/`msg`, `service`/`source`, `correlationId`/`correlationID`, `traceId`.
   - plaintext fallback → keyword heuristic (`ERROR`/`EXCEPTION`/`FAIL` → ERROR, `WARN`/`WARNING`/`AVISO` → WARN, else INFO).
   - blank line → returns `null`.
2. `src/extension.ts` → `detectLevel(line, fallback)` (nested inside `runAndCapture`). A **separate** JSON + keyword heuristic used only to color the pseudoterminal line and pick the stream default before forwarding to the dashboard.

**Rule of thumb:** a change to *what level a line gets* almost always needs editing BOTH `detectLevel` (extension.ts) and the fallback/normalize logic in `logParser.ts`, or terminal color and dashboard level will disagree. A change to *which fields are extracted* (aliases, new `LogEntry` property) is `logParser.ts` + `src/models/logEntry.ts` only.

## Adding a new LogLevel

`LogLevel` is a union in `src/models/logEntry.ts`. To add one you must touch every switch/list that enumerates levels:
- `models/logEntry.ts` — the union type.
- `logParser.ts` — `normalizeLevel()` allow-list and the `[LVL:...]` regex.
- `extension.ts` — `detectLevel()` keyword branch, `terminalColor()` switch, the `['ERROR','WARN',...]` allow-list.
- `src/webview/script.js` + `style.css` — filter badges, `activeLevels`, and per-level CSS classes (see the `webview-ui` skill).

## Testing (order matters)

`test/test-parser.js` is a plain-Node assertion script that does `require('../out/logParser.js')` — it reads **compiled** output, so source edits are invisible until you recompile:

```bash
npm run compile && npm test    # always compile first
```

Add a case by appending assertions in `test/test-parser.js` (JSON line, plaintext line, and empty-line cases already exist as templates). There is no test framework — keep using `assert`.

## Gotchas

- `String(value)` is used liberally in `parseLine` — a JSON `message` that is an object becomes `"[object Object]"`. The full object is still preserved in `raw` and shown in the webview JSON tree, so prefer reading `raw` for structured data.
- The webview filters/searches over `JSON.stringify(log.raw)`, not `message` — so anything you want searchable must end up in `raw`.
- Don't break the `__hasLevelMarker` contract: `LogDashboard.addLogLine` checks `parsed.raw.__hasLevelMarker` to decide whether an `overrideLevel` may replace the parsed level.
