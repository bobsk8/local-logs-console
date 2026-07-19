# Distribution & MCP registry listings

Prep + checklist for getting the extension discovered by people looking for an MCP log server for their coding agent. Not shipped in the VSIX (`docs/` is outside the `files` allow-list).

## The one thing to understand first

The MCP server is **embedded in a VS Code extension** — it binds to `127.0.0.1`, uses a **per-workspace Bearer token**, and only runs while the extension is active in that window. It is **not** a standalone server you can `npx`-launch or host at a public URL.

Consequence: the big registries (Glama, Smithery, mcp.so) are built around *installable / hosted* servers. We don't fit their one-click-install flow. So the registry play here is **discovery backlinks that point people to the VS Code Marketplace**, where the real install happens — not a Smithery `publish`. Set expectations accordingly and don't contort the extension to fit a registry.

**Primary install channel stays the Marketplace:** <https://marketplace.visualstudio.com/items?itemName=bobsk8.local-log-viewer>

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

## Where to submit — ranked by fit (all need your GitHub/account, so they're your action)

1. **awesome-mcp-servers** — best fit. A curated list that accepts diverse entries and links out. Open a PR adding a one-line entry under a logging/observability or IDE section, linking the repo + Marketplace. Repo: <https://github.com/punkpeye/awesome-mcp-servers>.
2. **Glama** (<https://glama.ai/mcp/servers>) — auto-indexes public GitHub repos that contain an MCP server; ours qualifies. Submit/claim the repo so the listing links to the Marketplace. Its "deploy hosted connector" won't apply (embedded server) — that's fine, the value is the backlink + tool-schema listing.
3. **mcp.so** (<https://mcp.so>) — directory with a submit form; same repo + Marketplace links.
4. **Smithery** (<https://smithery.ai>) — **low fit**: it wants a hosted URL or a launchable command (`smithery mcp publish <url>`), which an embedded per-workspace server doesn't have. Skip unless/until there's a standalone entry point; don't fabricate one.

For each: use the metadata table above verbatim so the listings stay consistent.

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
