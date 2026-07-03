const assert = require('assert');
const path = require('path');

const { createMcpTools } = require(path.join('..', 'out', 'mcp', 'mcpTools.js'));

// ---- fakes (no vscode) ----

function entry(overrides) {
    return Object.assign({
        id: 'id-' + Math.random().toString(36).slice(2),
        timestamp: '2026-07-03T12:00:00.000Z',
        level: 'INFO',
        source: 'api',
        message: 'hello',
        raw: { message: 'hello' }
    }, overrides);
}

function seededStore() {
    const entries = [];
    for (let i = 0; i < 10; i++) {
        const message = `line ${i}` + (i % 3 === 0 ? ' failed' : ' ok');
        entries.push(entry({
            timestamp: `2026-07-03T12:00:${String(i).padStart(2, '0')}.000Z`,
            level: i % 3 === 0 ? 'ERROR' : (i % 3 === 1 ? 'INFO' : 'DEBUG'),
            source: i % 2 === 0 ? 'api' : 'worker',
            message,
            raw: { message, index: i, user: { name: i % 2 === 0 ? 'alice' : 'bob' } }
        }));
    }
    return { getAll: () => entries.slice(), count: () => entries.length, entries };
}

function fakeBus() {
    const listeners = new Set();
    return {
        onLogReceived(listener) {
            listeners.add(listener);
            return { dispose: () => listeners.delete(listener) };
        },
        emit(e) {
            for (const l of [...listeners]) { l(e); }
        }
    };
}

const fakeRegistry = {
    getAll: () => [
        { id: 'cmd-1', kind: 'command', label: 'npm run dev', startedAt: Date.parse('2026-07-03T11:59:00Z'), status: 'running', stop() { } }
    ]
};

function makeTools(store, bus, extra = {}) {
    return createMcpTools(Object.assign({
        store,
        registry: fakeRegistry,
        bus,
        historyLimit: () => 10000,
        now: () => new Date('2026-07-03T12:05:00.000Z'),
        debounceMs: 20,
        maxWaiters: 2
    }, extra));
}

function parsePayload(result) {
    assert.strictEqual(result.isError, undefined, 'expected success result: ' + JSON.stringify(result));
    const parsed = JSON.parse(result.content[0].text);
    assert.deepStrictEqual(parsed, result.structuredContent, 'structuredContent must mirror text');
    return parsed;
}

