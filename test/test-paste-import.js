const assert = require('assert');
const Module = require('module');

// ---- stub vscode before requiring modules that import it ----
const fakeVscode = {
    workspace: {
        getConfiguration: () => ({
            get: (key, fallback) => fallback
        })
    },
    Disposable: class { constructor(fn) { this.dispose = fn || (() => { }); } },
    EventEmitter: class {
        constructor() { this.listeners = new Set(); }
        get event() {
            return (listener) => {
                this.listeners.add(listener);
                return { dispose: () => this.listeners.delete(listener) };
            };
        }
        fire(value) { for (const l of [...this.listeners]) { l(value); } }
        dispose() { this.listeners.clear(); }
    }
};

const realLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'vscode') { return fakeVscode; }
    return realLoad.call(this, request, ...rest);
};

const { importPastedText } = require('../out/core/pasteImport');
const { LogStore } = require('../out/store/logStore');
const { LogEventBus } = require('../out/events/logEventBus');
const { LogPipeline } = require('../out/core/logPipeline');

function run() {
    console.log('Running paste-import tests...');

    let store, bus, pipeline;

    // Test 1: multi-line text with correct counts
    store = new LogStore(() => 10000);
    bus = new LogEventBus();
    pipeline = new LogPipeline(store, bus);
    const text1 = 'line 1\nline 2\n\nline 4';
    const result1 = importPastedText(pipeline, text1);
    assert.strictEqual(result1.imported, 3);
    assert.strictEqual(result1.skipped, 1); // blank line

    // Test 2: redaction is applied
    store = new LogStore(() => 10000);
    bus = new LogEventBus();
    pipeline = new LogPipeline(store, bus);
    const text2 = 'normal log\naws_secret_access_key=AKIAIOSFODNN7EXAMPLE';
    const result2 = importPastedText(pipeline, text2, 'test');
    assert.strictEqual(result2.imported, 2);
    const entries2 = store.getAll();
    assert.strictEqual(entries2.length, 2);
    const secretLine = entries2.find(e => e.message.includes('[REDACTED]'));
    assert.ok(secretLine && secretLine.redacted);

    // Test 3: JSON lines keep their own source field
    // (JSON parsing with explicit source field)
    store = new LogStore(() => 10000);
    bus = new LogEventBus();
    pipeline = new LogPipeline(store, bus);
    const text3 = '{"message":"test log","level":"info","source":"custom-source"}';
    importPastedText(pipeline, text3, 'pasted');
    const entries3 = store.getAll();
    // Should parse 1 line, source should be from JSON (custom-source), not the label
    assert.strictEqual(entries3.length, 1, 'Should parse 1 JSON line');
    // JSON source takes precedence, so it should be custom-source not pasted
    assert.strictEqual(entries3[0].source, 'custom-source', 'JSON source should be preserved');

    // Test 4: session IDs are unique per paste
    store = new LogStore(() => 10000);
    bus = new LogEventBus();
    pipeline = new LogPipeline(store, bus);
    importPastedText(pipeline, 'line 1\nline 2', 'batch1');
    importPastedText(pipeline, 'line 3\nline 4', 'batch2');
    const entries4 = store.getAll();
    assert.strictEqual(entries4.length, 4);
    assert.ok(entries4[0].sessionId.startsWith('paste-'));
    assert.ok(entries4[1].sessionId.startsWith('paste-'));
    // Lines from the same paste should have the same sessionId
    assert.strictEqual(entries4[0].sessionId, entries4[1].sessionId);
    // Lines from different pastes should have different sessionIds
    assert.notStrictEqual(entries4[0].sessionId, entries4[2].sessionId);
    assert.strictEqual(entries4[2].sessionId, entries4[3].sessionId);

    // Test 5: empty and whitespace-only input
    store = new LogStore(() => 10000);
    bus = new LogEventBus();
    pipeline = new LogPipeline(store, bus);
    const result5 = importPastedText(pipeline, '   \n\n  \n', 'label');
    assert.strictEqual(result5.imported, 0);
    // '   \n\n  \n' splits into 4 lines: ['   ', '', '  ', '']
    assert.strictEqual(result5.skipped, 4);

    // Test 6: uses default label when not provided
    store = new LogStore(() => 10000);
    bus = new LogEventBus();
    pipeline = new LogPipeline(store, bus);
    importPastedText(pipeline, 'test line');
    const entries6 = store.getAll();
    assert.strictEqual(entries6[0].source, 'pasted');

    // Test 7: uses custom label when provided
    store = new LogStore(() => 10000);
    bus = new LogEventBus();
    pipeline = new LogPipeline(store, bus);
    importPastedText(pipeline, 'test line', 'custom');
    const entries7 = store.getAll();
    assert.strictEqual(entries7[0].source, 'custom');

    console.log('All paste-import tests passed.');
}

run();
