// Unit tests for the single ingest path: clean -> redact -> parse -> tag ->
// store + broadcast. Stubs vscode (LogPipeline pulls core/config).
const assert = require('assert');
const Module = require('module');

// ---- stub vscode before requiring modules that import it ----
// getConfiguration returns fallbacks, so redaction defaults (enabled + default
// patterns) are active — exactly the production default.
const fakeVscode = {
    workspace: { getConfiguration: () => ({ get: (key, fallback) => fallback }) },
    Disposable: class { constructor(fn) { this.dispose = fn || (() => { }); } },
    EventEmitter: class {
        constructor() { this.listeners = new Set(); }
        get event() {
            return (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
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

const { LogStore } = require('../out/store/logStore');
const { LogEventBus } = require('../out/events/logEventBus');
const { LogPipeline } = require('../out/core/logPipeline');

function fresh() {
    const store = new LogStore(10000);
    const bus = new LogEventBus();
    const emitted = [];
    bus.onLogReceived(e => emitted.push(e));
    return { store, bus, emitted, pipeline: new LogPipeline(store, bus) };
}

async function run() {
    console.log('Running LogPipeline tests...');

    // ingest: raw plaintext line is cleaned, parsed, stored AND broadcast
    {
        const { store, emitted, pipeline } = fresh();
        const out = pipeline.ingest('hello world');
        assert.ok(out, 'returns the stored entry');
        assert.strictEqual(store.count(), 1);
        assert.strictEqual(store.getAll()[0].message, 'hello world');
        assert.strictEqual(emitted.length, 1, 'broadcast on the bus');
        assert.strictEqual(emitted[0], out, 'the same entry is stored and emitted');
    }

    // ingest: blank / whitespace-only lines are dropped (not stored, not emitted)
    {
        const { store, emitted, pipeline } = fresh();
        assert.strictEqual(pipeline.ingest('   '), null);
        assert.strictEqual(pipeline.ingest(''), null);
        assert.strictEqual(store.count(), 0);
        assert.strictEqual(emitted.length, 0);
    }

    // ingest: ANSI escape codes are stripped before storage (clean step)
    {
        const { store, pipeline } = fresh();
        pipeline.ingest('\x1b[31mred error\x1b[0m');
        assert.strictEqual(store.getAll()[0].message, 'red error', 'ANSI stripped');
    }

    // ingest: redaction runs BEFORE parse — a secret never reaches the store
    {
        const { store, pipeline } = fresh();
        pipeline.ingest('aws_secret_access_key=AKIAIOSFODNN7EXAMPLE');
        const e = store.getAll()[0];
        assert.ok(e.message.includes('[REDACTED]'), 'secret masked');
        assert.ok(!e.message.includes('AKIAIOSFODNN7EXAMPLE'), 'raw secret absent from store');
        assert.strictEqual(e.redacted, true, 'redacted flag set');
    }

    // ingestPrepared: overrideLevel applies to a plaintext line (no marker)
    {
        const { store, pipeline } = fresh();
        pipeline.ingestPrepared('some stderr text', { overrideLevel: 'ERROR' });
        assert.strictEqual(store.getAll()[0].level, 'ERROR');
    }

    // ingestPrepared: an explicit [LVL:x] marker BEATS the stream overrideLevel
    {
        const { store, pipeline } = fresh();
        pipeline.ingestPrepared('[LVL:WARN] careful', { overrideLevel: 'ERROR' });
        const e = store.getAll()[0];
        assert.strictEqual(e.level, 'WARN', 'marker wins over overrideLevel');
        assert.strictEqual(e.message, 'careful');
    }

    // tagging: source override only when the parser left source === 'terminal'
    {
        const { store, pipeline } = fresh();
        // plaintext → parser source is 'terminal' → overridden
        pipeline.ingestPrepared('plain line', { source: 'npm run dev' });
        assert.strictEqual(store.getAll()[0].source, 'npm run dev');
        // JSON with its own source → NOT overridden
        pipeline.ingestPrepared('{"message":"hi","source":"custom-svc"}', { source: 'npm run dev' });
        assert.strictEqual(store.getAll()[1].source, 'custom-svc', 'JSON source preserved');
    }

    // tagging: sessionId and redacted flag are applied from opts
    {
        const { store, pipeline } = fresh();
        pipeline.ingestPrepared('line', { sessionId: 'cmd-7', redacted: true });
        const e = store.getAll()[0];
        assert.strictEqual(e.sessionId, 'cmd-7');
        assert.strictEqual(e.redacted, true);
    }

    // JSON line: level/message/correlation parsed through the pipeline
    {
        const { store, pipeline } = fresh();
        pipeline.ingest('{"level":"error","msg":"db down","req":{"id":"r-1"}}', { sessionId: 'cmd-1' });
        const e = store.getAll()[0];
        assert.strictEqual(e.level, 'ERROR');
        assert.strictEqual(e.message, 'db down');
        assert.strictEqual(e.correlationId, 'r-1', 'req.id correlation flows through ingest');
        assert.strictEqual(e.sessionId, 'cmd-1');
    }

    // redact() helper is exposed for terminal echo and matches ingest behavior
    {
        const { pipeline } = fresh();
        const r = pipeline.redact('token=ghp_1234567890abcdefghijklmnopqrstuvwxyz');
        assert.ok(r.text.includes('[REDACTED]'));
        assert.strictEqual(r.redacted, true);
    }

    // streams: a Node stack trace becomes ONE entry with the frames in `stack`
    {
        const { store, pipeline } = fresh();
        const sink = pipeline.openStream({ source: 'npm run dev', sessionId: 'cmd-1', stream: 'stderr' });
        sink.push('TypeError: x is not a function');
        sink.push('    at handler (/app/a.js:1:1)');
        sink.push('    at next (/app/b.js:2:2)');
        sink.push('back to normal');
        sink.end();
        const all = store.getAll();
        assert.strictEqual(all.length, 2);
        assert.strictEqual(all[0].message, 'TypeError: x is not a function');
        assert.deepStrictEqual(all[0].stack, ['    at handler (/app/a.js:1:1)', '    at next (/app/b.js:2:2)']);
        assert.strictEqual(all[0].level, 'ERROR');
        assert.strictEqual(all[0].stream, 'stderr');
        assert.strictEqual(all[0].source, 'npm run dev');
        assert.strictEqual(all[1].stack, undefined);
        assert.strictEqual(all[1].level, 'INFO', 'stderr lines default to INFO now');
        assert.ok(all[1].seq > all[0].seq, 'seq is monotonic');
    }

    // streams: a Python traceback's message is its exception line, level ERROR
    {
        const { store, pipeline } = fresh();
        const sink = pipeline.openStream({});
        for (const l of ['Traceback (most recent call last):', '  File "/app/w.py", line 4, in run', '    1/0', 'ZeroDivisionError: division by zero']) {
            sink.push(l);
        }
        sink.end();
        const e = store.getAll()[0];
        assert.strictEqual(store.count(), 1);
        assert.strictEqual(e.message, 'ZeroDivisionError: division by zero');
        assert.strictEqual(e.level, 'ERROR');
        assert.strictEqual(e.stack[0], 'Traceback (most recent call last):');
    }

    // streams: push returns the cleaned + redacted text (terminal echo), blank → null
    {
        const { pipeline } = fresh();
        const sink = pipeline.openStream({});
        const echoed = sink.push('\x1b[31mpassword=hunter2\x1b[0m');
        assert.ok(echoed.text.includes('[REDACTED]') && !echoed.text.includes('\x1b'));
        assert.strictEqual(echoed.redacted, true);
        assert.strictEqual(sink.push('   '), null);
    }

    // streams: shouldIngest=false drops events (process being killed)
    {
        const { store, pipeline } = fresh();
        const sink = pipeline.openStream({ shouldIngest: () => false });
        sink.push('noise while stopping');
        sink.end();
        assert.strictEqual(store.count(), 0);
    }

    // streams: a pending event is flushed after the idle timeout, without end()
    await (async () => {
        const { store, pipeline } = fresh();
        const sink = pipeline.openStream({ idleFlushMs: 30 });
        sink.push('last line before silence');
        assert.strictEqual(store.count(), 0, 'held while it could still get a stack');
        await new Promise(r => setTimeout(r, 120));
        assert.strictEqual(store.count(), 1, 'flushed after idle');
    })();

    console.log('All LogPipeline tests passed.');
}

run().catch(err => { console.error(err); process.exit(1); });
