# Local Logs Console

![Local Logs Console Demo](resources/demo.gif)

Local logs are where most debugging time is lost.

Before production observability tools are available, developers often rely on noisy terminal output, mixed processes, and log files spread across folders. This makes simple questions hard to answer quickly:

- Which request failed?
- Where did this warning start?
- Which payload triggered this error?

Local Logs Console brings local logs into a focused dashboard inside VS Code so you can investigate faster without changing your runtime flow.

## Why Developers Choose This Extension

- Built for local development, not only post-deploy observability.
- Works with any stack that writes to stdout/stderr or log files.
- Gives structure to noisy output with level filters, search, and detail view.
- Keeps your workflow inside VS Code.
- Cross-platform support for macOS, Linux, and Windows.
- Security-first: no remote log shipping.

## Features

- Follow local log files.
- Run any command and capture stdout/stderr in real time.
- Filter by severity and search by text.
- Inspect structured log payloads in a detail panel.
- Stop running captures safely across macOS, Linux, and Windows.

## Usage

- Run the command: `Local Logs Console: Open Dashboard` (Command Palette).
- The panel displays JSON entries or text captured from the terminal.
- Level filters, text search, and a details panel are available.

## Commands

- `Local Logs Console: Open Dashboard`
- `Local Logs Console: Run and Capture Command`

## Terminal Capture Without Proposed APIs

To ensure Marketplace compatibility, this extension does not use proposed VS Code APIs.

- To capture terminal output in a portable way, use `Local Logs Console: Run and Capture Command`. It executes your command (for example, `npm run dev`) and streams `stdout`/`stderr` to the dashboard in real time.
- To follow an existing log file, choose `Follow log file` from the dashboard command picker.

## Compatibility

Designed to run on macOS, Windows, and Linux. It avoids unnecessary native dependencies and uses UUID generation with fallback support for compatibility.

## Development

Install dependencies and compile:

```bash
npm install
npm run compile
# For continuous development:
npm run watch
```

Run tests:

```bash
npm test
```

## Technical Notes

- The webview uses a restrictive Content Security Policy and does not allow remote resources.
- Process captures and file watchers are closed when capture is stopped or when the extension is deactivated.

## Security

- The extension does not send logs to external services.
- Commands executed through `Run and Capture` run locally in the user context.
- Run only trusted commands, since they have the same privileges as your local environment.

## Typical Local Debugging Pain Points Solved

- Terminal noise makes severity hard to spot.
	Local Logs Console lets you filter by level and isolate only what matters.
- Debugging by scrolling loses context.
	The dashboard keeps searchable history and structured details.
- Mixed formats (plain text and JSON) slow investigation.
	The extension handles both in one view.
- Local issues happen before cloud tooling is available.
	You can inspect behavior immediately during development.

## Open Source Project Standards

- Contribution guide: see `CONTRIBUTING.md`.
- Security policy: see `SECURITY.md`.
- Code of conduct: see `CODE_OF_CONDUCT.md`.
- Release history: see `CHANGELOG.md`.
- CI workflow: see `.github/workflows/ci.yml`.

Contributions and issues are welcome.
