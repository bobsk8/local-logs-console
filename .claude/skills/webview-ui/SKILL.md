---
name: webview-ui
description: Use when editing the dashboard webview (src/webview/script.js or style.css) or the HTML in logDashboard.ts — adding a filter, column, detail-panel field, button, or styling. Covers the src/webview path coupling, the strict CSP, the postMessage protocol, and the virtualized list so changes don't break packaging or rendering.
---

# Editing the webview UI

The dashboard is a VS Code webview. The extension host (`LogDashboard`) and the browser-side code (`src/webview/script.js`) share NO memory — they talk only via `postMessage`. Three things make this webview easy to break; read them before editing.

## 1. Webview assets ship from `src/webview/`, not `out/`

`tsc` compiles only `.ts`. `src/webview/script.js` and `style.css` are plain files loaded at runtime via `asWebviewUri(... 'src','webview', ...)` in `logDashboard.ts` (`_getHtmlForWebview`). That path is coupled in **three** places — keep them in sync or the packaged extension renders blank:
- `logDashboard.ts` — the two `asWebviewUri` calls.
- `.vscodeignore` — excludes `**/src/**` but re-includes `!src/webview/**`.
- `package.json` `files` — includes `src/webview/**`.

Do NOT move these into `out/` or rename the folder without updating all three. There is no build step for the webview — edit the JS/CSS directly.

## 2. Strict Content Security Policy

The CSP in `_getHtmlForWebview` is `default-src 'none'` with only `${webview.cspSource}` allowed for styles/scripts/img/font. Consequences:
- **No inline `<script>` and no inline event handlers** (`onclick=`). Attach listeners in `script.js` with `addEventListener`.
- **No remote resources / CDNs / fonts / network.** `connect-src 'none'`. Everything ships in the VSIX.
- New assets must live under `src/webview/` and be referenced via `asWebviewUri`.
- Always `escapeHtml()` (already defined in `script.js`) any log-derived string you inject as `innerHTML` — log content is untrusted.

## 3. The list is virtualized

`renderWindow()` keeps only the rows visible in the viewport (± `BUFFER`) in the DOM; `ROW_HEIGHT = 34` and the `spacer` height (`filteredIndexes.length * ROW_HEIGHT`) fake the full scroll height. Implications:
- Row height is fixed. If you change row markup/height, update `ROW_HEIGHT` to match or scrolling drifts.
- Don't query "all rows" from the DOM — most don't exist. Operate on `logsData` (all logs) / `filteredIndexes` (indexes passing the current filter) instead.
- After changing what's rendered, the update path is `updateSpacer()` → `renderWindow()` → `updateCounterOnly()`; `updateFilteredIndexes()` wraps all three for filter/search changes.

## postMessage protocol

Host → webview (`_panel.webview.postMessage`): `addLog {log}`, `loadHistory {logs}`.
Webview → host (`vscode.postMessage`): `ready` (sent on load; host replies with history), `loadMore`, `stopAll` (triggers `local-log-viewer.stopAllCaptures`), `clearLogs`. Handlers live in `LogDashboard`'s `onDidReceiveMessage` switch and in the `window.addEventListener('message', ...)` block in `script.js`. Add a new interaction by extending both ends of the matching switch.

## Adding a severity filter / level to the UI

Filters are driven by `activeLevels = { error, warn, info, debug }` and the `.filter-badge[data-level]` elements in the HTML (`logDashboard.ts`) plus `matchesFilter()`. A new level needs: a badge element in the HTML, a key in `activeLevels`, a per-level CSS class (`.log-item.<level>`, `.level-<level>`) in `style.css`, and usually a count element (`count-*`). Coordinate with the `log-parsing` skill since levels also exist host-side.

## Styling

`style.css` uses VS Code theme variables (`var(--vscode-...)`) — prefer them over hardcoded colors so the dashboard follows the user's theme.
