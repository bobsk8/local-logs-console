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

    // Unified detectLevel: JSON level field wins
    assert.strictEqual(parser.detectLevel('{"level":"warn","msg":"x"}', 'INFO'), 'WARN');

    // Keyword heuristics, including the DEBUG/TRACE keywords the old parser
    // fallback missed
    assert.strictEqual(parser.detectLevel('Something ERROR happened', 'INFO'), 'ERROR');
    assert.strictEqual(parser.detectLevel('warning: low disk', 'INFO'), 'WARN');
    assert.strictEqual(parser.detectLevel('aviso: verifique', 'INFO'), 'WARN');
    assert.strictEqual(parser.detectLevel('debug: cache hit', 'INFO'), 'DEBUG');
    assert.strictEqual(parser.detectLevel('trace: enter fn', 'INFO'), 'TRACE');
    assert.strictEqual(parser.detectLevel('nothing special', 'WARN'), 'WARN');

    // parseLine plaintext fallback now detects DEBUG/TRACE too
    assert.strictEqual(parser.LogParser.parseLine('DEBUG cache warmed').level, 'DEBUG');
    assert.strictEqual(parser.LogParser.parseLine('TRACE entering handler').level, 'TRACE');

    // [LVL:x] marker still wins and sets the marker flag
    const marked = parser.LogParser.parseLine('[LVL:ERROR] boom');
    assert.strictEqual(marked.level, 'ERROR');
    assert.strictEqual(marked.raw.__hasLevelMarker, true);

    // JSON field aliases
    const aliased = parser.LogParser.parseLine(JSON.stringify({
        status: 'debug', time: '2020-02-02T00:00:00Z', msg: 'hi',
        service: 'api', correlationID: 'c-1', traceId: 't-1'
    }));
    assert.strictEqual(aliased.level, 'DEBUG');
    assert.strictEqual(aliased.timestamp, '2020-02-02T00:00:00Z');
    assert.strictEqual(aliased.message, 'hi');
    assert.strictEqual(aliased.source, 'api');
    assert.strictEqual(aliased.correlationId, 'c-1');
    assert.strictEqual(aliased.traceId, 't-1');

    console.log('All LogParser tests passed.');
}

run();
