// Integration tests for TailSession against real temp files: seed, appends,
// ordering under bursts, truncation, rotation and dispose. Stubs 'vscode'
// (only imported for the manager's error dialog / config).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const realLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'vscode') {
        return { workspace: { getConfiguration: () => ({ get: (_k, fallback) => fallback }) }, window: {} };
    }
    return realLoad.call(this, request, ...rest);
};

const { TailSession } = require(path.join('..', 'out', 'core', 'fileTail.js'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(predicate, what, timeoutMs = 5000) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) {
            throw new Error('timed out waiting for ' + what);
        }
        await sleep(25);
    }
}

function startTail(file, seedBytes = 10240) {
    const lines = [];
    let disposed = false;
    const sink = { push: line => { lines.push(line); }, end: () => { } };
    const tail = new TailSession(file, sink, seedBytes, {
        onError: () => { },
        onDispose: () => { disposed = true; }
    });
    tail.start();
    return { tail, lines, isDisposed: () => disposed };
}

async function run() {
    console.log('Running fileTail tests...');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llc-tail-'));
    const file = path.join(dir, 'app.log');

    try {
        // seed: existing content is read; a seed starting mid-file drops the fragment
        fs.writeFileSync(file, 'old line one\nold line two\nold line three\n');
        let t = startTail(file, 20); // last 20 bytes start inside "old line two"
        await waitFor(() => t.lines.length >= 1, 'seed');
        await sleep(100);
        assert.deepStrictEqual(t.lines, ['old line three'], 'partial first seed line dropped: ' + JSON.stringify(t.lines));

        // appends arrive in order, including a burst of many small writes
        for (let i = 0; i < 200; i++) {
            fs.appendFileSync(file, `burst ${i}\n`);
        }
        await waitFor(() => t.lines.length >= 201, 'burst');
        const burst = t.lines.slice(1);
        assert.deepStrictEqual(burst, Array.from({ length: 200 }, (_, i) => `burst ${i}`), 'burst kept in order without duplicates');

        // multi-byte content survives
        fs.appendFileSync(file, 'café 🚀\n');
        await waitFor(() => t.lines.includes('café 🚀'), 'utf8 line');

        // truncation: offset resets and new content is read from the start
        fs.writeFileSync(file, 'after truncate\n');
        await waitFor(() => t.lines.includes('after truncate'), 'post-truncate line');

        // rotation: rename the file away and create a new one at the same path
        fs.renameSync(file, file + '.1');
        await sleep(50);
        fs.writeFileSync(file, 'fresh file line\n');
        await waitFor(() => t.lines.includes('fresh file line'), 'post-rotation line', 6000);
        fs.appendFileSync(file, 'second fresh line\n');
        await waitFor(() => t.lines.includes('second fresh line'), 'append after rotation', 6000);

        // dispose: nothing more is ingested
        t.tail.dispose();
        assert.ok(t.isDisposed());
        const countAtDispose = t.lines.length;
        fs.appendFileSync(file, 'after dispose\n');
        await sleep(1500);
        assert.strictEqual(t.lines.length, countAtDispose, 'no lines after dispose');

        // missing file → error + dispose
        let errorMessage = '';
        const missing = new TailSession(path.join(dir, 'nope.log'), { push: () => { }, end: () => { } }, 0, {
            onError: m => { errorMessage = m; },
            onDispose: () => { }
        });
        missing.start();
        await waitFor(() => errorMessage !== '', 'missing-file error');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log('All fileTail tests passed.');
}

run().then(() => process.exit(0), err => {
    console.error(err);
    process.exit(1);
});
