#!/usr/bin/env node
// Host-side ingest benchmark: clean → redact → assemble → parse → store.
// Run after `npm run compile`:   node scripts/bench-ingest.js [lines]
// Target: well above 5,000 lines/s so the extension host never falls behind
// a chatty dev server.
'use strict';

const path = require('path');
const Module = require('module');

const realLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'vscode') {
        return {
            workspace: { getConfiguration: () => ({ get: (_k, fallback) => fallback }) },
            EventEmitter: class {
                constructor() { this.listeners = new Set(); }
                get event() { return l => { this.listeners.add(l); return { dispose: () => this.listeners.delete(l) }; }; }
                fire(v) { for (const l of this.listeners) { l(v); } }
                dispose() { this.listeners.clear(); }
            }
        };
    }
    return realLoad.call(this, request, ...rest);
};

const out = p => path.join(__dirname, '..', 'out', p);
const { LogStore } = require(out('store/logStore.js'));
const { LogEventBus } = require(out('events/logEventBus.js'));
const { LogPipeline } = require(out('core/logPipeline.js'));

const total = Number(process.argv[2]) || 200000;
const samples = [
    JSON.stringify({ level: 30, time: Date.now(), msg: 'request completed', req: { id: 'req-1' }, responseTime: 12 }),
    '\x1b[32m[Nest] 4242  - \x1b[39m11/1/2026, 12:53:23 PM     \x1b[32m    LOG\x1b[39m \x1b[33m[RoutesResolver]\x1b[39m Mapped {/users, GET}',
    'time=2026-11-01T10:00:00Z level=warn msg="slow query" ms=812 request_id=r-9',
    '2026-11-01 10:00:00,123 ERROR worker failed: password=hunter2',
    'TypeError: Cannot read properties of undefined (reading \'id\')',
    '    at UserService.load (/app/user.service.ts:42:7)',
    '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
    'GET /health 200 3ms'
];

const store = new LogStore(100000);
const bus = new LogEventBus();
let emitted = 0;
bus.onLogReceived(() => { emitted++; });
const pipeline = new LogPipeline(store, bus);
const sink = pipeline.openStream({ source: 'bench', sessionId: 'bench-1' });

const started = process.hrtime.bigint();
for (let i = 0; i < total; i++) {
    sink.push(samples[i % samples.length]);
}
sink.end();
const ms = Number(process.hrtime.bigint() - started) / 1e6;

const perSec = Math.round(total / (ms / 1000));
console.log(`${total.toLocaleString()} lines → ${emitted.toLocaleString()} entries in ${ms.toFixed(0)} ms`);
console.log(`${perSec.toLocaleString()} lines/s  (store holds ${store.count().toLocaleString()}, cap ${store.getLimit().toLocaleString()})`);
if (perSec < 5000) {
    console.error('✗ below the 5,000 lines/s target');
    process.exit(1);
}
console.log('✓ above the 5,000 lines/s target');
