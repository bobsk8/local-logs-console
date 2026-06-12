const assert = require('assert');
const path = require('path');

const parser = require(path.join('..', 'out', 'logParser.js'));

function run() {
    console.log('Running LogParser tests...');

    // JSON line
    const jsonLine = JSON.stringify({ level: 'error', message: 'boom', timestamp: '2020-01-01T00:00:00Z' });
    const parsed1 = parser.LogParser.parseLine(jsonLine);
    assert(parsed1, 'Should parse JSON line');
    assert.strictEqual(parsed1.level, 'ERROR');
    assert.strictEqual(parsed1.message, 'boom');

    // Plain text line
    const textLine = 'Something failed: EXCEPTION occurred';
    const parsed2 = parser.LogParser.parseLine(textLine);
    assert(parsed2, 'Should parse plain text line');
    assert.strictEqual(parsed2.level, 'ERROR');

    // Empty line
    const empty = parser.LogParser.parseLine('   ');
    assert.strictEqual(empty, null);

    console.log('All LogParser tests passed.');
}

run();
