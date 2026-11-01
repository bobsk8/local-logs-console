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
    assert.strictEqual(aliased.timestamp, '2020-02-02T00:00:00.000Z');
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

    // Pino/Bunyan numeric epoch time (ms) and other timestamp shapes normalize to ISO
    assert.strictEqual(parse({ level: 30, time: 1730000000000, msg: 'x' }).timestamp, new Date(1730000000000).toISOString());
    assert.strictEqual(parse({ msg: 'x', ts: 1730000000.5 }).timestamp, new Date(1730000000500).toISOString());
    assert.strictEqual(parse({ msg: 'x', '@timestamp': '2026-11-01T10:00:00Z' }).timestamp, '2026-11-01T10:00:00.000Z');
    assert.ok(!isNaN(Date.parse(parse({ msg: 'x', time: 'garbage' }).timestamp)), 'unparseable time falls back to now');

    // level aliases and alternate level fields
    assert.strictEqual(parse({ msg: 'x', level: 'warning' }).level, 'WARN');
    assert.strictEqual(parse({ msg: 'x', level: 'fatal' }).level, 'ERROR');
    assert.strictEqual(parse({ msg: 'x', level: 'CRITICAL' }).level, 'ERROR');
    assert.strictEqual(parse({ msg: 'x', severity: 'notice' }).level, 'INFO');
    assert.strictEqual(parse({ msg: 'x', levelname: 'WARNING' }).level, 'WARN');
    assert.strictEqual(parse({ msg: 'x', '@l': 'Error' }).level, 'ERROR');
    assert.strictEqual(parse({ msg: 'x', log: { level: 'debug' } }).level, 'DEBUG');
    assert.strictEqual(parse({ msg: 'x', level: 'verbose' }).level, 'DEBUG');
    // an HTTP status must not be read as a level
    assert.strictEqual(parse({ msg: 'GET /', status: 500 }).level, 'INFO');
    assert.strictEqual(parse({ msg: 'GET /', status: '404' }).level, 'INFO');

    // object messages are serialized instead of becoming "[object Object]"
    assert.strictEqual(parse({ level: 'info', message: { a: 1 } }).message, '{"a":1}');

    // keyword heuristic: whole words only, negations stay neutral
    assert.strictEqual(parser.detectLevel('Compiled successfully, 0 errors', 'INFO'), 'INFO');
    assert.strictEqual(parser.detectLevel('Found no errors in 12 files', 'INFO'), 'INFO');
    assert.strictEqual(parser.detectLevel('db failover complete', 'INFO'), 'INFO');
    assert.strictEqual(parser.detectLevel('registered errorHandler middleware', 'INFO'), 'INFO');
    assert.strictEqual(parser.detectLevel('TypeError: x is not a function', 'INFO'), 'ERROR');
    assert.strictEqual(parser.detectLevel('java.lang.NullPointerException: null', 'INFO'), 'ERROR');
    assert.strictEqual(parser.detectLevel('3 tests failed', 'INFO'), 'ERROR');
    // a level token in the prefix wins over words later in the line
    assert.strictEqual(parser.detectLevel('[INFO] retrying after error', 'INFO'), 'INFO');
    assert.strictEqual(parser.detectLevel('[Nest] 123  - 11/01/2026, 10:00:00 AM     LOG [RoutesResolver] Mapped', 'ERROR'), 'INFO');
    assert.strictEqual(parser.detectLevel('[Nest] 123  - 11/01/2026, 10:00:00 AM   ERROR [ExceptionsHandler] boom', 'INFO'), 'ERROR');
    assert.strictEqual(parser.detectLevel('time=1 level=warn msg="slow"', 'INFO'), 'WARN');

    // logfmt lines are structured: level, msg, time, correlation
    const lf = parser.LogParser.parseLine('time=2026-11-01T10:00:00Z level=warn msg="slow query" ms=812 request_id=r-9');
    assert.strictEqual(lf.level, 'WARN');
    assert.strictEqual(lf.message, 'slow query');
    assert.strictEqual(lf.timestamp, '2026-11-01T10:00:00.000Z');
    assert.strictEqual(lf.raw.ms, '812');
    assert.strictEqual(lf.correlationId, 'r-9');
    // a URL query string or a sentence with one "=" stays plain text
    assert.strictEqual(parser.LogParser.parseLine('GET /users?id=5&page=2 200').raw.message, 'GET /users?id=5&page=2 200');
    assert.strictEqual(parser.LogParser.parseLine('set retries=3 for the client').message, 'set retries=3 for the client');

    // plain-text lines keep their own printed time
    assert.strictEqual(parser.LogParser.parseLine('2026-11-01 10:00:00,123Z ERROR boom').timestamp, '2026-11-01T10:00:00.123Z');
    assert.strictEqual(parser.LogParser.parseLine('2026-11-01 10:00:00,123Z ERROR boom').level, 'ERROR');
    // receivedAt is the fallback time; defaultLevel the fallback level
    const fixed = parser.LogParser.parseLine('no time here', { receivedAt: 1730000000000, defaultLevel: 'WARN' });
    assert.strictEqual(fixed.timestamp, new Date(1730000000000).toISOString());
    assert.strictEqual(fixed.level, 'WARN');

    console.log('All LogParser tests passed.');
}

run();
