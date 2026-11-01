#!/usr/bin/env node
// Log scenarios for testing Local Logs Console by hand (F5 → "Sandbox").
// Usage: node demo.js <scenario>   — run with no argument to list scenarios.
// Not shipped in the VSIX (package.json `files` is an allow-list).
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// reader went away (capture stopped, or piped into `head`) — exit quietly
for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', e => { if (e.code === 'EPIPE') { process.exit(0); } });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = line => process.stdout.write(line + '\n');
const err = line => process.stderr.write(line + '\n');
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const reqId = () => 'req-' + Math.random().toString(36).slice(2, 8);

// Pino-style JSON line: numeric level, epoch-ms `time`, req.id for correlation.
function pino(level, msg, extra = {}) {
    out(JSON.stringify({ level, time: Date.now(), pid: process.pid, hostname: 'sandbox', msg, ...extra }));
}

// NestJS default logger line, with the ANSI colors Nest emits on a TTY.
function nest(kind, context, message) {
    const color = { LOG: 32, WARN: 33, ERROR: 31, DEBUG: 35, VERBOSE: 36 }[kind];
    const ts = new Date().toLocaleString('en-US');
    const line = `\x1b[${color}m[Nest] ${process.pid}  - \x1b[39m${ts}     \x1b[${color}m${kind.padStart(7)}\x1b[39m \x1b[33m[${context}]\x1b[39m \x1b[${color}m${message}\x1b[39m`;
    (kind === 'ERROR' ? err : out)(line);
}

