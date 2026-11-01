# Testing with F5 — quick guide

## 1. Launch

In the project's VS Code window, pick **"Launch Extension (Sandbox)"** in Run and Debug and press **F5**.
A new window opens on this folder with only this extension enabled.

## 2. Run a scenario

1. `Ctrl+Shift+P` → **Local Logs Console: Run and Capture Command**
2. Type the command (e.g. `npm run all`) → Enter
3. The dashboard opens on its own (or `Ctrl+Alt+L`)

The command is saved: next time it shows up in the list, or use `Ctrl+Alt+Shift+L` (runs the last one).

## 3. What to check

| Command | Expected result |
|---|---|
| `npm run all` | Runs several scenarios in a row (a good first test) |
| `npm run nest` | `[Nest]` and `[RoutesResolver]` stay **intact**; colors are stripped; `ERROR` in red |
| `npm run pino` | Time column shows the **real time** (not `1730000000000`); `fatal` = ERROR; `status: 500` stays INFO |
| `npm run levels` | `0 errors`, `failover`, `errorHandler` = **INFO**; `TypeError` and `3 tests failed` = **ERROR**; `npm warn …` (stderr) = **WARN**; searching `stream:stderr` keeps only stderr lines |
| `npm run unicode` | `café`, `naïve ❤️`, `日本語`, emojis with **no `�`** |
| `npm run secrets` | Passwords/tokens become `[REDACTED]` (🛡 badge in the detail panel); the CDN URL and `prompt_tokens` are **not** masked |
| `npm run stack` | Each stack trace becomes **a single line** with a `+N` badge; the detail panel lists the frames. The Python traceback shows as `ZeroDivisionError: …`. Searching `UserService` or `stack:demo.js` finds it by frame |
| `npm run burst` | 15k lines in ~3 s: the dashboard **does not freeze**, counters go up, scrolling stays smooth |
| `npm run live` | Continuous stream. Try: scroll up (stops following), `Ctrl+End` (resumes), click/drag on the histogram, the **Stop** button |
| `npm run prompt` | Type `y` + Enter **in the terminal** → `you answered: "y"` appears |
| `npm run crash` | The terminal **stays open**; the dashboard shows `Process exited with code 1` as ERROR; the sidebar shows the session as ✗ `exited 1` with a **↻ restart** button |

### Following a file (log rotation)

1. Run `npm run tail` (captured, or in a regular terminal)
2. `Ctrl+Shift+P` → **Local Logs Console: Follow Log File** → `sandbox/logs/app.log`
3. The file is rotated every 40 lines: the dashboard keeps receiving lines (`log rotated…`)

### UI (with `npm run live` running)

- Open a line → the detail panel opens and the list **stays at the bottom**
- Click an attribute in the detail panel (e.g. `req.id`) → filters to that request only
- Search: `level:error`, `since:1m`, `/GET \/users/`, and `(a|aa)+$` (must be rejected right away, without hanging)
- `⋯` → **Paste logs** → typing `/` in the text box works
- **Clear** (click twice) → clears the logs, **keeps** the search; finished sessions leave the sidebar
- With nothing running, **Stop all** is disabled
- Switch theme: `Ctrl+K Ctrl+T` → light and high contrast; the selected line must stay readable
- Narrow window (< 980 px) → the detail panel moves below, with no leftover resize handle

### New in 2.0

| What | How to test | Expected result |
|---|---|---|
| Clickable stack | `npm run stack` → open the `TypeError` → click the `…demo.js:69:…` link in the stack | Opens `demo.js` at the right line, beside the dashboard |
| Problems | After `npm run stack`, `Ctrl+Shift+M` | An error in `demo.js` on the line that threw; it goes away on **Clear** or when the capture runs again |
| F5 capture | In this window, Run and Debug → **Debug demo: stack traces** → F5 | A 🐞 chip with the config name and the program's lines appears, no command needed |
| Project scripts | `Ctrl+Shift+P` → **Run and Capture Command** | A "Scripts" section lists `nest`, `pino`, `live`… (run with `npm run`) |
| Restart | With `npm run live` running, `Ctrl+Alt+R` (from anywhere) | Stops and runs again; the chip keeps its filter |
| Capture chips | Run 2 scenarios | Click a chip → only that capture; ⟳ / ■ work; `exit 1` in red for `crash` |
| Autocomplete | In the search, type `lev` → `Tab` → `e` → `Tab` | Becomes `level:error `; the list does **not** empty while you type |
| Live / Paused | `npm run live`, press **Space** | The pill turns "Paused" and "N new ↓" appears; clicking it goes back to live |
| Time | Press `t` (or click "Time") | Clock → "Δ Prev" (gaps > 1 s in yellow) → "Since start" |
| Bookmarks / errors | `b` on a line, then search `is:bookmarked`; `e` / `Shift+E` | Only bookmarked lines; the selection jumps from error to error |
| Detail | Open a line → **Context** and **JSON** tabs | Context shows the surrounding lines of the same capture; with `req.id`, "Show only this request" |
| Status bar | Close/hide the dashboard and run `npm run crash` | `$(error) N` in the status bar; resets when the dashboard opens |
| Restore | With the dashboard open, `Ctrl+R` (Reload Window) | The panel comes back on its own, with filters and selection |
| Shortcuts | `?` | Sheet with every shortcut |
| Clear search | Type something in the search | A ✕ appears on the right; clicking it clears the text and keeps the cursor in the search |
| Similar + Back | Open a `GET /users/…` line → **Similar**; then click an attribute value; then `Backspace` twice (or ←) | Filters `GET "/users/"`, then narrows; each `Backspace` goes back one step, with the same line selected |

### AI agents (MCP)

`Ctrl+Shift+P` → **Local Logs Console: Copy MCP Setup for Coding Agents…** and paste it into your agent.
Quick check from a terminal: `bash ../scripts/mcp-smoke.sh <port> <token>`.

### Performance (without VS Code)

`npm run bench` (from the project root) measures host ingestion — target: > 5,000 lines/s.

## Tip

If something goes wrong, check **Output → Local Logs Console** and the **Debug Console** of the original window.
Changed code? It recompiles on its own (watch) — reload the test window with `Ctrl+R`.
