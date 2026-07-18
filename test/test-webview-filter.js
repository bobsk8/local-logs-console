// Unit tests for the pure webview filter logic (out/test-libs/filter.js) composed
// with the real search grammar (out/shared/search.js). DOM-free by contract.
const assert = require('assert');
const { matchesBaseFilter, matchesFilter } = require('../out/test-libs/filter');
const { parseQuery } = require('../out/shared/search');

const EMPTY = parseQuery('');

function entry(overrides) {
    return Object.assign({
        id: 'x', timestamp: '2026-07-03T12:00:05.000Z', level: 'INFO',
        source: 'api', message: 'hello world', raw: { message: 'hello world' }
    }, overrides);
}

function run() {
    console.log('Running webview filter tests...');

    const info = entry({ level: 'INFO', message: 'all good', raw: { message: 'all good' } });
    const error = entry({ level: 'ERROR', message: 'boom failed', raw: { message: 'boom failed' } });

    // no active levels → level filter is inert (everything passes the level gate)
    const noLevels = {};
    assert.strictEqual(matchesBaseFilter(info, EMPTY, noLevels), true);
    assert.strictEqual(matchesBaseFilter(error, EMPTY, noLevels), true);

    // an active level restricts to that level (case-insensitive on log.level)
    const onlyError = { error: true };
    assert.strictEqual(matchesBaseFilter(error, EMPTY, onlyError), true);
    assert.strictEqual(matchesBaseFilter(info, EMPTY, onlyError), false);

    // multiple active levels
    const infoOrError = { info: true, error: true };
    assert.strictEqual(matchesBaseFilter(info, EMPTY, infoOrError), true);
    assert.strictEqual(matchesBaseFilter(error, EMPTY, infoOrError), true);

    // a level present-but-false does not count as active
    assert.strictEqual(matchesBaseFilter(info, EMPTY, { error: false }), true, 'all-false map = no active levels');

    // query is ANDed with the level gate
    const qFailed = parseQuery('failed');
    assert.strictEqual(matchesBaseFilter(error, qFailed, noLevels), true);
    assert.strictEqual(matchesBaseFilter(info, qFailed, noLevels), false);
    // level + query together
    assert.strictEqual(matchesBaseFilter(error, qFailed, onlyError), true);
    assert.strictEqual(matchesBaseFilter(error, parseQuery('nomatch'), onlyError), false);

    // ---- matchesFilter: base filter + time window [start, end) ----
    const at05 = entry({ timestamp: '2026-07-03T12:00:05.000Z' });
    const startMs = new Date('2026-07-03T12:00:00.000Z').getTime();
    const endMs = new Date('2026-07-03T12:00:10.000Z').getTime();
    const window = { start: startMs, end: endMs };

    // null time filter → same as base
    assert.strictEqual(matchesFilter(at05, EMPTY, noLevels, null), true);

    // inside the window
    assert.strictEqual(matchesFilter(at05, EMPTY, noLevels, window), true);

    // end is EXCLUSIVE
    const atEnd = entry({ timestamp: '2026-07-03T12:00:10.000Z' });
    assert.strictEqual(matchesFilter(atEnd, EMPTY, noLevels, window), false, 'window end is exclusive');
    // start is INCLUSIVE
    const atStart = entry({ timestamp: '2026-07-03T12:00:00.000Z' });
    assert.strictEqual(matchesFilter(atStart, EMPTY, noLevels, window), true, 'window start is inclusive');
    // before the window
    const before = entry({ timestamp: '2026-07-03T11:59:59.000Z' });
    assert.strictEqual(matchesFilter(before, EMPTY, noLevels, window), false);

    // invalid timestamp is excluded when a window is active
    const bad = entry({ timestamp: 'not-a-date' });
    assert.strictEqual(matchesFilter(bad, EMPTY, noLevels, window), false);

    // failing the base filter short-circuits regardless of time
    assert.strictEqual(matchesFilter(at05, EMPTY, onlyError, window), false, 'base filter gates before time');

    console.log('All webview filter tests passed.');
}

run();
