const assert = require('assert');
const path = require('path');

const { dispatchMcpMessage, jsonRpcError, LATEST_PROTOCOL_VERSION } =
    require(path.join('..', 'out', 'mcp', 'mcpProtocol.js'));

function makeDeps(overrides = {}) {
    const calls = [];
    return {
        calls,
        deps: Object.assign({
            serverInfo: { name: 'local-logs-console', version: '1.2.0' },
            instructions: 'Call get_log_stats first.',
            listTools: () => [{ name: 'echo', description: 'echoes', inputSchema: { type: 'object' } }],
            callTool: async (name, args) => {
                calls.push({ name, args });
                return { content: [{ type: 'text', text: 'ok' }] };
            }
        }, overrides)
    };
}

async function run() {
    console.log('Running MCP protocol tests...');
    const { deps, calls } = makeDeps();

    // Parse error
    let out = await dispatchMcpMessage('{nope', deps);
    assert.strictEqual(out.kind, 'error');
    assert.strictEqual(out.status, 400);
    assert.strictEqual(out.body.error.code, -32700);
    assert.strictEqual(out.body.id, null);

    // Batch rejected (removed in 2025-06-18)
    out = await dispatchMcpMessage('[{"jsonrpc":"2.0","id":1,"method":"ping"}]', deps);
    assert.strictEqual(out.body.error.code, -32600);

    // Invalid shapes
    out = await dispatchMcpMessage('"hello"', deps);
    assert.strictEqual(out.body.error.code, -32600);
    out = await dispatchMcpMessage(JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'ping' }), deps);
    assert.strictEqual(out.body.error.code, -32600);
    out = await dispatchMcpMessage(JSON.stringify({ jsonrpc: '2.0', id: 1 }), deps);
    assert.strictEqual(out.body.error.code, -32600);

    // initialize — echoes a supported version
    out = await dispatchMcpMessage(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } }
    }), deps);
    assert.strictEqual(out.kind, 'json');
    assert.strictEqual(out.isInitialize, true);
    assert.strictEqual(out.body.result.protocolVersion, '2025-03-26');
    assert.deepStrictEqual(out.body.result.capabilities, { tools: { listChanged: false } });
    assert.strictEqual(out.body.result.serverInfo.name, 'local-logs-console');
    assert.ok(out.body.result.instructions.includes('get_log_stats'));

    // initialize — unsupported version falls back to latest
    out = await dispatchMcpMessage(JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2024-11-05' }
    }), deps);
    assert.strictEqual(out.body.result.protocolVersion, LATEST_PROTOCOL_VERSION);

    // notifications → 202 (initialized and unknown alike)
    out = await dispatchMcpMessage(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), deps);
    assert.deepStrictEqual(out, { kind: 'accepted', status: 202 });
    out = await dispatchMcpMessage(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/whatever' }), deps);
    assert.strictEqual(out.status, 202);

    // ping
    out = await dispatchMcpMessage(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }), deps);
    assert.deepStrictEqual(out.body.result, {});

    // tools/list
    out = await dispatchMcpMessage(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }), deps);
    assert.strictEqual(out.body.result.tools.length, 1);
    assert.strictEqual(out.body.result.tools[0].name, 'echo');

    // tools/call routes name + arguments
    out = await dispatchMcpMessage(JSON.stringify({
        jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } }
    }), deps);
    assert.strictEqual(out.body.result.content[0].text, 'ok');
    assert.deepStrictEqual(calls[0], { name: 'echo', args: { a: 1 } });

    // unknown tool → -32602
    out = await dispatchMcpMessage(JSON.stringify({
        jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' }
    }), deps);
    assert.strictEqual(out.body.error.code, -32602);

    // callTool throwing → -32603 with detail
    const throwing = makeDeps({ callTool: async () => { throw new Error('boom'); } });
    out = await dispatchMcpMessage(JSON.stringify({
        jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'echo' }
    }), throwing.deps);
    assert.strictEqual(out.body.error.code, -32603);
    assert.strictEqual(out.body.error.data, 'boom');

    // unknown method with id → -32601
    out = await dispatchMcpMessage(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'resources/list' }), deps);
    assert.strictEqual(out.body.error.code, -32601);

    // jsonRpcError helper shape
    assert.deepStrictEqual(jsonRpcError(9, -32600, 'x'), { jsonrpc: '2.0', id: 9, error: { code: -32600, message: 'x' } });

    console.log('All MCP protocol tests passed.');
}

run().catch(err => { console.error(err); process.exit(1); });
