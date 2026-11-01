// Unit tests for timestamp normalization (pure — no vscode).
const assert = require('assert');
const { normalizeTimestamp, timestampToMs, extractTimestamp } = require('../out/shared/timestamp');

function run() {
    console.log('Running timestamp tests...');

    const ms = 1730000000000;
    const iso = new Date(ms).toISOString();

    // epoch units inferred from magnitude
    assert.strictEqual(normalizeTimestamp(ms), iso);                 // ms (Pino)
    assert.strictEqual(normalizeTimestamp(ms / 1000), iso);          // seconds
    assert.strictEqual(normalizeTimestamp(ms * 1000), iso);          // µs
    assert.strictEqual(normalizeTimestamp(ms * 1e6), iso);           // ns (OTel)
    assert.strictEqual(normalizeTimestamp(String(ms)), iso);         // numeric string

    // ISO strings round-trip to canonical ISO
    assert.strictEqual(normalizeTimestamp('2026-11-01T10:00:00Z'), '2026-11-01T10:00:00.000Z');
    // Python/log4j "YYYY-MM-DD HH:mm:ss,SSS" with an explicit zone
    assert.strictEqual(normalizeTimestamp('2026-11-01 10:00:00,123Z'), '2026-11-01T10:00:00.123Z');
    assert.strictEqual(normalizeTimestamp('2026-11-01 10:00:00.5+0000'), '2026-11-01T10:00:00.500Z');
    // zone-less space form is local time — must at least parse
    assert.ok(timestampToMs('2026-11-01 10:00:00,123') !== null);

    // garbage → null
    assert.strictEqual(normalizeTimestamp('not a date'), null);
    assert.strictEqual(normalizeTimestamp(''), null);
    assert.strictEqual(normalizeTimestamp(-5), null);
    assert.strictEqual(normalizeTimestamp(null), null);
    assert.strictEqual(normalizeTimestamp({}), null);

    // field precedence, skipping fields that do not parse
    assert.strictEqual(extractTimestamp({ time: ms }), iso);
    assert.strictEqual(extractTimestamp({ timestamp: 'nope', time: ms }), iso);
    assert.strictEqual(extractTimestamp({ msg: 'x' }), null);

    // plain-text prefixes
    const { extractTextTimestamp } = require('../out/shared/timestamp');
    const today = new Date(2026, 10, 1, 9, 0, 0);
    assert.strictEqual(extractTextTimestamp('2026-11-01T10:00:00.5Z INFO up'), '2026-11-01T10:00:00.500Z');
    assert.strictEqual(extractTextTimestamp('[2026-11-01 10:00:00,123Z] worker ready'), '2026-11-01T10:00:00.123Z');
    assert.ok(extractTextTimestamp('[Nest] 4242  - 11/01/2026, 12:53:23 PM     LOG [App] up'), 'NestJS prefix');
    assert.strictEqual(
        extractTextTimestamp('14:02:11.123 GET /users', today),
        new Date(2026, 10, 1, 14, 2, 11, 123).toISOString()
    );
    assert.strictEqual(extractTextTimestamp('no timestamp at all'), null);
    assert.strictEqual(extractTextTimestamp('2026-11-01 is a date in prose'), null);

    console.log('All timestamp tests passed.');
}

run();
