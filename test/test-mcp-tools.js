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
    // structuredContent is opt-in now; when present it must mirror the text channel.
    if ('structuredContent' in result) {
        assert.deepStrictEqual(parsed, result.structuredContent, 'structuredContent must mirror text when emitted');
    }
    return parsed;
}

async function run() {
    console.log('Running MCP tools tests...');
    const store = seededStore();
    const bus = fakeBus();
    const tools = makeTools(store, bus);

    // ---- definitions ----
    assert.strictEqual(tools.definitions.length, 9);
    const names = tools.definitions.map(d => d.name).sort();
    assert.deepStrictEqual(names, ['expand', 'get_error_context', 'get_errors_since', 'get_log_stats', 'get_recent_logs', 'get_request_trace', 'list_captures', 'search_logs', 'wait_for_logs']);

    // structuredContent is omitted by default (text-only), keeping responses small
    const rawResult = await tools.call('get_recent_logs', { count: 1 });
    assert.strictEqual('structuredContent' in rawResult, false, 'no structuredContent by default');
    // ...but a server can opt back in
    const structuredTools = makeTools(store, fakeBus(), { structuredContent: true });
    const structuredResult = await structuredTools.call('get_recent_logs', { count: 1 });
    assert.ok(structuredResult.structuredContent, 'structuredContent present when opted in');
    structuredTools.dispose();
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

    // ---- get_error_context: correlation mode by errorId ----
    {
        const corr = [
            entry({ id: 'e1', timestamp: '2026-07-03T12:01:00.000Z', level: 'INFO', message: 'req start', correlationId: 'abc', sessionId: 'cmd-1' }),
            entry({ id: 'e2', timestamp: '2026-07-03T12:01:01.000Z', level: 'DEBUG', message: 'querying', correlationId: 'abc', sessionId: 'cmd-1' }),
            entry({ id: 'e3', timestamp: '2026-07-03T12:01:02.000Z', level: 'ERROR', message: 'boom', correlationId: 'abc', sessionId: 'cmd-1' }),
            // same correlationId reused by a DIFFERENT session — must NOT bleed in
            entry({ id: 'x1', timestamp: '2026-07-03T12:01:03.000Z', level: 'INFO', message: 'other run', correlationId: 'abc', sessionId: 'cmd-2' }),
            // unrelated line in the same session
            entry({ id: 'e4', timestamp: '2026-07-03T12:01:04.000Z', level: 'INFO', message: 'unrelated', correlationId: 'zzz', sessionId: 'cmd-1' })
        ];
        const cStore = { getAll: () => corr.slice(), count: () => corr.length };
        const cTools = makeTools(cStore, fakeBus());

        let cp = parsePayload(await cTools.call('get_error_context', { errorId: 'e3' }));
        assert.strictEqual(cp.mode, 'correlation');
        assert.strictEqual(cp.correlationId, 'abc');
        assert.strictEqual(cp.anchor.id, 'e3');
        assert.deepStrictEqual(cp.entries.map(e => e.id), ['e1', 'e2', 'e3'], 'only same-session correlated lines, time-ordered');
        assert.ok(cp.entries.every(e => e.id !== undefined), 'drill-in entries carry id');

        // since-based anchor picks the latest ERROR at/after the point
        cp = parsePayload(await cTools.call('get_error_context', { since: '2026-07-03T12:00:00Z' }));
        assert.strictEqual(cp.anchor.id, 'e3');
        assert.strictEqual(cp.mode, 'correlation');

        // unknown id → tool error
        const bad = await cTools.call('get_error_context', { errorId: 'nope' });
        assert.strictEqual(bad.isError, true);

        // neither errorId nor since → tool error
        const none = await cTools.call('get_error_context', {});
        assert.strictEqual(none.isError, true);
        cTools.dispose();
    }

    // ---- get_error_context: adjacency fallback (no correlation id) ----
    {
        const adj = [];
        for (let i = 0; i < 8; i++) {
            adj.push(entry({ id: 'a' + i, timestamp: `2026-07-03T12:02:0${i}.000Z`, level: i === 4 ? 'ERROR' : 'INFO', message: 'line ' + i, sessionId: 'cmd-1' }));
        }
        // a different session interleaved — must be excluded
        adj.push(entry({ id: 'other', timestamp: '2026-07-03T12:02:03.500Z', level: 'INFO', message: 'noise', sessionId: 'cmd-2' }));
        const aStore = { getAll: () => adj.slice(), count: () => adj.length };
        const aTools = makeTools(aStore, fakeBus());

        const ap = parsePayload(await aTools.call('get_error_context', { errorId: 'a4', before: 2, after: 1 }));
        assert.strictEqual(ap.mode, 'adjacency');
        assert.strictEqual(ap.correlationId, undefined);
        assert.deepStrictEqual(ap.entries.map(e => e.id), ['a2', 'a3', 'a4', 'a5'], 'before/after window within same session only');
        aTools.dispose();
    }

    // ---- token budget + expand handle ----
    {
        const big = [];
        for (let i = 0; i < 6; i++) {
            big.push(entry({
                id: 'b' + i,
                timestamp: `2026-07-03T12:03:0${i}.000Z`,
                level: 'ERROR',
                message: 'x'.repeat(500) + ' ' + i, // ~125 tokens each
                correlationId: 'trace',
                sessionId: 'cmd-1'
            }));
        }
        const bStore = { getAll: () => big.slice(), count: () => big.length };
        // tiny budget forces truncation after the first couple of entries
        const bTools = makeTools(bStore, fakeBus(), { maxResponseTokens: 200, maxEntryTokens: 400 });

        const first = parsePayload(await bTools.call('get_error_context', { errorId: 'b5' }));
        assert.strictEqual(first.mode, 'correlation');
        assert.strictEqual(first.total, 6);
        assert.strictEqual(first.truncated, true, 'over-budget response is truncated');
        assert.ok(first.handle && first.handle.startsWith('h_'), 'handle returned');
        assert.ok(first.returned < 6 && first.returned >= 1, 'partial slice');
        const firstIds = first.entries.map(e => e.id);

        // expand from the handle continues where the first slice ended
        const next = parsePayload(await bTools.call('expand', { handle: first.handle }));
        assert.strictEqual(next.total, 6);
        assert.strictEqual(next.offset, first.nextOffset);
        assert.ok(next.entries.length >= 1);
        const nextIds = next.entries.map(e => e.id);
        assert.strictEqual(firstIds.some(id => nextIds.includes(id)), false, 'no overlap between slices');

        // unknown handle → tool error
        const badH = await bTools.call('expand', { handle: 'h_missing123' });
        assert.strictEqual(badH.isError, true);
        bTools.dispose();
    }

    // ---- per-entry cap applies to the anchor too (no context flood) ----
    {
        const huge = 'y'.repeat(20000); // way over maxEntryTokens
        const one = [entry({ id: 'h1', level: 'ERROR', message: huge, correlationId: 'c', sessionId: 'cmd-1', raw: { message: huge, blob: huge } })];
        const hStore = { getAll: () => one.slice(), count: () => one.length };
        const hTools = makeTools(hStore, fakeBus(), { maxEntryTokens: 100 });

        const hp = parsePayload(await hTools.call('get_error_context', { errorId: 'h1', includeRaw: true }));
        assert.ok(hp.anchor.message.endsWith('…[truncated]'), 'oversized anchor message is capped');
        assert.strictEqual(hp.anchor.raw, undefined, 'oversized anchor raw is dropped');
        assert.strictEqual(hp.anchor.rawOmitted, true, 'anchor records rawOmitted');
        assert.ok(hp.entries[0].message.endsWith('…[truncated]'), 'entry copy is capped too');
        hTools.dispose();
    }

    // ---- expand reports dropped ids evicted since the snapshot ----
    {
        const seed = [];
        for (let i = 0; i < 6; i++) {
            seed.push(entry({ id: 'd' + i, timestamp: `2026-07-03T12:04:0${i}.000Z`, level: 'ERROR', message: 'z'.repeat(400) + i, correlationId: 'run', sessionId: 'cmd-1' }));
        }
        let live = seed.slice();
        const dStore = { getAll: () => live.slice(), count: () => live.length };
        const dTools = makeTools(dStore, fakeBus(), { maxResponseTokens: 120, maxEntryTokens: 400 });

        const first = parsePayload(await dTools.call('get_error_context', { errorId: 'd5' }));
        assert.strictEqual(first.truncated, true);
        // simulate FIFO eviction of the two oldest entries before expanding
        live = seed.slice(2);
        const ex = parsePayload(await dTools.call('expand', { handle: first.handle, offset: 0 }));
        assert.ok(ex.dropped >= 1, 'evicted ids reported in dropped');
        dTools.dispose();
    }

    // ---- expand: pagination to exhaustion + count cap + includeRaw carried ----
    {
        const many = [];
        for (let i = 0; i < 6; i++) {
            many.push(entry({
                id: 'p' + i,
                timestamp: `2026-07-03T12:06:0${i}.000Z`,
                level: 'ERROR',
                message: 'w'.repeat(400) + i,
                correlationId: 'pag',
                sessionId: 'cmd-1',
                raw: { message: 'w'.repeat(400) + i, index: i }
            }));
        }
        const pStore = { getAll: () => many.slice(), count: () => many.length };
        const pTools = makeTools(pStore, fakeBus(), { maxResponseTokens: 250, maxEntryTokens: 4000 });

        // walk the whole request via repeated expand; collect every id exactly once
        let res = parsePayload(await pTools.call('get_error_context', { errorId: 'p5', includeRaw: true }));
        const seen = [];
        res.entries.forEach(e => seen.push(e.id));
        assert.ok(res.entries[0].raw !== undefined, 'includeRaw honored on the first slice');
        let guard = 0;
        while (res.truncated) {
            assert.ok(++guard < 20, 'pagination terminates');
            res = parsePayload(await pTools.call('expand', { handle: res.handle }));
            res.entries.forEach(e => seen.push(e.id));
            assert.ok(res.entries.every(e => e.raw !== undefined), 'includeRaw carried into expand from the handle');
        }
        assert.deepStrictEqual(seen.slice().sort(), ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'], 'every line returned exactly once, no gaps or dupes');

        // count caps the slice size regardless of token budget
        const capped = parsePayload(await pTools.call('get_error_context', { errorId: 'p5', includeRaw: true }));
        const one = parsePayload(await pTools.call('expand', { handle: capped.handle, offset: 0, count: 1 }));
        assert.strictEqual(one.returned, 1, 'count:1 returns a single entry');
        pTools.dispose();
    }

    // ---- correlation by traceId only (no correlationId on the anchor) ----
    {
        const tr = [
            entry({ id: 't1', timestamp: '2026-07-03T12:07:00.000Z', level: 'INFO', message: 'start', traceId: 'T', sessionId: 'cmd-1' }),
            entry({ id: 't2', timestamp: '2026-07-03T12:07:01.000Z', level: 'ERROR', message: 'fail', traceId: 'T', sessionId: 'cmd-1' }),
            entry({ id: 't3', timestamp: '2026-07-03T12:07:02.000Z', level: 'INFO', message: 'other', traceId: 'U', sessionId: 'cmd-1' })
        ];
        const trTools = makeTools({ getAll: () => tr.slice(), count: () => tr.length }, fakeBus());
        const tp = parsePayload(await trTools.call('get_error_context', { errorId: 't2' }));
        assert.strictEqual(tp.mode, 'correlation');
        assert.strictEqual(tp.traceId, 'T');
        assert.strictEqual(tp.correlationId, undefined);
        assert.deepStrictEqual(tp.entries.map(e => e.id), ['t1', 't2'], 'grouped by traceId');
        trTools.dispose();
    }

    // ---- adjacency fallback when the anchor has NO sessionId (window over all) ----
    {
        const ns = [];
        for (let i = 0; i < 5; i++) {
            ns.push(entry({ id: 'n' + i, timestamp: `2026-07-03T12:08:0${i}.000Z`, level: i === 2 ? 'ERROR' : 'INFO', message: 'm' + i }));
        }
        const nsTools = makeTools({ getAll: () => ns.slice(), count: () => ns.length }, fakeBus());
        const np = parsePayload(await nsTools.call('get_error_context', { errorId: 'n2', before: 1, after: 1 }));
        assert.strictEqual(np.mode, 'adjacency');
        assert.deepStrictEqual(np.entries.map(e => e.id), ['n1', 'n2', 'n3'], 'window spans all entries when no session');
        nsTools.dispose();
    }

    // ---- handle TTL expiry: a stale handle is swept and rejected ----
    {
        const ttlSeed = [];
        for (let i = 0; i < 6; i++) {
            ttlSeed.push(entry({ id: 'k' + i, timestamp: `2026-07-03T12:09:0${i}.000Z`, level: 'ERROR', message: 'q'.repeat(400) + i, correlationId: 'ttl', sessionId: 'cmd-1' }));
        }
        let clock = new Date('2026-07-03T12:05:00.000Z');
        const ttlTools = makeTools(
            { getAll: () => ttlSeed.slice(), count: () => ttlSeed.length },
            fakeBus(),
            { now: () => clock, handleTtlMs: 1000, maxResponseTokens: 120, maxEntryTokens: 4000 }
        );
        const first = parsePayload(await ttlTools.call('get_error_context', { errorId: 'k5' }));
        assert.strictEqual(first.truncated, true);
        // advance the clock past the TTL, then register a new handle to trigger the sweep
        clock = new Date('2026-07-03T12:05:02.000Z');
        await ttlTools.call('get_error_context', { errorId: 'k5' });
        const stale = await ttlTools.call('expand', { handle: first.handle });
        assert.strictEqual(stale.isError, true, 'expired handle is rejected after TTL sweep');
        ttlTools.dispose();
    }

    // ---- get_request_trace: full ordered story by id ----
    {
        const rt = [
            entry({ id: 'r1', timestamp: '2026-07-03T12:10:00.000Z', level: 'INFO', message: 'GET /users', correlationId: 'REQ', sessionId: 'cmd-1' }),
            entry({ id: 'r2', timestamp: '2026-07-03T12:10:01.000Z', level: 'DEBUG', message: 'query', correlationId: 'REQ', sessionId: 'cmd-1' }),
            entry({ id: 'r3', timestamp: '2026-07-03T12:10:02.000Z', level: 'ERROR', message: 'boom', correlationId: 'REQ', sessionId: 'cmd-1' }),
            entry({ id: 'o1', timestamp: '2026-07-03T12:10:03.000Z', level: 'INFO', message: 'other', traceId: 'TRC' })
        ];
        const rtTools = makeTools({ getAll: () => rt.slice(), count: () => rt.length }, fakeBus());

        // by correlationId
        let rp = parsePayload(await rtTools.call('get_request_trace', { correlationId: 'REQ' }));
        assert.strictEqual(rp.correlationId, 'REQ');
        assert.deepStrictEqual(rp.entries.map(e => e.id), ['r1', 'r2', 'r3'], 'whole request, time-ordered from the start');
        assert.ok(rp.entries.every(e => e.id !== undefined), 'entries carry id');

        // by traceId
        rp = parsePayload(await rtTools.call('get_request_trace', { traceId: 'TRC' }));
        assert.deepStrictEqual(rp.entries.map(e => e.id), ['o1']);

        // unknown id → tool error
        const miss = await rtTools.call('get_request_trace', { traceId: 'NOPE' });
        assert.strictEqual(miss.isError, true);
        // neither id → tool error
        const none = await rtTools.call('get_request_trace', {});
        assert.strictEqual(none.isError, true);

        // token budget truncates and hands back a handle that expand paginates
        const big = [];
        for (let i = 0; i < 6; i++) {
            big.push(entry({ id: 'g' + i, timestamp: `2026-07-03T12:11:0${i}.000Z`, level: 'INFO', message: 'z'.repeat(400) + i, correlationId: 'BIG', sessionId: 'cmd-1' }));
        }
        const bigTools = makeTools({ getAll: () => big.slice(), count: () => big.length }, fakeBus(), { maxResponseTokens: 150, maxEntryTokens: 4000 });
        const t1 = parsePayload(await bigTools.call('get_request_trace', { correlationId: 'BIG' }));
        assert.strictEqual(t1.total, 6);
        assert.strictEqual(t1.truncated, true);
        assert.ok(t1.handle);
        const t2 = parsePayload(await bigTools.call('expand', { handle: t1.handle }));
        assert.ok(t2.entries.length >= 1);
        rtTools.dispose();
        bigTools.dispose();
    }

    // ---- retrofitted budget: browse tools truncate + hand back a handle ----
    {
        const big = [];
        for (let i = 0; i < 8; i++) {
            big.push(entry({ id: 'v' + i, timestamp: `2026-07-03T12:12:0${i}.000Z`, level: 'ERROR', message: 'y'.repeat(400) + i, raw: { message: 'y'.repeat(400) + i } }));
        }
        const bStore = { getAll: () => big.slice(), count: () => big.length };
        const bTools = makeTools(bStore, fakeBus(), { maxResponseTokens: 150, maxEntryTokens: 4000 });

        // get_recent_logs is now bounded
        const recent = parsePayload(await bTools.call('get_recent_logs', { count: 8 }));
        assert.strictEqual(recent.total, 8);
        assert.ok(recent.returned < 8 && recent.truncated === true, 'browse response truncated to budget');
        assert.ok(recent.handle, 'handle returned');
        assert.strictEqual(recent.entries[0].id, undefined, 'browse entries still omit id');
        // expand the browse handle
        const more = parsePayload(await bTools.call('expand', { handle: recent.handle }));
        assert.ok(more.entries.length >= 1);
        assert.strictEqual(more.entries[0].id, undefined, 'expanded browse entries omit id too');

        // search_logs + get_errors_since are bounded as well
        const searched = parsePayload(await bTools.call('search_logs', { query: 'level:error' }));
        assert.strictEqual(searched.total, 8);
        assert.strictEqual(searched.truncated, true);
        const since = parsePayload(await bTools.call('get_errors_since', { since: '2026-07-03T12:00:00Z' }));
        assert.strictEqual(since.truncated, true);
        assert.ok(since.sinceResolved, 'sinceResolved preserved alongside budget fields');
        bTools.dispose();
    }

    // ---- search grammar aliases: reqId/request_id resolve to correlationId ----
    {
        const al = [
            entry({ id: 's1', message: 'hit', correlationId: 'ABC' }),
            entry({ id: 's2', message: 'miss', correlationId: 'XYZ' })
        ];
        const alTools = makeTools({ getAll: () => al.slice(), count: () => al.length }, fakeBus());
        for (const q of ['correlationId:ABC', 'reqId:ABC', 'requestId:ABC', 'request_id:ABC']) {
            const p2 = parsePayload(await alTools.call('search_logs', { query: q }));
            assert.strictEqual(p2.total, 1, `alias query "${q}" matches by correlationId`);
            assert.strictEqual(p2.entries[0].message, 'hit');
        }
        alTools.dispose();
    }

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
