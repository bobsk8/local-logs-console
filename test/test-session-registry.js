// Tests for SessionRegistry lifecycle + restart (vscode stubbed: only EventEmitter is used).
const assert = require('assert');
const Module = require('module');

const realLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'vscode') {
        return {
            EventEmitter: class {
                constructor() { this.listeners = new Set(); }
                get event() { return l => { this.listeners.add(l); return { dispose: () => this.listeners.delete(l) }; }; }
                fire(v) { for (const l of [...this.listeners]) { l(v); } }
                dispose() { this.listeners.clear(); }
            }
        };
    }
    return realLoad.call(this, request, ...rest);
};

const { SessionRegistry } = require('../out/core/sessionRegistry');

function session(registry, id, label, startedAt, extra = {}) {
    const s = {
        id, kind: 'command', label, startedAt, status: 'running',
        stops: 0, restarts: 0,
        stop() { this.stops++; },
        restart() { this.restarts++; },
        ...extra
    };
    registry.register(s);
    return s;
}

async function run() {
    console.log('Running session registry tests...');

    // ended sessions stay listed; activeCount counts running only
    let r = new SessionRegistry();
    session(r, 'a', 'npm run dev', 1);
    session(r, 'b', 'npm test', 2);
    r.end('b', 'exited', 1);
    assert.strictEqual(r.activeCount, 1);
    assert.strictEqual(r.get('b').exitCode, 1);
    assert.strictEqual(r.latestRestartable().id, 'b', 'most recently started, running or not');
    r.pruneEnded();
    assert.deepStrictEqual(r.getAll().map(s => s.id), ['a']);

    // restarting an ended session: no stop, replaced right away
    r = new SessionRegistry();
    const ended = session(r, 'e', 'npm test', 1);
    r.end('e', 'exited', 0);
    assert.strictEqual(await r.restart('e'), true);
    assert.strictEqual(ended.stops, 0);
    assert.strictEqual(ended.restarts, 1);
    assert.strictEqual(r.get('e'), undefined, 'the old row is replaced by the new run');

    // restarting a running session: stop first, restart once it has ended
    r = new SessionRegistry();
    const running = session(r, 'r', 'npm run dev', 1, {
        stop() { this.stops++; setTimeout(() => r.end('r', 'stopped'), 20); }
    });
    const pending = r.restart('r');
    assert.strictEqual(running.stops, 1);
    assert.strictEqual(running.restarts, 0, 'not restarted while still running');
    assert.strictEqual(await pending, true);
    assert.strictEqual(running.restarts, 1);

    // a process that ignores the stop is restarted after the timeout anyway
    r = new SessionRegistry();
    const stubborn = session(r, 's', 'server', 1);
    assert.strictEqual(await r.restart('s', 30), true);
    assert.strictEqual(stubborn.restarts, 1);

    // sessions without restart(), and unknown ids
    r = new SessionRegistry();
    session(r, 'p', 'pasted', 1, { restart: undefined });
    assert.strictEqual(await r.restart('p'), false);
    assert.strictEqual(await r.restart('nope'), false);
    assert.strictEqual(r.latestRestartable(), undefined);

    console.log('All session registry tests passed.');
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
