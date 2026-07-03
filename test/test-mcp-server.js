// Integration test for the MCP HTTP layer: boots the real McpServerManager
// against a stubbed 'vscode' module and exercises auth, Origin validation,
// method/path handling, body cap, and a full initialize→tools round-trip.
const assert = require('assert');
const path = require('path');
const Module = require('module');

// ---- stub the vscode module before requiring the manager ----
const configOverrides = { 'mcp.enabled': true, 'mcp.port': 0 };
const fakeVscode = {
    workspace: {
        getConfiguration: () => ({
            get: (key, fallback) => (key in configOverrides ? configOverrides[key] : fallback)
        })
    },
    window: {
        showWarningMessage: async () => undefined,
        showInformationMessage: async () => undefined
    },
    commands: { executeCommand: async () => undefined },
    Disposable: class { constructor(fn) { this.dispose = fn || (() => { }); } },
    EventEmitter: class {
        constructor() { this.listeners = new Set(); }
        get event() {
            return (listener) => {
                this.listeners.add(listener);
                return { dispose: () => this.listeners.delete(listener) };
            };
        }
        fire(value) { for (const l of [...this.listeners]) { l(value); } }
        dispose() { this.listeners.clear(); }
    },
    Uri: { parse: (s) => ({ toString: () => s }) }
};

const realLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'vscode') { return fakeVscode; }
    return realLoad.call(this, request, ...rest);
};

const { McpServerManager } = require(path.join('..', 'out', 'mcp', 'mcpServerManager.js'));

// ---- fakes ----
function entry(message, level = 'INFO') {
    return {
        id: 'id-' + message,
        timestamp: new Date().toISOString(),
        level,
        source: 'api',
        message,
        raw: { message }
    };
}

const storeEntries = [entry('boot ok'), entry('crash detected', 'ERROR')];
const store = { getAll: () => storeEntries.slice(), count: () => storeEntries.length };
const registry = { getAll: () => [] };
const busListeners = new Set();
const bus = {
    onLogReceived(listener) {
        busListeners.add(listener);
        return { dispose: () => busListeners.delete(listener) };
    },
    emit(e) { for (const l of [...busListeners]) { l(e); } }
};
let storedToken;
const secrets = {
    get: async () => storedToken,
    store: async (_k, v) => { storedToken = v; }
};
const logLines = [];
const outputChannel = { appendLine: (l) => logLines.push(l) };

async function post(url, { token, origin, body, headers = {} } = {}) {
    const h = { 'Content-Type': 'application/json', ...headers };
    if (token) { h.Authorization = `Bearer ${token}`; }
    if (origin) { h.Origin = origin; }
    const res = await fetch(url, { method: 'POST', headers: h, body });
    let json = null;
    try { json = JSON.parse(await res.text()); } catch { /* 202 has no body */ }
    return { status: res.status, headers: res.headers, json };
}

async function run() {
    console.log('Running MCP server integration tests...');

    const manager = new McpServerManager({
        secrets, store, registry, bus, outputChannel,
        serverVersion: '1.2.0-test',
        onStateChange: () => { }
    });

    await manager.syncWithConfig();
    assert.strictEqual(manager.running, true, 'server should be running');
    assert.ok(manager.port > 0, 'bound to a real port');
    assert.ok(manager.endpoint.endsWith('/mcp'));
    assert.ok(manager.token && manager.token.length >= 32, 'token generated');
    assert.strictEqual(storedToken, manager.token, 'token persisted to secrets');
    assert.ok(logLines.some(l => l.includes(manager.endpoint)), 'endpoint logged');
    assert.ok(!logLines.some(l => l.includes(manager.token)), 'token never logged');

    const url = manager.endpoint;
    const token = manager.token;
    const initBody = JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }
    });

    // auth required
    let r = await post(url, { body: initBody });
    assert.strictEqual(r.status, 401);
    r = await post(url, { token: 'wrong-token', body: initBody });
    assert.strictEqual(r.status, 401);

    // foreign Origin rejected; localhost Origin accepted
    r = await post(url, { token, origin: 'https://evil.example', body: initBody });
    assert.strictEqual(r.status, 403);
    r = await post(url, { token, origin: 'http://localhost:3000', body: initBody });
    assert.strictEqual(r.status, 200);

    // wrong path / method
    const badPath = await fetch(url.replace('/mcp', '/other'), {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: initBody
    });
    assert.strictEqual(badPath.status, 404);
    const get = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    assert.strictEqual(get.status, 405);
    assert.strictEqual(get.headers.get('allow'), 'POST');

    // body cap → 413
    r = await post(url, { token, body: 'x'.repeat(300 * 1024) });
    assert.strictEqual(r.status, 413);

    // initialize round-trip with session header
    r = await post(url, { token, body: initBody });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.result.protocolVersion, '2025-06-18');
    assert.ok(r.headers.get('mcp-session-id'), 'Mcp-Session-Id on initialize');
    assert.ok(r.json.result.instructions.includes('get_log_stats'));

    // initialized notification → 202
    r = await post(url, { token, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    assert.strictEqual(r.status, 202);

    // tools/list → six tools
    r = await post(url, { token, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    assert.strictEqual(r.json.result.tools.length, 6);

    // tools/call over the seeded store
    r = await post(url, {
        token,
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_logs', arguments: { query: 'level:error' } } })
    });
    const payload = JSON.parse(r.json.result.content[0].text);
    assert.strictEqual(payload.total, 1);
    assert.strictEqual(payload.entries[0].message, 'crash detected');

    // wait_for_logs resolves when the bus emits
    const waitPromise = post(url, {
        token,
        body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'wait_for_logs', arguments: { level: 'WARN', timeoutMs: 3000 } } })
    });
    setTimeout(() => bus.emit(entry('disk almost full', 'WARN')), 50);
    r = await waitPromise;
    const waited = JSON.parse(r.json.result.content[0].text);
    assert.strictEqual(waited.timedOut, false);
    assert.strictEqual(waited.entries[0].message, 'disk almost full');

    // config: disabling stops the server promptly
    configOverrides['mcp.enabled'] = false;
    await manager.syncWithConfig();
    assert.strictEqual(manager.running, false);
    await assert.rejects(() => fetch(url, { method: 'POST' }), 'port should be closed');

    // re-enabling restarts with the SAME persisted token
    configOverrides['mcp.enabled'] = true;
    await manager.syncWithConfig();
    assert.strictEqual(manager.running, true);
    assert.strictEqual(manager.token, token, 'token survives restart');

    await manager.stop();
    assert.strictEqual(manager.running, false);

    console.log('All MCP server integration tests passed.');
}

run().catch(err => { console.error(err); process.exit(1); });
