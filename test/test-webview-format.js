// Unit tests for the pure webview formatting helpers (out/test-libs/format.js,
// bundled by `npm run build:test-libs`). DOM-free by contract.
const assert = require('assert');
const { escapeHtml, pad, formatTimestamp, formatClock, formatClockShort } = require('../out/test-libs/format');

function run() {
    console.log('Running webview format tests...');

    // escapeHtml covers all five entities and coerces non-strings
    assert.strictEqual(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
    assert.strictEqual(escapeHtml('plain'), 'plain');
    assert.strictEqual(escapeHtml(42), '42');
    assert.strictEqual(escapeHtml(null), 'null');
    assert.strictEqual(escapeHtml(undefined), 'undefined');
    // no double-escaping surprises: a bare ampersand becomes one entity
    assert.strictEqual(escapeHtml('a & b'), 'a &amp; b');

    // pad
    assert.strictEqual(pad(3), '03');
    assert.strictEqual(pad(30), '30');
    assert.strictEqual(pad(300), '300', 'wider than width returns as-is');
    assert.strictEqual(pad(5, 3), '005');
    assert.strictEqual(pad(0), '00');

    // formatTimestamp — full local date-time with ms; uses a fixed instant.
    // Build the expected string from the same Date so the test is timezone-agnostic.
    const iso = '2026-07-03T12:34:56.078Z';
    const d = new Date(iso);
    const expectFull = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    assert.strictEqual(formatTimestamp(iso), expectFull);
    // invalid input → empty string
    assert.strictEqual(formatTimestamp('not-a-date'), '');

    // formatClock — HH:mm:ss.mmm
    const expectClock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    assert.strictEqual(formatClock(iso), expectClock);
    // invalid input → echoes the original (stringified)
    assert.strictEqual(formatClock('garbage'), 'garbage');
    assert.strictEqual(formatClock(''), '');

    // formatClockShort — HH:mm:ss, no ms
    const expectShort = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    assert.strictEqual(formatClockShort(iso), expectShort);
    assert.strictEqual(formatClockShort('nope'), 'nope');

    // numeric epoch input is accepted
    assert.strictEqual(formatClock(d.getTime()), expectClock);

    console.log('All webview format tests passed.');
}

run();
