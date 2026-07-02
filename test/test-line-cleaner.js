const assert = require('assert');
const path = require('path');

const { cleanLine } = require(path.join('..', 'out', 'core', 'lineCleaner.js'));

function run() {
    console.log('Running lineCleaner tests...');

    // ANSI color codes
    assert.strictEqual(cleanLine('\x1B[31merror\x1B[0m happened'), 'error happened');

    // OSC sequences (title set)
    assert.strictEqual(cleanLine('\x1B]0;my title\x07hello'), 'hello');

    // VS Code shell-integration markers
    assert.strictEqual(cleanLine(']633;A\x07prompt'), 'prompt');
    assert.strictEqual(cleanLine(']133;C\x07output'), 'output');

    // Bracketed paste toggles (with and without ESC)
    assert.strictEqual(cleanLine('\x1B[?2004hready'), 'ready');
    assert.strictEqual(cleanLine('[?2004lready'), 'ready');

    // Control characters stripped, trailing whitespace trimmed
    assert.strictEqual(cleanLine('a\x00b\x1Fc   '), 'abc');

    // Plain text passes through
    assert.strictEqual(cleanLine('plain text line'), 'plain text line');

    console.log('All lineCleaner tests passed.');
}

run();
