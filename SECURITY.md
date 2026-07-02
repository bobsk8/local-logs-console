# Security Policy

## Supported Versions

Security fixes are applied to the latest published version.

## Reporting a Vulnerability

Please do not open public issues for security vulnerabilities.

- **Preferred**: report privately via [GitHub Security Advisories](https://github.com/bobsk8/local-logs-console/security/advisories/new).
- **Email**: rodrigovianaprado@gmail.com

Include the affected version, reproduction steps, an impact assessment, and a suggested fix if available. You should receive an acknowledgment within a few days.

## Threat Model

- **Local-only by design.** Logs are never sent to external services. The dashboard webview runs under a strict Content Security Policy (`default-src 'none'`, `connect-src 'none'`, nonce-based scripts) — it cannot make network requests or execute inline code. Log content reaches the webview only through VS Code's `postMessage` bridge and is rendered as text, never as HTML.
- **Command execution is the product.** "Run and Capture" executes the shell command you type, locally, with your user privileges. That is intentional and equivalent to running it in a terminal. Consequently:
  - The extension declares `untrustedWorkspaces.supported: false` — it is disabled in workspaces you have not trusted.
  - "Run Last Command" asks for confirmation before re-executing a stored command (configurable).
  - `localLogViewer.capture.inheritEnvironment: false` passes only a minimal environment to child processes so they cannot read secrets from environment variables.
- **Secret redaction is best-effort defense-in-depth.** Built-in patterns mask common credential shapes (AWS keys, bearer tokens, JWTs, GitHub/Slack/Google tokens, password-like fields, URL credentials) before logs are stored, displayed or exported. Pattern matching can never be exhaustive — do not rely on it as your only control, and avoid logging secrets in the first place.
- **What the extension stores**: saved commands in VS Code `workspaceState`, and an in-memory log history (capped) that is discarded when VS Code closes. Nothing is written to disk unless you explicitly export.

## Good Practices

- Run only trusted commands; they have the same privileges as your local environment.
- Review exported log files before sharing them.
