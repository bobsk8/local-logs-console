// Unit tests for the byte-stream → line splitter (pure — no vscode).
const assert = require('assert');
const { LineSplitter } = require('../out/core/lineSplitter');

function collect(maxLen) {
    const lines = [];
    const splitter = new LineSplitter(l => lines.push(l), maxLen);
    return { lines, splitter };
}

function run() {
    console.log('Running lineSplitter tests...');

    // LF and CRLF, lines spanning chunks
    let { lines, splitter } = collect();
    splitter.push(Buffer.from('first\r\nsec'));
    splitter.push(Buffer.from('ond\nthi'));
    assert.deepStrictEqual(lines, ['first', 'second']);
    splitter.end();
    assert.deepStrictEqual(lines, ['first', 'second', 'thi']);

    // multi-byte UTF-8 split across chunks is reassembled (é = c3 a9, 🚀 = 4 bytes)
    ({ lines, splitter } = collect());
    const bytes = Buffer.from('café 🚀 ok\n', 'utf8');
    for (let i = 0; i < bytes.length; i++) {
        splitter.push(bytes.subarray(i, i + 1));
    }
    assert.deepStrictEqual(lines, ['café 🚀 ok']);

    // bare CR rewrites the line (progress output): keep the last frame
    ({ lines, splitter } = collect());
    splitter.push('progress 10%\rprogress 50%\rprogress 100%\n');
    assert.deepStrictEqual(lines, ['progress 100%']);

    // newline-free stream is flushed at the cap
    ({ lines, splitter } = collect(10));
    splitter.push('x'.repeat(25));
    assert.deepStrictEqual(lines, ['x'.repeat(10), 'x'.repeat(10)]);
    splitter.end();
    assert.strictEqual(lines[2], 'x'.repeat(5));

    // reset drops the partial line
    ({ lines, splitter } = collect());
    splitter.push('stale partial');
    splitter.reset();
    splitter.push('fresh\n');
    assert.deepStrictEqual(lines, ['fresh']);

    console.log('All lineSplitter tests passed.');
}

run();