async function run() {
    console.log('Running MCP tools tests...');
    const store = seededStore();
    const bus = fakeBus();
    const tools = makeTools(store, bus);

    // ---- definitions ----
    assert.strictEqual(tools.definitions.length, 6);
    const names = tools.definitions.map(d => d.name).sort();
    assert.deepStrictEqual(names, ['get_errors_since', 'get_log_stats', 'get_recent_logs', 'list_captures', 'search_logs', 'wait_for_logs']);
    for (const d of tools.definitions) {
        assert.strictEqual(d.inputSchema.type, 'object', d.name + ' schema');
        assert.ok(d.description.length > 20, d.name + ' description');
    }
    const searchDef = tools.definitions.find(d => d.name === 'search_logs');
    for (const marker of ['field:value', '-clause', '/pattern/i', 'after:']) {
        assert.ok(searchDef.description.includes(marker), 'grammar marker missing: ' + marker);
    }

    // ---- get_recent_logs ----
    let p = parsePayload(await tools.call('get_recent_logs', {}));
    assert.strictEqual(p.returned, 10);
    assert.strictEqual(p.entries[0].message, 'line 0 failed', 'oldest first');
    assert.strictEqual(p.entries[9].message.startsWith('line 9'), true);
    assert.strictEqual(p.entries[0].raw, undefined, 'raw omitted by default');
    assert.strictEqual(p.entries[0].id, undefined, 'internal id omitted');

    p = parsePayload(await tools.call('get_recent_logs', { count: 3 }));
    assert.strictEqual(p.returned, 3);
    assert.strictEqual(p.total, 10);
    assert.ok(p.entries[0].message.startsWith('line 7'));

    p = parsePayload(await tools.call('get_recent_logs', { level: 'ERROR' }));
    assert.strictEqual(p.total, 4); // i = 0,3,6,9
    assert.ok(p.entries.every(e => e.level === 'ERROR'));

    p = parsePayload(await tools.call('get_recent_logs', { source: 'WORK' }));
    assert.ok(p.entries.every(e => e.source === 'worker'), 'source substring, case-insensitive');

    p = parsePayload(await tools.call('get_recent_logs', { includeRaw: true, count: 1 }));
    assert.deepStrictEqual(p.entries[0].raw.index, 9);

    let r = await tools.call('get_recent_logs', { count: 'abc' });
    assert.strictEqual(r.isError, true, 'bad count rejected');

    // ---- search_logs (reuses the real grammar) ----
    p = parsePayload(await tools.call('search_logs', { query: 'level:error failed' }));
    assert.strictEqual(p.total, 4);

    p = parsePayload(await tools.call('search_logs', { query: 'user.name:alice -failed' }));
    assert.ok(p.total > 0);

    p = parsePayload(await tools.call('search_logs', { query: 'after:2026-07-03T12:00:07Z' }));
    assert.strictEqual(p.total, 3); // seconds 07, 08, 09

    p = parsePayload(await tools.call('search_logs', { query: '/(a+)+$/' }));
    assert.ok(p.queryWarning, 'unsafe regex surfaces queryWarning');

    r = await tools.call('search_logs', {});
    assert.strictEqual(r.isError, true, 'missing query is a tool error');
    assert.ok(r.content[0].text.includes('grammar') || r.content[0].text.includes('Query grammar'));

    // ---- get_errors_since ----
    p = parsePayload(await tools.call('get_errors_since', { since: '5m' }));
    // now = 12:05 → since 12:00: ERROR entries at sec 0,3,6,9 → all 4
    assert.strictEqual(p.total, 4);
    assert.strictEqual(p.sinceResolved, '2026-07-03T12:00:00.000Z');

    p = parsePayload(await tools.call('get_errors_since', { since: '2026-07-03T12:00:05Z', levels: ['ERROR', 'DEBUG'] }));
    assert.ok(p.entries.every(e => e.level === 'ERROR' || e.level === 'DEBUG'));

    r = await tools.call('get_errors_since', { since: 'not-a-date' });
    assert.strictEqual(r.isError, true);
    assert.ok(r.content[0].text.includes('"5m"'), 'format hint present');

    r = await tools.call('get_errors_since', {});
    assert.strictEqual(r.isError, true);

    // ---- get_log_stats ----
    p = parsePayload(await tools.call('get_log_stats', {}));
    assert.strictEqual(p.totalEntries, 10);
    assert.strictEqual(p.historyLimit, 10000);
    assert.strictEqual(p.byLevel.ERROR, 4);
    assert.strictEqual(p.bySource.api, 5);
    assert.strictEqual(p.oldestTimestamp, '2026-07-03T12:00:00.000Z');
    assert.strictEqual(p.newestTimestamp, '2026-07-03T12:00:09.000Z');
    assert.strictEqual(p.activeCaptures.length, 1);
    assert.strictEqual(p.activeCaptures[0].label, 'npm run dev');

    // ---- list_captures ----
    p = parsePayload(await tools.call('list_captures', {}));
    assert.strictEqual(p.captures[0].id, 'cmd-1');
    assert.ok(p.captures[0].uptimeMs > 0);

    // ---- wait_for_logs ----
    // match arrives → resolves with batch
    let waitPromise = tools.call('wait_for_logs', { level: 'ERROR', timeoutMs: 2000 });
    setTimeout(() => {
        bus.emit(entry({ level: 'ERROR', message: 'first' }));
        bus.emit(entry({ level: 'ERROR', message: 'second' }));
        bus.emit(entry({ level: 'INFO', message: 'ignored' }));
    }, 10);
    p = parsePayload(await waitPromise);
    assert.strictEqual(p.timedOut, false);
    assert.strictEqual(p.matched, 2, 'debounce batches the burst, filters non-matching');
    assert.deepStrictEqual(p.entries.map(e => e.message), ['first', 'second']);

    // query filter
    waitPromise = tools.call('wait_for_logs', { query: 'level:error boom', timeoutMs: 2000 });
    setTimeout(() => {
        bus.emit(entry({ level: 'ERROR', message: 'nope', raw: { message: 'nope' } }));
        bus.emit(entry({ level: 'ERROR', message: 'boom happened', raw: { message: 'boom happened' } }));
    }, 10);
    p = parsePayload(await waitPromise);
    assert.strictEqual(p.matched, 1);

    // timeout with no matches
    p = parsePayload(await tools.call('wait_for_logs', { level: 'TRACE', timeoutMs: 100 }));
    assert.strictEqual(p.timedOut, true);
    assert.strictEqual(p.matched, 0);

    // waiter cap (maxWaiters: 2)
    const w1 = tools.call('wait_for_logs', { timeoutMs: 1500, level: 'TRACE' });
    const w2 = tools.call('wait_for_logs', { timeoutMs: 1500, level: 'TRACE' });
    r = await tools.call('wait_for_logs', { timeoutMs: 1500 });
    assert.strictEqual(r.isError, true, 'third concurrent waiter rejected');
    assert.ok(r.content[0].text.includes('max 2'));

    // dispose resolves pending waiters
    tools.dispose();
    const [p1, p2] = await Promise.all([w1, w2]);
    assert.strictEqual(JSON.parse(p1.content[0].text).timedOut, true);
    assert.strictEqual(JSON.parse(p2.content[0].text).timedOut, true);

    console.log('All MCP tools tests passed.');
}

run().catch(err => { console.error(err); process.exit(1); });