const scenarios = {
    async nest() {
        nest('LOG', 'NestFactory', 'Starting Nest application...');
        nest('LOG', 'InstanceLoader', 'AppModule dependencies initialized +12ms');
        nest('LOG', 'RoutesResolver', 'AppController {/}:');
        nest('LOG', 'RouterExplorer', 'Mapped {/users, GET} route +3ms');
        nest('WARN', 'ConfigService', 'DATABASE_URL not set, using sqlite fallback');
        nest('DEBUG', 'UsersService', 'cache warmed with 42 entries');
        nest('ERROR', 'ExceptionsHandler', 'Cannot read properties of undefined (reading \'id\')');
        nest('LOG', 'NestApplication', 'Nest application successfully started +2ms');
    },

    async pino() {
        pino(30, 'server listening', { port: 3000 });
        for (let i = 0; i < 4; i++) {
            const id = reqId();
            pino(30, 'request received', { req: { id, method: 'GET', url: '/users/' + i } });
            pino(20, 'db query', { req: { id }, sql: 'select * from users where id = $1', ms: 3 + i });
            if (i === 2) {
                pino(50, 'request failed', { req: { id }, err: { type: 'TypeError', message: 'user.profile is undefined' } });
            } else {
                pino(30, 'request completed', { req: { id }, res: { statusCode: 200 }, responseTime: 12 + i });
            }
            await sleep(150);
        }
        pino(40, 'slow request', { responseTime: 2300 });
        pino(60, 'fatal: out of memory');
        out(JSON.stringify({ level: 'warning', time: Date.now() / 1000, msg: 'python-style level name + epoch seconds' }));
        out(JSON.stringify({ severity: 'notice', '@timestamp': new Date().toISOString(), message: 'ECS-style fields' }));
        out(JSON.stringify({ level: 'info', status: 500, msg: 'GET /orders → 500 (HTTP status is not a log level)' }));
    },

    async stack() {
        err('Unhandled error while processing request');
        err(new Error('Cannot read properties of undefined (reading \'id\')').stack.replace(/^Error/, 'TypeError'));
        err('Traceback (most recent call last):');
        err('  File "/app/worker.py", line 42, in handle');
        err('    result = compute(payload)');
        err('ZeroDivisionError: division by zero');
        out('java.lang.NullPointerException: user was null');
        out('\tat com.example.UserService.load(UserService.java:88)');
    },

    async unicode() {
        out('café résumé — user Zoë logged in ✅');
        out('日本語のログ行 · émojis 🚀🔥 · ünïcødé');
        // write multi-byte characters split across two chunks on purpose
        const bytes = Buffer.from('split across chunks: naïve café ❤️ 🎉\n', 'utf8');
        const cut = bytes.indexOf(Buffer.from('ï')) + 1; // middle of "ï"
        process.stdout.write(bytes.subarray(0, cut));
        await sleep(120);
        process.stdout.write(bytes.subarray(cut));
    },

    async secrets() {
        const ghToken = ['ghp_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'].join('');
        out('Authorization: Basic dXNlcjpzdXBlcnNlY3JldA==');
        out('Authorization: Bearer abcdef1234567890.signature');
        out(JSON.stringify({ level: 'info', msg: 'login', user: 'bob', password: 123456, apiKey: 'sk-live-123' }));
        out('mysql --user root --password hunter2 --verbose');
        out(`cloning https://${ghToken}@github.com/org/repo.git`);
        out('loading https://cdn.jsdelivr.net/npm/some-package@1.0.0/dist/x.js (must NOT be masked)');
        out('openai usage: {"prompt_tokens":120,"max_tokens":4096} (must NOT be masked)');
    },

    async levels() {
        out('Compiled successfully, 0 errors');            // INFO, not ERROR
        out('Found no errors in 12 files');                // INFO
        out('db failover complete');                       // INFO
        out('registered errorHandler middleware');         // INFO
        out('[INFO] retrying after transient error');      // INFO (prefix wins)
        out('WARNING: disk usage at 91%');                 // WARN
        out('level=debug msg="cache miss" key=user:42');   // DEBUG
        out('TypeError: x is not a function');             // ERROR
        out('3 tests failed');                             // ERROR
        err('npm warn deprecated inflight@1.0.6');         // stderr + "warn" → WARN
    },

    async burst() {
        const total = 15000;
        const started = Date.now();
        const levels = [30, 30, 30, 30, 20, 20, 40, 50, 10];
        for (let i = 0; i < total; i++) {
            pino(pick(levels), `burst line ${i}`, { i, req: { id: reqId() } });
            if (i % 500 === 499) { await sleep(100); } // ~5k lines/s
        }
        out(`burst done: ${total} lines in ${Date.now() - started} ms`);
    },

    async prompt() {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise(resolve => rl.question('Deploy to staging? (y/N) ', resolve));
        rl.close();
        out(`you answered: "${answer}"`);
        out(answer.trim().toLowerCase() === 'y' ? 'deploying… done' : 'cancelled');
    },

    async crash() {
        out('starting job #17');
        await sleep(300);
        out('processing batch 1/3');
        await sleep(300);
        err('fatal: could not connect to redis at 127.0.0.1:6379');
        process.exit(1);
    },

    // Endless realistic stream — use it for Live/scroll/histogram/Stop.
    async live() {
        let stopping = false;
        process.on('SIGINT', () => { stopping = true; });
        process.on('SIGTERM', () => { stopping = true; });
        const routes = ['/users', '/orders', '/health', '/login', '/products/42'];
        pino(30, 'live stream started — press Ctrl+C or use Stop');
        while (!stopping) {
            const id = reqId();
            const route = pick(routes);
            pino(30, `GET ${route}`, { req: { id, method: 'GET', url: route } });
            const roll = Math.random();
            if (roll < 0.06) {
                pino(50, `GET ${route} failed`, { req: { id }, err: { message: 'ECONNRESET' } });
            } else if (roll < 0.15) {
                pino(40, `GET ${route} slow`, { req: { id }, responseTime: 1500 + Math.round(Math.random() * 2000) });
            } else {
                pino(30, `GET ${route} 200`, { req: { id }, responseTime: Math.round(Math.random() * 80) });
            }
            await sleep(150 + Math.random() * 450);
        }
        pino(30, 'shutting down gracefully');
    },

    // Writes logs/app.log and rotates it every 40 lines (rename + recreate).
    async tail() {
        const dir = path.join(__dirname, 'logs');
        const file = path.join(dir, 'app.log');
        fs.mkdirSync(dir, { recursive: true });
        let stopping = false;
        process.on('SIGINT', () => { stopping = true; });
        process.on('SIGTERM', () => { stopping = true; });
        out(`writing ${file} — follow it with "Local Logs Console: Follow Log File"`);
        let n = 0;
        while (!stopping) {
            const level = pick(['INFO', 'INFO', 'INFO', 'DEBUG', 'WARN', 'ERROR']);
            fs.appendFileSync(file, `${new Date().toISOString()} ${level} worker line ${n} — café ✓\n`);
            n++;
            if (n % 40 === 0) {
                fs.renameSync(file, file + '.1');
                fs.writeFileSync(file, `${new Date().toISOString()} INFO log rotated (new file after line ${n})\n`);
                out(`rotated at line ${n}`);
            }
            await sleep(200);
        }
    },

    async all() {
        for (const name of ['nest', 'pino', 'levels', 'unicode', 'secrets', 'stack']) {
            out(`──── scenario: ${name} ────`);
            await scenarios[name]();
            await sleep(400);
        }
        out('──── all scenarios done ────');
    }
};

const name = process.argv[2];
if (!name || !scenarios[name]) {
    out('Scenarios: ' + Object.keys(scenarios).join(', '));
    process.exit(name ? 2 : 0);
}
scenarios[name]().catch(e => { err(String(e && e.stack || e)); process.exit(1); });
