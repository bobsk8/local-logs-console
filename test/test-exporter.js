const assert = require('assert');
const path = require('path');

const { serializeLogs, suggestedFileName } = require(path.join('..', 'out', 'export', 'serialize.js'));

function run() {
    console.log('Running exporter tests...');

    const entries = [
        { id: 'a', timestamp: '2026-07-02T12:01:03.123Z', level: 'ERROR', source: 'api', message: 'boom', raw: { message: 'boom' } },
        { id: 'b', timestamp: '2026-07-02T12:01:04.456Z', level: 'INFO', source: 'api', message: 'ok', raw: { message: 'ok' } }
    ];

    // NDJSON: one valid JSON object per line, round-trips
    const ndjson = serializeLogs(entries, 'ndjson');
    const lines = ndjson.split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 2);
    const parsed = lines.map(l => JSON.parse(l));
    assert.strictEqual(parsed[0].id, 'a');
    assert.strictEqual(parsed[1].message, 'ok');
    assert.ok(ndjson.endsWith('\n'), 'ndjson ends with newline');

    // JSON: valid array round-trip
    const json = serializeLogs(entries, 'json');
    const arr = JSON.parse(json);
    assert.strictEqual(arr.length, 2);
    assert.deepStrictEqual(arr[0].raw, { message: 'boom' });

    // Text: level + source + message present per line
    const text = serializeLogs(entries, 'text');
    const textLines = text.split('\n').filter(Boolean);
    assert.strictEqual(textLines.length, 2);
    assert.ok(textLines[0].includes('[ERROR]'), textLines[0]);
    assert.ok(textLines[0].includes('api — boom'), textLines[0]);

    // Empty input
    assert.strictEqual(serializeLogs([], 'ndjson'), '');
    assert.strictEqual(serializeLogs([], 'text'), '');
    assert.strictEqual(JSON.parse(serializeLogs([], 'json')).length, 0);

    // Suggested file names
    const now = new Date(2026, 6, 2, 9, 5, 7);
    assert.strictEqual(suggestedFileName('ndjson', now), 'logs-20260702-090507.ndjson');
    assert.strictEqual(suggestedFileName('json', now), 'logs-20260702-090507.json');
    assert.strictEqual(suggestedFileName('text', now), 'logs-20260702-090507.log');

    console.log('All exporter tests passed.');
}

run();
