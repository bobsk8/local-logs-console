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

    // correlation alias extraction (Node/Nest/Pino field names)
    const parse = (obj) => parser.LogParser.parseLine(JSON.stringify(obj));

    // nested req.id — what nestjs-pino / pino-http emit by default (numeric → coerced)
    assert.strictEqual(parse({ msg: 'x', req: { id: 42 } }).correlationId, '42');
    // flat aliases
    assert.strictEqual(parse({ msg: 'x', reqId: 'r-1' }).correlationId, 'r-1');
    assert.strictEqual(parse({ msg: 'x', requestId: 'r-2' }).correlationId, 'r-2');
    assert.strictEqual(parse({ msg: 'x', request_id: 'r-3' }).correlationId, 'r-3');
    assert.strictEqual(parse({ msg: 'x', 'x-request-id': 'r-4' }).correlationId, 'r-4');
    // traceId alias
    assert.strictEqual(parse({ msg: 'x', trace_id: 't-9' }).traceId, 't-9');

    // precedence: explicit correlationId beats reqId/req.id
    assert.strictEqual(parse({ msg: 'x', correlationId: 'win', reqId: 'lose', req: { id: 'nope' } }).correlationId, 'win');
    // reqId beats nested req.id
    assert.strictEqual(parse({ msg: 'x', reqId: 'flat', req: { id: 'nested' } }).correlationId, 'flat');

    // spanId is a CHILD of a trace — must NOT populate traceId (would shatter grouping)
    assert.strictEqual(parse({ msg: 'x', spanId: 's-1' }).traceId, undefined);
    assert.strictEqual(parse({ msg: 'x', span_id: 's-2' }).traceId, undefined);

    // req without an id, or req not an object, must not throw or set a bogus id
    assert.strictEqual(parse({ msg: 'x', req: { method: 'GET' } }).correlationId, undefined);
    assert.strictEqual(parse({ msg: 'x', req: 'not-an-object' }).correlationId, undefined);

    // no correlation fields → both undefined
    const plainJson = parse({ msg: 'x', level: 'info' });
    assert.strictEqual(plainJson.correlationId, undefined);
    assert.strictEqual(plainJson.traceId, undefined);

    console.log('All LogParser tests passed.');
}

run();
