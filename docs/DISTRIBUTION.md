# Distribution & MCP registry listings

Prep + checklist for getting the extension discovered by people looking for an MCP log server for their coding agent. Not shipped in the VSIX (`docs/` is outside the `files` allow-list).

## The one thing to understand first

The MCP server is **embedded in a VS Code extension** — it binds to `127.0.0.1`, uses a **per-workspace Bearer token**, and only runs while the extension is active in that window. It is **not** a standalone server you can `npx`-launch or host at a public URL. It has **no life outside the extension**: there is nothing to install, run, or connect to unless "Local Logs Console" is already active in a VS Code window.

**Primary — and effectively only — install channel is the Marketplace:** <https://marketplace.visualstudio.com/items?itemName=bobsk8.local-log-viewer>

## Decision: don't submit to MCP registries (2026-07-19)

The MCP registries (awesome-mcp-servers, Glama, Smithery, mcp.so) catalog **standalone, installable/hosted servers** — the whole point of a listing is "here's a server you can install and run on its own." Our server can't be installed or run on its own; it only exists as a feature of the extension. So:

- We **do not fit** the "install this server" model those lists are built around, and several maintainers reject entries that aren't independently launchable.
- The only value a listing could add is a **discovery backlink** to the Marketplace — low return, and a real chance of a rejected PR.

**Therefore: skip the registries.** Discovery happens where the product actually lives:

1. **VS Code Marketplace SEO** — the `AI` category + agentic-debugging keywords (`mcp`, `claude code`, `cursor`, `cline`, `copilot`, `nestjs`, `pino`, `winston`) shipped in 1.4.1. This is the correct channel because the product *is* an extension.
2. **GitHub README** — leads with the embedded-MCP pitch for anyone arriving via the repo.

Revisit only if a genuine **standalone entry point** is ever added (e.g. a `npx`-launchable server that talks to the extension) — that's the trigger that would make a registry listing honest. Until then, the metadata table below is kept for reference (README/Marketplace copy), not for registry submission.

## Reusable listing metadata (paste into any registry/PR)

| Field | Value |
|---|---|
| Name | Local Logs Console |
| One-liner | VS Code extension with an embedded local MCP server that streams your app's runtime logs to AI coding agents (Claude Code, Cursor, Cline) — token-aware, request-correlated, on-machine. |
| Transport | Streamable HTTP (JSON-RPC 2.0), `127.0.0.1` only |
| Auth | Bearer token, per-workspace, stored in the OS keychain |
| Install | VS Code Marketplace: `bobsk8.local-log-viewer`; then run **"Local Logs Console: Copy MCP Setup for Coding Agents…"** |
| Tools (9) | `get_log_stats`, `get_recent_logs`, `search_logs`, `get_errors_since`, `get_error_context`, `get_request_trace`, `list_captures`, `wait_for_logs`, `expand` |
| Repository | <https://github.com/bobsk8/local-logs-console> |
| License | MIT |
| Maintainer / support | GitHub issues: <https://github.com/bobsk8/local-logs-console/issues> |
| Category | AI / Debuggers / Logging |

## Registries considered and skipped

Recorded here so the decision isn't relitigated. None were submitted — all are a poor fit for an embedded (non-standalone) server; see the decision section above.

| Registry | Why skipped |
|---|---|
| **awesome-mcp-servers** (<https://github.com/punkpeye/awesome-mcp-servers>) | Curated list of installable/standalone servers; an embedded VS Code feature isn't independently launchable, so an entry is at best a Marketplace backlink and likely rejected. |
| **Glama** (<https://glama.ai/mcp/servers>) | Indexes repos containing a runnable MCP server + offers hosted deploy; neither applies to a per-workspace embedded server. |
| **mcp.so** (<https://mcp.so>) | Directory of standalone servers; same mismatch. |
| **Smithery** (<https://smithery.ai>) | Wants a hosted URL or launchable command (`smithery mcp publish <url>`) — an embedded per-workspace server has none; don't fabricate one. |

**Trigger to revisit:** a standalone entry point (a `npx`-launchable proxy that connects to the extension). Absent that, keep the metadata table for README/Marketplace copy only.

## Cross-agent verification (front 3)

The Marketplace claim is "works with Claude Code, Cursor, Cline, Copilot." Verify the endpoint + Bearer flow on each. Setup snippets come from the **Copy MCP Setup** command; formats:

- **Claude Code** — `claude mcp add --transport http local-logs http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"` (already verified in Phase 1).
- **Cursor** — `.cursor/mcp.json`:
  ```json
  { "mcpServers": { "local-logs": { "url": "http://127.0.0.1:<port>/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
  ```
- **Cline** — MCP settings (`cline_mcp_settings.json`), same shape as Cursor: a `mcpServers` entry with `url` + `Authorization` header.
- **VS Code Copilot agent mode** (≥1.101) — no config; auto-discovered via the `mcpServerDefinitionProviders` contribution.

**Smoke steps (needs you to run the extension):**
1. Launch the extension (**F5**), start a capture so there are logs.
2. Run **Copy MCP Setup → "Endpoint + token (plain)"** to get `<port>` and `<token>`.
3. Transport/auth check, client-agnostic: `scripts/mcp-smoke.sh <port> <token>` (curl-drives `initialize` → `tools/list` → a `tools/call`).
4. Per agent: paste the snippet above, then ask the agent to call `get_log_stats` and `get_error_context` and confirm it gets data back.

Steps 1–2 and the per-agent paste are manual (they need a real Cursor/Cline window); step 3 is scriptable.

## After any metadata change

Marketplace search re-indexes from the **published** `package.json`. Metadata edits only take effect once a new version is published — bump + `/publish-release`.
