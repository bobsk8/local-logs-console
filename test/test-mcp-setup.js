const assert = require('assert');
const path = require('path');

const { buildMcpSetupSnippets } = require(path.join('..', 'out', 'mcp', 'mcpSetup.js'));

function run() {
    console.log('Running MCP setup-snippet tests...');

    const endpoint = 'http://127.0.0.1:51234/mcp';
    const token = 'tok_abc123';
    const snippets = buildMcpSetupSnippets(endpoint, token);

    assert.strictEqual(snippets.length, 4);
    for (const s of snippets) {
        assert.ok(s.label && s.detail && s.text, 'complete snippet: ' + s.label);
        assert.ok(s.text.includes(endpoint) || s.label.includes('plain'), s.label + ' contains endpoint');
        assert.ok(s.text.includes(token), s.label + ' contains token');
    }

    // Claude Code CLI form
    const cli = snippets[0].text;
    assert.ok(cli.startsWith('claude mcp add --transport http local-logs '), cli);
    assert.ok(cli.includes(`--header "Authorization: Bearer ${token}"`), cli);

    // .mcp.json is valid JSON with type http
    const mcpJson = JSON.parse(snippets[1].text);
    assert.strictEqual(mcpJson.mcpServers['local-logs'].type, 'http');
    assert.strictEqual(mcpJson.mcpServers['local-logs'].url, endpoint);
    assert.strictEqual(mcpJson.mcpServers['local-logs'].headers.Authorization, `Bearer ${token}`);

    // Cursor variant: valid JSON, no "type" field
    const cursorJson = JSON.parse(snippets[2].text);
    assert.strictEqual(cursorJson.mcpServers['local-logs'].type, undefined);
    assert.strictEqual(cursorJson.mcpServers['local-logs'].url, endpoint);

    console.log('All MCP setup-snippet tests passed.');
}

run();
