const assert = require('assert');
const path = require('path');

const { parseQuery, matchesQuery, compileSafeRegex, parseDateTimeValue } = require(path.join('..', 'out', 'test-libs', 'search.js'));

function log(overrides) {
    return Object.assign({
        id: '1',
        timestamp: '2026-01-01T12:00:00.000Z',
        level: 'ERROR',
        source: 'api',
        message: 'connection timeout to db',
        raw: { level: 'error', message: 'connection timeout to db', user: { name: 'Alice' }, code: 504 }
    }, overrides);
}

function run() {
    console.log('Running search tests...');

    // Empty query matches everything
    assert.strictEqual(matchesQuery(log(), parseQuery('')), true);
    assert.strictEqual(matchesQuery(log(), parseQuery('   ')), true);

    // Bare terms are AND-ed
    assert.strictEqual(matchesQuery(log(), parseQuery('timeout connection')), true);
    assert.strictEqual(matchesQuery(log(), parseQuery('timeout nothingelse')), false);

    // Case-insensitive
    assert.strictEqual(matchesQuery(log(), parseQuery('TIMEOUT')), true);

    // Quoted phrase (space preserved)
    assert.strictEqual(matchesQuery(log(), parseQuery('"connection timeout"')), true);
    assert.strictEqual(matchesQuery(log(), parseQuery('"timeout connection"')), false);

    // Negation
    assert.strictEqual(matchesQuery(log(), parseQuery('-nothingelse')), true);
    assert.strictEqual(matchesQuery(log(), parseQuery('-timeout')), false);

    // Field filters — known fields
    assert.strictEqual(matchesQuery(log(), parseQuery('level:error')), true);
    assert.strictEqual(matchesQuery(log(), parseQuery('level:warn')), false);
    assert.strictEqual(matchesQuery(log(), parseQuery('source:api')), true);
    assert.strictEqual(matchesQuery(log(), parseQuery('message:timeout')), true);

    // Field filters — dotted path into raw, case-insensitive keys and values
    assert.strictEqual(matchesQuery(log(), parseQuery('user.name:alice')), true);
    assert.strictEqual(matchesQuery(log(), parseQuery('user.name:bob')), false);
    assert.strictEqual(matchesQuery(log(), parseQuery('code:504')), true);

    // Quoted field value
    const spaced = log({ raw: { service: 'my api', message: 'x' } });
    assert.strictEqual(matchesQuery(spaced, parseQuery('service:"my api"')), true);

    // Negated field
    assert.strictEqual(matchesQuery(log(), parseQuery('-level:warn')), true);
    assert.strictEqual(matchesQuery(log(), parseQuery('-level:error')), false);

    // Combined clauses
    assert.strictEqual(matchesQuery(log(), parseQuery('level:error timeout -user.name:bob')), true);

    // Regex
    assert.strictEqual(matchesQuery(log(), parseQuery('/time.ut/')), true);
    assert.strictEqual(matchesQuery(log(), parseQuery('/^zzz$/')), false);
    assert.strictEqual(matchesQuery(log(), parseQuery('/TIMEOUT/i')), true);

    // Invalid regex falls back to a literal term and reports an error
    const bad = parseQuery('/([/');
    assert.ok(bad.error, 'invalid regex should set error');
    assert.strictEqual(matchesQuery(log({ message: 'found ([ here', raw: { message: 'found ([ here' } }), bad), true);

    // Time filters — log timestamp is 2026-01-01T12:00:00.000Z
    assert.strictEqual(matchesQuery(log(), parseQuery('after:2026-01-01T00:00:00Z')), true);
    assert.strictEqual(matchesQuery(log(), parseQuery('after:2026-01-02T00:00:00Z')), false);
    assert.strictEqual(matchesQuery(log(), parseQuery('before:2026-01-02T00:00:00Z')), true);
    assert.strictEqual(matchesQuery(log(), parseQuery('before:2026-01-01T00:00:00Z')), false);
    assert.strictEqual(matchesQuery(log(), parseQuery('since:2026-01-01T00:00:00Z until:2026-01-01T23:00:00Z')), true);
    assert.strictEqual(matchesQuery(log(), parseQuery('after:2026-01-01T00:00:00Z timeout level:error')), true);

    // Invalid time value reports an error and does not filter
    const badTime = parseQuery('after:notadate');
    assert.ok(badTime.error, 'invalid time should set error');
    assert.strictEqual(matchesQuery(log(), badTime), true, 'invalid time clause is dropped');

    // parseDateTimeValue formats (injected "now" keeps HH:mm deterministic)
    const now = new Date(2026, 0, 15, 10, 0, 0);
    assert.strictEqual(parseDateTimeValue('14:30', now), new Date(2026, 0, 15, 14, 30, 0).getTime());
    assert.strictEqual(parseDateTimeValue('14:30:45', now), new Date(2026, 0, 15, 14, 30, 45).getTime());
    assert.strictEqual(parseDateTimeValue('2026-01-10', now), new Date(2026, 0, 10).getTime());
    assert.strictEqual(parseDateTimeValue('2026-01-10T08:05', now), new Date(2026, 0, 10, 8, 5, 0).getTime());
    assert.strictEqual(parseDateTimeValue('25:00', now), null, 'invalid hour rejected');
    assert.strictEqual(parseDateTimeValue('garbage', now), null);
    assert.strictEqual(parseDateTimeValue('2026-01-01T00:00:00Z', now), Date.parse('2026-01-01T00:00:00Z'), 'ISO with timezone honored');

    // ReDoS guards
    assert.strictEqual(compileSafeRegex('(a+)+$', ''), null, 'nested quantifier rejected');
    assert.strictEqual(compileSafeRegex('(\\d+)*b', ''), null, 'nested star rejected');
    assert.strictEqual(compileSafeRegex('x'.repeat(300), ''), null, 'oversized pattern rejected');
    assert.ok(compileSafeRegex('conn.*out', 'i'), 'benign pattern accepted');
    const unsafe = parseQuery('/(a+)+$/');
    assert.ok(unsafe.error, 'unsafe regex should set error');

    console.log('All search tests passed.');
}

run();
