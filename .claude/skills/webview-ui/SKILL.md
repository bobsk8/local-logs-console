---
name: webview-ui
description: Use when editing the dashboard webview (src/webview-src/*.ts, style.css) or the HTML in logDashboard.ts — adding a filter, column, detail-panel field, button, message type, or styling. Covers the esbuild → media/ build coupling, the strict nonce CSP, the typed postMessage protocol, and the virtualized list so changes don't break packaging or rendering.
---

# Editing the webview UI

The dashboard is a VS Code webview. The extension host (`LogDashboard`) and the browser-side code share NO memory — they talk only via `postMessage`, typed by `src/shared/protocol.ts`. Four things make this webview easy to break; read them before editing.

## 1. Source lives in `src/webview-src/`, ships from `media/`

The webview is TypeScript bundled by esbuild (`esbuild.mjs`) into `media/webview.js` + `media/webview.css`. **Never edit `media/`** — it is generated (gitignored) and rebuilt by `npm run build:webview` / the `watch:webview` task. The coupling points that must stay in sync:
- `esbuild.mjs` — entry points (`src/webview-src/main.ts`, `src/webview-src/style.css`) and the `media` outdir.
- `logDashboard.ts` — the two `asWebviewUri(... 'media', ...)` calls.
- `package.json` `files` — includes `media/**` (NOT `src/`). `vsce` refuses to build if a `.vscodeignore` is added alongside `files` — don't.

esbuild does **not** type-check; `npm run compile` also runs `tsc -p tsconfig.webview.json` (noEmit) for that. The host tsconfig has no DOM lib — don't import webview modules from host code (only `src/shared/` and `src/models/` are shared).

## 2. Module map (src/webview-src/)

- `main.ts` — orchestrator: DOM refs, persisted-state restore, message handler, toolbar wiring (pills with live counts, time-range chip, `⋯` menu, density toggle), `updateFilteredIndexes`/`applySearch`. Feature modules receive dependencies/callbacks from here — there are no cross-module imports between the feature classes, so no import cycles.
- `virtualList.ts` — `VirtualList`: windowed rendering over a **fixed node pool**. Only rows in the viewport (± `BUFFER`) are bound; off-window slots are hidden, never destroyed. Row height is dynamic (`state.rowHeight`, density toggle) and mirrored to the `--row-height` CSS var via `applyRowHeight()` — change row markup/height in both places or scrolling drifts. Don't query "all rows" from the DOM — operate on `state.logsData` / `state.filteredIndexes`. **All log content flows through `textContent`** — there is deliberately no `innerHTML` sink for untrusted data anywhere in the webview; keep it that way. Also owns `aria-activedescendant`/`aria-selected`.
- `histogram.ts` — `Histogram`: 60-bucket stacked timeline, 200ms debounced, built from the base-filtered set (level+search, NOT the time filter); click toggles a bucket, drag selects a range; both set `state.timeFilter` (persisted).
- `detailPanel.ts` — `DetailPanel`: attributes table (click adds a `field:value` search token), message block, collapsible JSON tree (nested levels start collapsed), copy buttons, redacted badge, resizer drag. Renders exclusively via `textContent`.
- `emptyStates.ts` — loading skeleton / "no logs yet" onboarding (posts `runCommandRequest`/`followFileRequest`) / "no results" overlays.
- `keyboard.ts` — global shortcuts (`/`, Ctrl/Cmd+F, arrows, Enter, Esc, Home/End, Ctrl/Cmd+End). It ignores events targeting INPUT/TEXTAREA/BUTTON — preserve that guard or focused buttons break.
- `state.ts` — the shared mutable `UiState` + `BUFFER`/`ROW_HEIGHTS`/`LEVELS`.
- `lib/format.ts`, `lib/filter.ts`, `lib/search.ts` — **pure, DOM-free** (plain-Node testable via `npm run build:test-libs` + `test/test-search.js`). The search grammar (terms AND-ed, `"phrase"`, `-negation`, `field:value`, `/regex/i` with ReDoS guard in `compileSafeRegex`) lives in `lib/search.ts` — extend it there and add test cases.
- `vscodeApi.ts` — typed `acquireVsCodeApi()` wrapper: `post()`, `getPersistedState()`, `setPersistedState()` (+ the `PersistedState` shape).

After changing what's rendered, the update path is `list.updateSpacer()` → `list.renderWindow()` → `updateCounterOnly()`; `updateFilteredIndexes()` (main.ts) wraps all of it for filter/search changes.

## 3. Strict CSP with nonce

`_getHtmlForWebview` sets `default-src 'none'; script-src 'nonce-<random>'; style-src ${cspSource}; connect-src 'none'; base-uri 'none'`. Consequences:
- No inline `<script>`/`<style>`/event-handler attributes — attach listeners in TS with `addEventListener`.
- The `<script>` tag must carry the `nonce` attribute (already wired).
- No remote resources / CDNs / network from the webview, ever (`connect-src 'none'` is a product guarantee). Everything ships in the VSIX.
- Log content reaches the webview only via `postMessage` — never interpolate it into the HTML string in `logDashboard.ts`.

## 4. The postMessage protocol is typed

`src/shared/protocol.ts` declares `ExtensionToWebviewMessage` (`addLog`, `loadHistory`) and `WebviewToExtensionMessage` (`ready`, `loadMore`, `stopAll`, `clearLogs`, `runCommandRequest`, `followFileRequest`). To add a message: extend the union there, then update the `switch` in `logDashboard.ts` and the handler in `main.ts` — the compiler points at both. Never post untyped literals.

## State persistence

UI state (filters, search, selection, scroll, panel width, autoScroll) persists across reloads via `vscode.setState` (debounced 150ms in `persistUiState`). New persistent UI state: add the field to `PersistedState` in `vscodeApi.ts`, write it in `persistUiState()` (main.ts), and restore it in the startup block before the first `loadHistory`.

## Adding a severity level / filter badge

Badges are `.filter-badge[data-level]` divs in `logDashboard.ts` HTML; `state.activeLevels` keys must match the `data-level` values and the lowercase `LogEntry.level`. Also add `--sev-*` color, `.log-item.<level>`, `.level-<level>`, `.hist-<level>` CSS rules in `style.css`. Coordinate with the `log-parsing` skill since levels also exist host-side.

## Styling

`style.css` uses VS Code theme variables (`var(--vscode-...)`) — prefer them over hardcoded colors so the dashboard follows the user's theme.

## Verify

`npm run compile` (host tsc + webview typecheck + esbuild), `npm test`, then F5 and exercise: stream logs, filter, search, histogram click, open detail, resize panel, reload window (state restore). Before shipping packaging changes: `npm run package` and `unzip -l *.vsix` — must contain `media/webview.js`/`webview.css` and no `src/`.
