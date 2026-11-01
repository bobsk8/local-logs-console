// Unit tests for multi-line event assembly (stack traces, tracebacks, dumps).
const assert = require('assert');
const { LineAssembler, continuationLevel, MAX_GROUP_LINES } = require('../out/core/lineAssembler');

function feed(lines, defaultLevel) {
    const asm = new LineAssembler(defaultLevel, () => 1000);
    const events = [];
    for (const line of lines) { events.push(...asm.push(line)); }
    const last = asm.flush();
    if (last) { events.push(last); }
    return events.map(e => [e.head, ...e.continuation]);
}

function run() {
    console.log('Running lineAssembler tests...');

    // Node stack trace groups under its error line; the next plain line starts a new event
    let ev = feed([
        'TypeError: Cannot read properties of undefined (reading \'id\')',
        '    at UserService.load (/app/user.service.ts:42:7)',
        '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
        'server still running'
    ]);
    assert.strictEqual(ev.length, 2);
    assert.strictEqual(ev[0].length, 3);
    assert.deepStrictEqual(ev[1], ['server still running']);

    // Java with Caused by + "... N more"
    ev = feed([
        'java.lang.IllegalStateException: boom',
        '\tat com.example.A.run(A.java:10)',
        'Caused by: java.lang.NullPointerException',
        '\tat com.example.B.go(B.java:5)',
        '\t... 3 more',
        'next'
    ]);
    assert.strictEqual(ev.length, 2);
    assert.strictEqual(ev[0].length, 5);

    // Python traceback: closed by its exception line, which is not indented
    ev = feed([
        'Traceback (most recent call last):',
        '  File "/app/worker.py", line 42, in handle',
        '    result = compute(payload)',
        'ZeroDivisionError: division by zero',
        'worker idle'
    ]);
    assert.strictEqual(ev.length, 2);
    assert.deepStrictEqual(ev[0][3], 'ZeroDivisionError: division by zero');
    assert.deepStrictEqual(ev[1], ['worker idle']);

    // indented lines under an INFO head stay separate (e.g. test reporter output)
    ev = feed(['Users API', '  ✓ creates a user', '  ✓ deletes a user']);
    assert.strictEqual(ev.length, 3, 'INFO + indentation is not a group');

    // ...but under an ERROR head they join
    ev = feed(['ERROR failed to send email', '  to: bob@example.com', '  reason: timeout']);
    assert.strictEqual(ev.length, 1);
    assert.strictEqual(ev[0].length, 3);

    // multi-line object dump (console.log of an object)
    ev = feed(['config loaded {', '  port: 3000,', '  host: \'localhost\'', '}', 'ready']);
    assert.strictEqual(ev.length, 2);
    assert.strictEqual(ev[0].length, 4);
    // a one-line JSON object is not a dump opener
    ev = feed(['{"level":30,"msg":"x"}', '  indented after json']);
    assert.strictEqual(ev.length, 2);

    // frames attach to any head (console.trace prints "Trace: …" then frames)
    ev = feed(['Trace: here', '    at foo (/a.js:1:1)']);
    assert.strictEqual(ev.length, 1);

    // runaway groups are capped
    const many = ['Error: x'];
    for (let i = 0; i < MAX_GROUP_LINES + 50; i++) { many.push('    at f' + i + ' (/a.js:1:1)'); }
    ev = feed(many);
    assert.ok(ev[0].length <= MAX_GROUP_LINES, 'group capped');
    assert.strictEqual(ev.reduce((n, e) => n + e.length, 0), many.length, 'no line lost');

    // redaction flag propagates from any line of the group
    const asm = new LineAssembler('INFO', () => 5);
    asm.push('Error: auth failed', false);
    asm.push('    at login (token=[REDACTED])', true);
    const grouped = asm.flush();
    assert.strictEqual(grouped.redacted, true);
    assert.strictEqual(grouped.receivedAt, 5);
    assert.strictEqual(asm.flush(), null);

    // continuation level picks up the exception line severity
    assert.strictEqual(continuationLevel(['  File "x.py", line 1', 'ValueError: bad']), 'ERROR');
    assert.strictEqual(continuationLevel(['    at foo (/a.js:1:1)']), null);

    console.log('All lineAssembler tests passed.');
}

run();
