// Unit tests for the LogStore FIFO history (pure — no vscode).
const assert = require('assert');
const { LogStore } = require('../out/store/logStore');

function entry(i) {
    return { id: 'id-' + i, timestamp: '2026-07-03T12:00:00.000Z', level: 'INFO', source: 'api', message: 'line ' + i, raw: { i } };
}

function run() {
    console.log('Running LogStore tests...');

    // add + count + getAll ordering (insertion order preserved)
    let store = new LogStore(() => 10000);
    store.add(entry(0));
    store.add(entry(1));
    store.add(entry(2));
    assert.strictEqual(store.count(), 3);
    assert.deepStrictEqual(store.getAll().map(e => e.message), ['line 0', 'line 1', 'line 2']);

    // getAll returns a COPY of the ARRAY — structural edits don't reach the store
    // (entry objects are shared references; only the array is copied).
    const snapshot = store.getAll();
    snapshot.push(entry(99));
    snapshot.pop();
    snapshot.length = 0;
    assert.strictEqual(store.count(), 3, 'mutating the returned array must not affect the store');
    assert.deepStrictEqual(store.getAll().map(e => e.message), ['line 0', 'line 1', 'line 2']);

    // FIFO cap: oldest dropped first when over the limit
    store = new LogStore(() => 3);
    for (let i = 0; i < 5; i++) { store.add(entry(i)); }
    assert.strictEqual(store.count(), 3);
    assert.deepStrictEqual(store.getAll().map(e => e.message), ['line 2', 'line 3', 'line 4'], 'keeps the newest N');

    // limit is read live from the provider on every add
    let limit = 5;
    store = new LogStore(() => limit);
    for (let i = 0; i < 5; i++) { store.add(entry(i)); }
    assert.strictEqual(store.count(), 5);
    limit = 2; // shrink the limit; next add re-applies it
    store.add(entry(5));
    assert.strictEqual(store.count(), 2, 'shrinking the limit prunes on the next add');
    assert.deepStrictEqual(store.getAll().map(e => e.message), ['line 4', 'line 5']);

    // limit is floored at 1 (Math.max(1, provider()))
    store = new LogStore(() => 0);
    store.add(entry(0));
    store.add(entry(1));
    assert.strictEqual(store.count(), 1, 'limit floored to 1');
    assert.strictEqual(store.getAll()[0].message, 'line 1');

    // negative limit also floored to 1
    store = new LogStore(() => -10);
    store.add(entry(0));
    store.add(entry(1));
    assert.strictEqual(store.count(), 1);

    // clear empties the store
    store = new LogStore(() => 10);
    store.add(entry(0));
    store.add(entry(1));
    store.clear();
    assert.strictEqual(store.count(), 0);
    assert.deepStrictEqual(store.getAll(), []);

    // default limit provider (no arg) keeps entries
    store = new LogStore();
    for (let i = 0; i < 50; i++) { store.add(entry(i)); }
    assert.strictEqual(store.count(), 50);

    console.log('All LogStore tests passed.');
}

run();
