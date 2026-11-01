// Unit tests for the LogStore FIFO ring buffer (pure — no vscode).
const assert = require('assert');
const { LogStore } = require('../out/store/logStore');

function entry(i) {
    return { id: 'id-' + i, timestamp: '2026-07-03T12:00:00.000Z', level: 'INFO', source: 'api', message: 'line ' + i, raw: { i } };
}

const messages = store => store.getAll().map(e => e.message);

function run() {
    console.log('Running LogStore tests...');

    // add + count + getAll ordering (insertion order preserved)
    let store = new LogStore(10000);
    store.add(entry(0));
    store.add(entry(1));
    store.add(entry(2));
    assert.strictEqual(store.count(), 3);
    assert.deepStrictEqual(messages(store), ['line 0', 'line 1', 'line 2']);

    // getAll returns a COPY of the ARRAY — structural edits don't reach the store
    const snapshot = store.getAll();
    snapshot.push(entry(99));
    snapshot.length = 0;
    assert.strictEqual(store.count(), 3, 'mutating the returned array must not affect the store');

    // FIFO cap: oldest dropped first, order stays oldest → newest across wrap-around
    store = new LogStore(3);
    for (let i = 0; i < 5; i++) { store.add(entry(i)); }
    assert.strictEqual(store.count(), 3);
    assert.deepStrictEqual(messages(store), ['line 2', 'line 3', 'line 4'], 'keeps the newest N');
    for (let i = 5; i < 11; i++) { store.add(entry(i)); }
    assert.deepStrictEqual(messages(store), ['line 8', 'line 9', 'line 10'], 'wrap-around keeps order');

    // setLimit shrinks keeping the newest, and grows without losing anything
    store = new LogStore(5);
    for (let i = 0; i < 7; i++) { store.add(entry(i)); } // ring has wrapped
    store.setLimit(2);
    assert.strictEqual(store.getLimit(), 2);
    assert.deepStrictEqual(messages(store), ['line 5', 'line 6']);
    store.setLimit(4);
    store.add(entry(7));
    store.add(entry(8));
    store.add(entry(9));
    assert.deepStrictEqual(messages(store), ['line 6', 'line 7', 'line 8', 'line 9']);

    // limit is floored at 1
    for (const bad of [0, -10, NaN]) {
        store = new LogStore(bad);
        store.add(entry(0));
        store.add(entry(1));
        assert.strictEqual(store.count(), 1, 'limit floored to 1 for ' + bad);
        assert.strictEqual(store.getAll()[0].message, 'line 1');
    }

    // clear empties the store, which keeps working afterwards
    store = new LogStore(3);
    for (let i = 0; i < 5; i++) { store.add(entry(i)); }
    store.clear();
    assert.strictEqual(store.count(), 0);
    assert.deepStrictEqual(store.getAll(), []);
    store.add(entry(42));
    assert.deepStrictEqual(messages(store), ['line 42']);

    // default limit keeps entries
    store = new LogStore();
    for (let i = 0; i < 50; i++) { store.add(entry(i)); }
    assert.strictEqual(store.count(), 50);
    assert.strictEqual(store.getLimit(), 10000);

    // add at capacity is O(1): 200k adds into a 100k ring stays fast
    store = new LogStore(100000);
    const started = Date.now();
    for (let i = 0; i < 200000; i++) { store.add(entry(i)); }
    assert.strictEqual(store.count(), 100000);
    assert.ok(Date.now() - started < 1000, 'ring buffer adds must not be O(n)');

    // indexes: id / correlation / trace / session lookups and level counts
    {
        const s = new LogStore(4);
        const mk = (i, extra) => Object.assign(entry(i), extra);
        s.add(mk(0, { correlationId: 'r1', sessionId: 'cmd-1', level: 'ERROR' }));
        s.add(mk(1, { correlationId: 'r1', traceId: 't1', sessionId: 'cmd-1' }));
        s.add(mk(2, { correlationId: 'r2', sessionId: 'cmd-2', level: 'WARN' }));
        assert.strictEqual(s.findById('id-1').message, 'line 1');
        assert.deepStrictEqual(s.byCorrelation('r1').map(e => e.id), ['id-0', 'id-1']);
        assert.deepStrictEqual(s.byTrace('t1').map(e => e.id), ['id-1']);
        assert.deepStrictEqual(s.bySession('cmd-1').map(e => e.id), ['id-0', 'id-1']);
        assert.deepStrictEqual(s.levelCounts(), { ERROR: 1, WARN: 1, INFO: 1, DEBUG: 0, TRACE: 0 });

        // eviction keeps every index consistent
        s.add(mk(3, { correlationId: 'r1', sessionId: 'cmd-1' }));
        s.add(mk(4, { sessionId: 'cmd-2' })); // evicts id-0 (ERROR, r1, cmd-1)
        assert.strictEqual(s.findById('id-0'), undefined);
        assert.deepStrictEqual(s.byCorrelation('r1').map(e => e.id), ['id-1', 'id-3']);
        assert.deepStrictEqual(s.bySession('cmd-1').map(e => e.id), ['id-1', 'id-3']);
        assert.strictEqual(s.levelCounts().ERROR, 0);
        s.add(mk(5, {}));
        s.add(mk(6, {}));
        s.add(mk(7, {})); // r1 fully evicted
        assert.deepStrictEqual(s.byCorrelation('r1'), []);
        assert.deepStrictEqual(s.byTrace('t1'), []);

        // setLimit / clear rebuild the indexes
        s.setLimit(2);
        assert.deepStrictEqual(s.getAll().map(e => e.id), ['id-6', 'id-7']);
        assert.strictEqual(s.findById('id-5'), undefined);
        s.clear();
        assert.strictEqual(s.findById('id-7'), undefined);
        assert.deepStrictEqual(s.levelCounts().INFO, 0);
    }

    // a long-lived session bucket stays fast and correct through many evictions
    {
        const s = new LogStore(1000);
        for (let i = 0; i < 50000; i++) {
            s.add(Object.assign(entry(i), { sessionId: 'cmd-big' }));
        }
        const session = s.bySession('cmd-big');
        assert.strictEqual(session.length, 1000);
        assert.strictEqual(session[0].id, 'id-49000');
    }

    console.log('All LogStore tests passed.');
}

run();
