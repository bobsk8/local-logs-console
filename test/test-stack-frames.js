// Unit tests for stack-frame parsing (pure — no vscode).
const assert = require('assert');
const { parseStackFrame, isLibraryFrame, firstAppFrame } = require('../out/shared/stackFrames');

function run() {
    console.log('Running stack frame tests...');

    // Node: named frame with parens
    let f = parseStackFrame('    at UserService.load (/app/src/user.service.ts:42:7)');
    assert.deepStrictEqual(
        { file: f.file, line: f.line, column: f.column, fn: f.fn },
        { file: '/app/src/user.service.ts', line: 42, column: 7, fn: 'UserService.load' }
    );
    const text = '    at UserService.load (/app/src/user.service.ts:42:7)';
    assert.strictEqual(text.slice(f.start, f.end), '/app/src/user.service.ts:42:7');

    // Node: async + Windows path
    f = parseStackFrame('    at async Server.handle (C:\\work\\api\\server.js:10:3)');
    assert.strictEqual(f.file, 'C:\\work\\api\\server.js');
    assert.strictEqual(f.line, 10);

    // Node: anonymous bare frame, file:// URL (ESM)
    f = parseStackFrame('    at file:///home/me/app/index.mjs:5:11');
    assert.strictEqual(f.file, '/home/me/app/index.mjs');
    assert.strictEqual(f.column, 11);
    f = parseStackFrame('    at file:///C:/app/index.mjs:5:11');
    assert.strictEqual(f.file, 'C:/app/index.mjs');

    // Node: relative bare path and webpack URLs
    assert.strictEqual(parseStackFrame('    at ./src/a.js:1:1').file, './src/a.js');
    assert.strictEqual(parseStackFrame('    at fn (webpack:///./src/app.tsx:12:4)').file, './src/app.tsx');

    // Node internals are not clickable
    assert.strictEqual(parseStackFrame('    at processTicksAndRejections (node:internal/process/task_queues:95:5)'), null);
    assert.strictEqual(parseStackFrame('    at new Promise (<anonymous>)'), null);

    // Python
    f = parseStackFrame('  File "/app/views.py", line 42, in handler');
    assert.deepStrictEqual({ file: f.file, line: f.line, fn: f.fn }, { file: '/app/views.py', line: 42, fn: 'handler' });
    assert.strictEqual('  File "/app/views.py", line 42, in handler'.slice(f.start, f.end), '/app/views.py');

    // Java / Kotlin: bare file name
    f = parseStackFrame('\tat com.acme.UserService.load(UserService.java:88)');
    assert.deepStrictEqual({ file: f.file, line: f.line }, { file: 'UserService.java', line: 88 });
    assert.strictEqual(parseStackFrame('\tat java.base/java.lang.Thread.run(Native Method)'), null);

    // .NET
    f = parseStackFrame('   at Acme.Api.Load() in C:\\src\\Api\\Service.cs:line 42');
    assert.deepStrictEqual({ file: f.file, line: f.line }, { file: 'C:\\src\\Api\\Service.cs', line: 42 });

    // Go
    f = parseStackFrame('\t/home/me/app/main.go:42 +0x1d');
    assert.deepStrictEqual({ file: f.file, line: f.line }, { file: '/home/me/app/main.go', line: 42 });

    // Not frames
    assert.strictEqual(parseStackFrame('GET /users 200 3ms'), null);
    assert.strictEqual(parseStackFrame('Error: boom'), null);
    assert.strictEqual(parseStackFrame('at the end of the day: nothing'), null);

    // Library vs app frames
    assert.strictEqual(isLibraryFrame(parseStackFrame('    at x (/app/node_modules/express/lib/router.js:1:1)')), true);
    assert.strictEqual(isLibraryFrame(parseStackFrame('  File "/usr/lib/python3/site-packages/flask/app.py", line 1, in x')), true);
    assert.strictEqual(isLibraryFrame(parseStackFrame('    at x (/app/src/a.ts:1:1)')), false);

    const first = firstAppFrame([
        '    at Layer.handle (/app/node_modules/express/lib/router/layer.js:95:5)',
        '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
        '    at UserService.load (/app/src/user.service.ts:42:7)'
    ]);
    assert.strictEqual(first.file, '/app/src/user.service.ts');
    assert.strictEqual(firstAppFrame(['    at x (/app/node_modules/a/b.js:1:1)']).file, '/app/node_modules/a/b.js');
    assert.strictEqual(firstAppFrame(['no frames here']), null);

    console.log('All stack frame tests passed.');
}

run();
