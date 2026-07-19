#!/usr/bin/env bash
# End-to-end smoke test against a RUNNING MCP server (launch the extension
# via F5 first, then grab port+token via "Copy MCP Setup" → plain format).
#
# Usage: scripts/mcp-smoke.sh <port> <token>
set -euo pipefail

PORT="${1:?usage: mcp-smoke.sh <port> <token>}"
TOKEN="${2:?usage: mcp-smoke.sh <port> <token>}"
URL="http://127.0.0.1:${PORT}/mcp"
AUTH="Authorization: Bearer ${TOKEN}"
CT="Content-Type: application/json"

fail() { echo "✗ $1"; exit 1; }
pass() { echo "✓ $1"; }

# initialize — expect protocolVersion and Mcp-Session-Id header
INIT_HEADERS=$(mktemp)
INIT=$(curl -s -D "$INIT_HEADERS" -H "$AUTH" -H "$CT" -X POST "$URL" -d '{
  "jsonrpc":"2.0","id":1,"method":"initialize",
  "params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}
}')
echo "$INIT" | grep -q '"protocolVersion"' || fail "initialize: no protocolVersion in $INIT"
grep -qi '^mcp-session-id:' "$INIT_HEADERS" || fail "initialize: missing Mcp-Session-Id header"
pass "initialize"

# notifications/initialized — expect 202
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" -H "$CT" -X POST "$URL" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}')
[ "$CODE" = "202" ] || fail "initialized notification: expected 202, got $CODE"
pass "notifications/initialized → 202"

# tools/list — expect all nine tools (6 browse/poll + the 3 intent tools)
TOOLS=$(curl -s -H "$AUTH" -H "$CT" -X POST "$URL" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
for tool in get_log_stats get_recent_logs search_logs get_errors_since list_captures wait_for_logs \
            get_error_context get_request_trace expand; do
  echo "$TOOLS" | grep -q "\"$tool\"" || fail "tools/list: missing $tool"
done
pass "tools/list (9 tools)"

# tools/call get_log_stats
STATS=$(curl -s -H "$AUTH" -H "$CT" -X POST "$URL" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_log_stats","arguments":{}}}')
# The tool result nests its JSON payload as a string inside content[].text, so
# the inner quotes arrive escaped (\"historyLimit\"). Match the bare key.
echo "$STATS" | grep -q 'historyLimit' || fail "get_log_stats: $STATS"
pass "tools/call get_log_stats"

# negative: no token → 401
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "$CT" -X POST "$URL" -d '{"jsonrpc":"2.0","id":4,"method":"ping"}')
[ "$CODE" = "401" ] || fail "no token: expected 401, got $CODE"
pass "missing token → 401"

# negative: evil Origin → 403
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" -H "$CT" -H "Origin: https://evil.example" \
  -X POST "$URL" -d '{"jsonrpc":"2.0","id":5,"method":"ping"}')
[ "$CODE" = "403" ] || fail "evil origin: expected 403, got $CODE"
pass "foreign Origin → 403"

# negative: GET → 405
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" "$URL")
[ "$CODE" = "405" ] || fail "GET: expected 405, got $CODE"
pass "GET → 405"

echo
echo "All MCP smoke checks passed."
