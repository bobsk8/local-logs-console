// Unit tests for the pure webview data model (out/test-libs/logModel.js).
const assert = require('assert');
const { LogModel, emptyLevelCounts } = require('../out/test-libs/logModel');

function entry(i, level = 'INFO') {
    return { id: 'e' + i, timestamp: '2026-07-03T12:00:00.000Z', level, source: 'api', message: 'line ' + i, raw: {} };
}

function freshState(limit = 10000) {
    return { logsData: [], filteredIndexes: [], levelCounts: emptyLevelCounts(), limit, totalLogsReceived: 0, selectedIndex: null };
}

function run() {
    console.log('Running webview model tests...');

    // append keeps filtered indexes and level counts incrementally
    let state = freshState();
    let onlyErrors = false;
    const model = new LogModel(state, log => !onlyErrors || log.level === 'ERROR');
    model.append([entry(0), entry(1, 'ERROR'), entry(2, 'WARN')]);
    assert.deepStrictEqual(state.filteredIndexes, [0, 1, 2]);
    assert.deepStrictEqual(state.levelCounts, { error: 1, warn: 1, info: 1, debug: 0, trace: 0 });
    assert.strictEqual(state.totalLogsReceived, 3);

    // refilter after the predicate changes
    onlyErrors = true;
    model.refilter();
    assert.deepStrictEqual(state.filteredIndexes, [1]);
    assert.deepStrictEqual(model.visibleIds(), ['e1']);
    model.append([entry(3, 'ERROR'), entry(4)]);
    assert.deepStrictEqual(state.filteredIndexes, [1, 3]);

    // cap: the front is trimmed, indexes/counts/selection follow
    state = freshState(3);
    const capped = new LogModel(state, () => true);
    capped.append([entry(0, 'ERROR'), entry(1), entry(2)]);
    state.selectedIndex = 2; // e2
    const res = capped.append([entry(3), entry(4)]);
    assert.deepStrictEqual(res, { dropped: 2, removedVisible: 2 });
    assert.deepStrictEqual(state.logsData.map(e => e.id), ['e2', 'e3', 'e4']);
    assert.deepStrictEqual(state.filteredIndexes, [0, 1, 2]);
    assert.strictEqual(state.levelCounts.error, 0, 'trimmed ERROR uncounted');
    assert.strictEqual(state.levelCounts.info, 3);
    assert.strictEqual(state.selectedIndex, 0, 'selection follows its entry');
    capped.append([entry(5), entry(6), entry(7)]);
    assert.strictEqual(state.selectedIndex, null, 'selection dropped with its entry');

    // id → index survives trimming
    assert.strictEqual(capped.indexOfId('e7'), 2);
    assert.strictEqual(capped.indexOfId('e5'), 0);
    assert.strictEqual(capped.indexOfId('e0'), -1, 'trimmed ids are gone');
    assert.strictEqual(capped.indexOfId('nope'), -1);

    // load replaces everything and applies a new cap
    capped.load([entry(10), entry(11), entry(12), entry(13)], 2);
    assert.strictEqual(state.limit, 2);
    assert.deepStrictEqual(state.logsData.map(e => e.id), ['e12', 'e13']);
    assert.strictEqual(capped.indexOfId('e13'), 1);
    capped.clear();
    assert.strictEqual(state.logsData.length, 0);
    assert.deepStrictEqual(state.levelCounts, emptyLevelCounts());

    // bulk append at the cap stays fast (100k cap, 300k entries in batches)
    state = freshState(100000);
    const big = new LogModel(state, log => log.level === 'ERROR');
    const started = Date.now();
    for (let b = 0; b < 600; b++) {
        const batch = [];
        for (let k = 0; k < 500; k++) { const i = b * 500 + k; batch.push(entry(i, i % 10 === 0 ? 'ERROR' : 'INFO')); }
        big.append(batch);
    }
    assert.strictEqual(state.logsData.length, 100000);
    assert.strictEqual(state.filteredIndexes.length, 10000);
    assert.strictEqual(state.levelCounts.error, 10000);
    const appendMs = Date.now() - started;
    const refilterStart = Date.now();
    big.refilter();
    const refilterMs = Date.now() - refilterStart;
    assert.ok(refilterMs < 200, `refilter of 100k took ${refilterMs} ms`);
    console.log(`  (300k appends at a 100k cap: ${appendMs} ms; refilter 100k: ${refilterMs} ms)`);

    console.log('All webview model tests passed.');
}

run();
