// Unit tests for the pure 2.0 webview helpers: delta time, inline attributes,
// match highlighting, view flags / session + bookmark filters, autocomplete.
const assert = require('assert');
const { formatDelta, inlineAttributes, highlightRanges } = require('../out/test-libs/format');
const { matchesFilter, extractViewFlags, similarMessageQuery } = require('../out/test-libs/filter');
const { FieldIndex, suggest, tokenAt } = require('../out/test-libs/suggest');
const { parseQuery } = require('../out/shared/search');

function entry(id, extra = {}) {
    return Object.assign({
        id, timestamp: '2026-11-01T10:00:00.000Z', level: 'INFO', source: 'api', message: 'GET /users 200', raw: {}
    }, extra);
}

function run() {
    console.log('Running webview UI lib tests...');

    // ---- formatDelta ----
    assert.strictEqual(formatDelta(0), '+0ms');
    assert.strictEqual(formatDelta(12.4), '+12ms');
    assert.strictEqual(formatDelta(1400), '+1.4s');
    assert.strictEqual(formatDelta(42000), '+42s');
    assert.strictEqual(formatDelta(125000), '+2m05s');
    assert.strictEqual(formatDelta(3 * 3600000 + 60000), '+3h01m');
    assert.strictEqual(formatDelta(-5), '-5ms');
    assert.strictEqual(formatDelta(NaN), '');

    // ---- inlineAttributes ----
    assert.deepStrictEqual(
        inlineAttributes({ level: 30, time: 1, msg: 'x', pid: 1, hostname: 'h', userId: 42, route: '/users', ok: true, extra: 'z' }),
        [['userId', '42'], ['route', '/users'], ['ok', 'true']]
    );
    assert.deepStrictEqual(inlineAttributes({ req: { id: 1 }, long: 'x'.repeat(80), nl: 'a\nb', empty: '' }), []);
    assert.deepStrictEqual(inlineAttributes(null), []);
    assert.deepStrictEqual(inlineAttributes({ a: 1, b: 2 }, 1), [['a', '1']]);

    // ---- highlightRanges ----
    assert.deepStrictEqual(highlightRanges('GET /users failed for users', ['users']), [[5, 10], [22, 27]]);
    assert.deepStrictEqual(highlightRanges('Timeout ERROR', ['error']), [[8, 13]]);
    // overlapping needles merge
    assert.deepStrictEqual(highlightRanges('database', ['data', 'tab']), [[0, 5]]);
    assert.deepStrictEqual(highlightRanges('abc', []), []);
    assert.deepStrictEqual(highlightRanges('', ['x']), []);

    // ---- view flags ----
    assert.deepStrictEqual(extractViewFlags('is:bookmarked level:error'), { query: 'level:error', bookmarked: true });
    assert.deepStrictEqual(extractViewFlags('timeout is:bookmark'), { query: 'timeout', bookmarked: true });
    assert.deepStrictEqual(extractViewFlags('this:bookmarked'), { query: 'this:bookmarked', bookmarked: false });
    assert.deepStrictEqual(extractViewFlags('plain'), { query: 'plain', bookmarked: false });
    // a field still being typed does not filter anything yet
    assert.deepStrictEqual(extractViewFlags('timeout level:'), { query: 'timeout', bookmarked: false });
    assert.deepStrictEqual(extractViewFlags('-source:" x'), { query: 'x', bookmarked: false });
    assert.deepStrictEqual(extractViewFlags('level:error'), { query: 'level:error', bookmarked: false });
    assert.deepStrictEqual(extractViewFlags('after:14:30'), { query: 'after:14:30', bookmarked: false });

    // ---- similarMessageQuery ----
    assert.strictEqual(similarMessageQuery('GET /users/42 took 31ms'), 'GET "/users/" took', 'path kept up to its variable segment');
    assert.strictEqual(similarMessageQuery('GET /42/x 200'), 'GET', 'nothing stable left in the path');
    assert.strictEqual(similarMessageQuery('[Nest] Mapped {/users, GET} route'), 'Nest Mapped "/users" GET route');
    assert.strictEqual(similarMessageQuery('Usuário não encontrado: 42'), 'Usuário não encontrado');
    assert.strictEqual(similarMessageQuery('order a1b2 failed\n    at x (a.js:1:1)'), 'order failed', 'first line only, ids dropped');
    assert.strictEqual(similarMessageQuery('see docs/api now'), 'see "docs/api" now', 'path-like words stay phrases');
    assert.strictEqual(similarMessageQuery('key=value'), 'key=value');
    assert.strictEqual(similarMessageQuery('42 17 99'), '"42 17 99"', 'nothing stable: phrase fallback');
    assert.strictEqual(similarMessageQuery('error error ERROR'), 'error', 'deduplicated');
    assert.strictEqual(similarMessageQuery(''), '');
    for (const msg of ['a:b c', 'he said "x" ok', 'C:\\path\\to file', '-flag value']) {
        assert.ok(!parseQuery(similarMessageQuery(msg)).error, 'always a valid query: ' + msg);
    }

    // ---- session + bookmark narrowing ----
    const q = parseQuery('');
    const none = { error: false, warn: false, info: false, debug: false, trace: false };
    const a = entry('a', { sessionId: 'cmd-1' });
    const b = entry('b', { sessionId: 'cmd-10' });
    assert.strictEqual(matchesFilter(a, q, none, null, { sessions: new Set(['cmd-1']) }), true);
    assert.strictEqual(matchesFilter(b, q, none, null, { sessions: new Set(['cmd-1']) }), false, 'exact session match, not substring');
    assert.strictEqual(matchesFilter(b, q, none, null, { sessions: new Set() }), true, 'empty set = all sessions');
    assert.strictEqual(matchesFilter(a, q, none, null, { bookmarks: new Set(['a']) }), true);
    assert.strictEqual(matchesFilter(b, q, none, null, { bookmarks: new Set(['a']) }), false);
    assert.strictEqual(matchesFilter(b, q, none, null), true, 'extras are optional');

    // ---- tokenAt ----
    assert.deepStrictEqual(tokenAt('level:er', 8), { start: 0, text: 'level:er' });
    assert.deepStrictEqual(tokenAt('timeout lev', 11), { start: 8, text: 'lev' });
    assert.deepStrictEqual(tokenAt('timeout ', 8), { start: 8, text: '' });
    assert.deepStrictEqual(tokenAt('source:"my a', 12), { start: 0, text: 'source:"my a' });

    // ---- FieldIndex + suggest ----
    const index = new FieldIndex();
    for (let i = 0; i < 5; i++) {
        index.add(entry('r' + i, { raw: { userId: 42, route: '/users', req: { method: 'GET' } } }));
    }
    index.add(entry('w', { level: 'WARN', source: 'worker', raw: { userId: 7, route: '/jobs', note: 'x'.repeat(100) } }));

    assert.ok(index.fields().includes('req.method'), 'nested fields are indexed one level deep');
    assert.deepStrictEqual(index.topValues('userId'), ['42', '7'], 'most frequent value first');
    assert.deepStrictEqual(index.topValues('userid', '7'), ['7'], 'case-insensitive field, prefix filter');
    assert.deepStrictEqual(index.topValues('note'), [], 'long values are not suggested');

    let s = suggest('us', 2, index);
    assert.ok(s.some(x => x.insert === 'userId:' && x.kind === 'field' && x.from === 0 && x.to === 2));
    s = suggest('timeout -sou', 12, index);
    assert.deepStrictEqual(s.map(x => [x.insert, x.from]), [['source:', 9]], 'negation prefix is kept');
    s = suggest('level:w', 7, index);
    assert.deepStrictEqual(s.map(x => x.insert), ['level:warn ']);
    s = suggest('source:', 7, index);
    assert.deepStrictEqual(s.map(x => x.insert), ['source:api ', 'source:worker ']);
    s = suggest('since:', 6, index);
    assert.ok(s.length > 0 && s.every(x => x.kind === 'time'));
    assert.deepStrictEqual(suggest('level:error', 11, index), [], 'an exact value needs no completion');
    assert.deepStrictEqual(suggest('', 0, index), []);
    assert.deepStrictEqual(suggest('/re', 3, index), [], 'no completion inside a regex');
    index.clear();
    assert.deepStrictEqual(index.fields(), []);

    console.log('All webview UI lib tests passed.');
}

run();
