---
name: writing-tests
description: Use when adding or extending tests in this extension — a new test/test-*.js suite, more cases for an existing suite, or covering a source module that has none. Covers the plain-Node assertion harness, the compile-before-test rule, the vscode-stub pattern for host modules, testing the pure webview libs, and the fake/injection patterns each layer expects.
---

# Writing tests for Local Logs Console

There is **no test framework**. Tests are plain-Node scripts using the built-in `assert` module. `test/run-all.js` auto-discovers every `test/test-*.js` (alphabetical), runs each in its own `node` process with inherited stdio, and **fails fast** on the first non-zero exit. A new `test-*.js` file is picked up automatically — no registration.

```bash
npm test        # compile + build:test-libs + run-all  ← use this
```

## The one rule that bites everyone: compile before test

Tests `require('../out/...')` — they run against **compiled JS in `out/`**, not `src/`. A source edit is invisible until you recompile. `npm test` runs `npm run compile` first, so always run the full `npm test`. If you loop faster with `node ./test/test-foo.js` directly, you MUST `npm run compile` (and `npm run build:test-libs` for webview libs) first, or you are testing stale code.

## Anatomy of a suite

```js
const assert = require('assert');
const { thing } = require('../out/path/to/module');

function run() {                     // or `async function run()` if you await
    console.log('Running X tests...');
    // ... assert.strictEqual / deepStrictEqual / ok, with a message arg ...
    console.log('All X tests passed.');
}

run();                               // async: run().catch(err => { console.error(err); process.exit(1); });
```

Conventions to match: a `Running …`/`All … passed.` banner pair, `assert.strictEqual(actual, expected, 'message')`, `deepStrictEqual` for arrays/objects, and a descriptive third-arg message on non-obvious asserts. Group unrelated fixtures in their own `{ … }` block so `const` names don't collide. Keep everything deterministic — see below.

## Three module categories, three setups

**1. Pure modules (no `vscode`, no DOM)** — require straight from `out/`. These are the easy, high-value targets: `shared/search`, `shared/regexSafety`, `store/logStore`, `logParser`, `core/redactor`, `core/lineCleaner`, `core/processTree` (`parsePsTable`), `export/serialize`, `mcp/mcpProtocol`, `mcp/mcpTools`, `mcp/mcpSetup`.

**2. Host modules that import `vscode`** (directly or transitively — e.g. anything pulling `core/config`, which imports `vscode`): stub `vscode` via a `Module._load` hook **before** requiring the module under test. Copy the block from `test/test-paste-import.js` (minimal) or `test/test-mcp-server.js` (adds `window`/`commands`/`Uri`/config overrides). The stub only needs the surface the code path actually touches — keep it small.

```js
const Module = require('module');
const fakeVscode = { /* getConfiguration, EventEmitter, Disposable, … */ };
const realLoad = Module._load;
Module._load = (request, ...rest) => request === 'vscode' ? fakeVscode : realLoad.call(Module, request, ...rest);
// ...require the module AFTER installing the hook...
```

**3. Pure webview libs (`src/webview-src/lib/*.ts`)** — bundled by `build:test-libs` to `out/test-libs/*.js` (CJS). Require them from there: `require('../out/test-libs/format')`. They are DOM-free by contract; if you need a `ParsedQuery` for `filter.js`, build it with `parseQuery` from `../out/shared/search` (the bundle is self-contained but only re-exports what the lib file exports).

The MCP tool layer (`mcp/mcpTools`) is injected with structural fakes, never real vscode-backed services — see `makeTools`/`seededStore`/`fakeBus` in `test/test-mcp-tools.js`. Reuse that shape: `store` = `{ getAll, count }`, `registry` = `{ getAll }`, `bus` = `{ onLogReceived }`.

## Determinism (required — flaky tests fail CI on one of three OSes)

- **Never call the real clock.** Inject it: `createMcpTools({ now: () => new Date('2026-07-03T12:05:00Z'), … })`; `parseSinceValue(v, fixedNow)`; `parseDateTimeValue(v, fixedNow)`. Modules that take a `now`/clock injection have it for exactly this reason.
- **Never rely on wall-clock timing.** For time-budgeted async (`wait_for_logs`), drive the fake bus with `bus.emit(...)` and lean on the injected `debounceMs`; assert on the resolved payload, not on elapsed time. Always give async waits a real terminal condition and `dispose()` the tools so pending promises resolve.
- **Timestamps in fixtures are literal ISO strings**, ordered on purpose. Insertion order into the store IS the capture order — several code paths (adjacency windows, `slice(-n)` tails) depend on it, so build fixtures in the order the assertion expects.
- Avoid `Math.random`-dependent assertions. Where the code uses it (e.g. handle keys `h_…`), assert the *shape* (`key.startsWith('h_')`), not the value.

## What good coverage looks like here

For each function under test cover: the happy path, each documented branch/precedence rule, the boundary (empty input, cap/limit exactly hit, `slice` edges), the error/`isError` path with its corrective message, and the "must NOT" invariants the design promises (e.g. secrets stay redacted, `spanId` never becomes `traceId`, browse tools omit `id`, one session's logs don't bleed into another's). A regression test should pin the specific guarantee a fix established so a later refactor can't silently undo it — name it in the message.

Correctness invariants worth a dedicated assert in this repo: redaction runs before parse (a secret never reaches `store.getAll()`); the FIFO `historyLimit` cap; `[LVL:x]` marker beats a stream `overrideLevel`; token/size caps on MCP responses (`maxResponseTokens`/`maxEntryTokens`, the `anchor` field included); `expand` pagination offsets and `dropped` accounting.

## Gotchas

- `out/test-libs/` only exists after `build:test-libs`. `npm test` runs it; a bare `node test/...` does not.
- A suite that throws synchronously at `require` time (e.g. a vscode import with no stub) fails the whole run with a load error — install the stub first.
- `run-all.js` stops at the first failure, so a later suite may not have run at all; scroll up to the first `✗`.
- Keep suites self-contained and side-effect-free across files — each runs in a fresh process, but shared `out/` state (none today) or leftover servers/timers can hang the runner. `dispose()` anything you start.
