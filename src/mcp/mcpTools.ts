// The MCP tool set served to coding agents: read-only views over the log
// history plus one long-poll (wait_for_logs).
//
// HARD RULE: no runtime import of 'vscode' or vscode-importing modules — only
// `import type` (erased at compile time) and structural interfaces, so this
// module stays requireable from plain-Node tests.

import type { LogEntry, LogLevel } from '../models/logEntry';
import type { CaptureSession } from '../core/sessionRegistry';
import { parseQuery, matchesQuery, parseSinceValue, ParsedQuery } from '../shared/search';
import { McpToolDefinition, McpToolResult } from './mcpProtocol';

export interface ReadonlyLogStore {
    getAll(): LogEntry[];
    count(): number;
}

export interface ReadonlyRegistry {
    getAll(): CaptureSession[];
}

export interface LogEventSource {
    onLogReceived(listener: (e: LogEntry) => void): { dispose(): void };
}

export interface McpToolsOptions {
    store: ReadonlyLogStore;
    registry: ReadonlyRegistry;
    bus: LogEventSource;
    historyLimit: () => number;
    /** Injectable clock for deterministic get_errors_since tests. */
    now?: () => Date;
    maxWaiters?: number;
    maxWaitMs?: number;
    debounceMs?: number;
    /** Soft token ceiling for a single entry-returning response (chars/4 estimate). */
    maxResponseTokens?: number;
    /** Per-entry token ceiling; over this, `raw` is dropped and `message` is sliced. */
    maxEntryTokens?: number;
    /** How long an expand handle stays resolvable, in ms. */
    handleTtlMs?: number;
}

export interface McpTools {
    readonly definitions: McpToolDefinition[];
    call(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
    /** Resolves every pending wait_for_logs as timed out (server stop). */
    dispose(): void;
}

const LEVELS: LogLevel[] = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];
const MAX_ENTRIES = 500;
const MAX_WAIT_BATCH = 100;

// Token-awareness guards. The estimator is deliberately coarse (chars/4) — these
// are budget guards for the agent's context, not billing.
const MAX_RESPONSE_TOKENS = 2000;
const MAX_ENTRY_TOKENS = 400;
const HANDLE_TTL_MS = 5 * 60_000;
const MAX_HANDLES = 32;

const SEARCH_GRAMMAR = [
    'Query grammar (clauses are AND-ed):',
    '- term — case-insensitive substring over the whole entry (message + structured payload)',
    '- "a phrase" — quoted phrase, spaces preserved',
    '- field:value — level: / source: / correlationId: / traceId: / message: / sessionId:, or a dotted path into the structured payload (e.g. user.name:alice); value may be quoted: source:"my api"',
    '- after: / before: (aliases since: / until:) — time filters; values: HH:mm(:ss) (today), YYYY-MM-DD, or an ISO date-time',
    '- -clause — negation (works on any clause form)',
    '- /pattern/i — regular expression (length-capped and ReDoS-guarded; unsafe patterns fall back to literal matching)',
    'Examples: `level:error timeout` · `"connection refused" -retry` · `after:14:30 source:api /5\\d\\d/`'
].join('\n');

interface WireEntry {
    /** Only emitted for drill-in tools (get_error_context/expand) — see toWireEntry. */
    id?: string;
    timestamp: string;
    level: LogLevel;
    source: string;
    message: string;
    correlationId?: string;
    traceId?: string;
    sessionId?: string;
    redacted?: boolean;
    raw?: Record<string, unknown>;
    /** True when `raw` was dropped to fit the per-entry token cap. */
    rawOmitted?: boolean;
}

interface WireOptions {
    includeRaw: boolean;
    /** Emit the stable entry id so an agent can address it (get_error_context, expand). */
    includeId?: boolean;
}

function toWireEntry(e: LogEntry, opts: WireOptions): WireEntry {
    const wire: WireEntry = {
        timestamp: e.timestamp,
        level: e.level,
        source: e.source,
        message: e.message
    };
    if (opts.includeId) { wire.id = e.id; }
    if (e.correlationId !== undefined) { wire.correlationId = e.correlationId; }
    if (e.traceId !== undefined) { wire.traceId = e.traceId; }
    if (e.sessionId !== undefined) { wire.sessionId = e.sessionId; }
    if (e.redacted) { wire.redacted = true; }
    if (opts.includeRaw) { wire.raw = e.raw; }
    return wire;
}

function estimateTokens(obj: unknown): number {
    try {
        return Math.ceil(JSON.stringify(obj).length / 4);
    } catch {
        return 0;
    }
}

/**
 * Caps one wire entry to `maxEntryTokens`: first drops `raw` (recording
 * `rawOmitted`), then, if the message alone is still over budget, hard-slices it
 * with a truncation marker. Protects against a single 50 KB JSON line blowing the
 * whole response.
 */
function capEntryTokens(wire: WireEntry, maxEntryTokens: number): WireEntry {
    if (estimateTokens(wire) <= maxEntryTokens) { return wire; }
    if (wire.raw !== undefined) {
        delete wire.raw;
        wire.rawOmitted = true;
        if (estimateTokens(wire) <= maxEntryTokens) { return wire; }
    }
    // message is now the dominant cost — slice it to the remaining char budget.
    const overheadTokens = estimateTokens({ ...wire, message: '' });
    const messageCharBudget = Math.max(0, (maxEntryTokens - overheadTokens) * 4 - 16);
    if (wire.message.length > messageCharBudget) {
        wire.message = wire.message.slice(0, messageCharBudget) + '…[truncated]';
    }
    return wire;
}

function ok(payload: unknown): McpToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structuredContent: payload
    };
}

function fail(message: string): McpToolResult {
    return {
        content: [{ type: 'text', text: message }],
        isError: true
    };
}

// ---- argument readers: clamp/normalize, throw ArgError with corrective text ----

class ArgError extends Error { }

function readInt(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
    const value = args[key];
    if (value === undefined || value === null) { return fallback; }
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) {
        throw new ArgError(`Argument "${key}" must be an integer between ${min} and ${max}.`);
    }
    return Math.max(min, Math.min(max, Math.floor(n)));
}

function readString(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    if (value === undefined || value === null) { return undefined; }
    if (typeof value !== 'string') {
        throw new ArgError(`Argument "${key}" must be a string.`);
    }
    return value;
}

function readBool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
    const value = args[key];
    if (value === undefined || value === null) { return fallback; }
    return value === true || value === 'true';
}

function readLevel(args: Record<string, unknown>, key: string): LogLevel | undefined {
    const value = readString(args, key);
    if (value === undefined) { return undefined; }
    const upper = value.toUpperCase() as LogLevel;
    if (!LEVELS.includes(upper)) {
        throw new ArgError(`Argument "${key}" must be one of ${LEVELS.join(', ')}.`);
    }
    return upper;
}

function readLevels(args: Record<string, unknown>, key: string, fallback: LogLevel[]): LogLevel[] {
    const value = args[key];
    if (value === undefined || value === null) { return fallback; }
    if (!Array.isArray(value)) {
        throw new ArgError(`Argument "${key}" must be an array of levels (${LEVELS.join(', ')}).`);
    }
    return value.map(v => {
        const upper = String(v).toUpperCase() as LogLevel;
        if (!LEVELS.includes(upper)) {
            throw new ArgError(`Invalid level "${String(v)}" — use ${LEVELS.join(', ')}.`);
        }
        return upper;
    });
}

// ---- wait_for_logs plumbing ----

interface Waiter {
    matches(entry: LogEntry): boolean;
    push(entry: LogEntry): void;
    finish(timedOut: boolean): void;
}

export function createMcpTools(opts: McpToolsOptions): McpTools {
    const now = opts.now ?? (() => new Date());
    const maxWaiters = opts.maxWaiters ?? 4;
    const maxWaitMs = opts.maxWaitMs ?? 60_000;
    const debounceMs = opts.debounceMs ?? 300;
    const maxResponseTokens = opts.maxResponseTokens ?? MAX_RESPONSE_TOKENS;
    const maxEntryTokens = opts.maxEntryTokens ?? MAX_ENTRY_TOKENS;
    const handleTtlMs = opts.handleTtlMs ?? HANDLE_TTL_MS;

    const waiters = new Set<Waiter>();
    const busSubscription = opts.bus.onLogReceived(entry => {
        for (const waiter of [...waiters]) {
            if (waiter.matches(entry)) {
                waiter.push(entry);
            }
        }
    });

    // ---- token budget + expand handle cache ----
    // Stateful, but scoped to this closure: createMcpTools() is rebuilt on every
    // server (re)start, so the cache never outlives a server lifetime.
    interface Handle {
        ids: string[];
        includeRaw: boolean;
        includeId: boolean;
        createdAt: number;
        kind: string;
        /** Where the next expand() with no explicit offset resumes. Advances as it paginates. */
        nextOffset: number;
    }
    const handles = new Map<string, Handle>();

    function newHandleKey(): string {
        let key = '';
        do {
            key = 'h_' + Math.random().toString(36).slice(2, 12).padEnd(10, '0');
        } while (handles.has(key));
        return key;
    }

    function registerHandle(handle: Handle): string {
        // Sweep expired handles, then LRU-cap by oldest createdAt.
        const cutoff = now().getTime() - handleTtlMs;
        for (const [key, h] of [...handles]) {
            if (h.createdAt < cutoff) { handles.delete(key); }
        }
        while (handles.size >= MAX_HANDLES) {
            let oldestKey: string | undefined;
            let oldestAt = Infinity;
            for (const [key, h] of handles) {
                if (h.createdAt < oldestAt) { oldestAt = h.createdAt; oldestKey = key; }
            }
            if (oldestKey === undefined) { break; }
            handles.delete(oldestKey);
        }
        const key = newHandleKey();
        handles.set(key, handle);
        return key;
    }

    /**
     * Renders up to a token budget starting at `offset`. Returns the budgeted
     * slice plus, when more remains, a handle the agent can pass to `expand`.
     * `entries` must already be in wire (oldest→newest) order.
     */
    function budgetSlice(
        entries: LogEntry[],
        offset: number,
        wireOpts: WireOptions,
        kind: string,
        countCap: number
    ): { returned: WireEntry[]; nextOffset: number; truncated: boolean; handle?: string } {
        const returned: WireEntry[] = [];
        let tokens = 0;
        let i = offset;
        for (; i < entries.length && returned.length < countCap; i++) {
            const wire = capEntryTokens(toWireEntry(entries[i], wireOpts), maxEntryTokens);
            const cost = estimateTokens(wire);
            if (returned.length > 0 && tokens + cost > maxResponseTokens) { break; }
            returned.push(wire);
            tokens += cost;
        }
        const truncated = i < entries.length;
        let handle: string | undefined;
        if (truncated) {
            handle = registerHandle({
                ids: entries.map(e => e.id),
                includeRaw: wireOpts.includeRaw,
                includeId: wireOpts.includeId ?? false,
                createdAt: now().getTime(),
                kind,
                nextOffset: i
            });
        }
        return { returned, nextOffset: i, truncated, handle };
    }

    const definitions: McpToolDefinition[] = [
        {
            name: 'get_log_stats',
            description: 'Orientation call — use this first. Returns counts by level and by source, the covered time range, the history cap (older entries beyond the cap are dropped), and the currently running captures. All served log content was secret-redacted before storage.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false }
        },
        {
            name: 'get_recent_logs',
            description: 'Return the newest N log entries captured by Local Logs Console (already secret-redacted). Entries are ordered oldest→newest within the returned window. The history is capped — call get_log_stats to see the available range.',
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    count: { type: 'integer', minimum: 1, maximum: MAX_ENTRIES, default: 50 },
                    level: { type: 'string', enum: LEVELS, description: 'Only entries of this severity.' },
                    source: { type: 'string', description: 'Case-insensitive substring match on the entry source (command/file name).' },
                    includeRaw: { type: 'boolean', default: false, description: 'Include each entry\'s full structured payload. Larger responses.' }
                }
            }
        },
        {
            name: 'search_logs',
            description: 'Search the captured log history with an advanced query.\n' + SEARCH_GRAMMAR,
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                required: ['query'],
                properties: {
                    query: { type: 'string', description: 'Query in the grammar described above.' },
                    limit: { type: 'integer', minimum: 1, maximum: MAX_ENTRIES, default: 100 },
                    includeRaw: { type: 'boolean', default: false }
                }
            }
        },
        {
            name: 'get_errors_since',
            description: 'Return error-level entries newer than a point in time. `since` accepts an ISO date-time, YYYY-MM-DD, HH:mm(:ss) (today), or a relative duration like "30s", "5m", "2h", "1d". Typical agent loop: run the app, then get_errors_since {"since":"2m"}.',
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                required: ['since'],
                properties: {
                    since: { type: 'string' },
                    levels: { type: 'array', items: { type: 'string', enum: LEVELS }, default: ['ERROR'] },
                    limit: { type: 'integer', minimum: 1, maximum: MAX_ENTRIES, default: 200 },
                    includeRaw: { type: 'boolean', default: false }
                }
            }
        },
        {
            name: 'list_captures',
            description: 'List the currently running captures (commands being streamed and files being followed).',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false }
        },
        {
            name: 'wait_for_logs',
            description: 'Long-poll: resolves as soon as a new log entry matching the optional query/level arrives (plus any further matches within a short batch window), or with timedOut:true after timeoutMs. Use after triggering an action to catch its log output. Query uses the same grammar as search_logs.',
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    query: { type: 'string', description: 'Same grammar as search_logs. Omit to match any entry.' },
                    level: { type: 'string', enum: LEVELS },
                    timeoutMs: { type: 'integer', minimum: 100, maximum: maxWaitMs, default: 25000 },
                    includeRaw: { type: 'boolean', default: false }
                }
            }
        },
        {
            name: 'get_error_context',
            description: 'Zoom in on ONE error with its surrounding story, pre-filtered and token-budgeted — the fastest way to understand a failure. Give an `errorId` (the `id` field from a get_error_context/expand result) or a `since` value to auto-pick the most recent error. If the error carries a correlation/trace id (auto-detected from correlationId, reqId, req.id, request_id, x-request-id, traceId, trace_id — nestjs-pino/pino-http emit req.id for free), returns every line of that same request; otherwise returns the time-adjacent lines from the same capture. Responses are capped; a `handle` in the result means call `expand` for more. Returned entries include their `id`.',
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    errorId: { type: 'string', description: 'The id of the error entry to anchor on (from a prior result). Provide this OR `since`.' },
                    since: { type: 'string', description: 'Auto-pick the newest error at/after this point: ISO date-time, YYYY-MM-DD, HH:mm(:ss), or a relative duration like "30s","5m","2h","1d". Provide this OR `errorId`.' },
                    before: { type: 'integer', minimum: 0, maximum: 200, default: 20, description: 'Adjacency fallback only: lines before the anchor when it has no correlation id.' },
                    after: { type: 'integer', minimum: 0, maximum: 200, default: 20, description: 'Adjacency fallback only: lines after the anchor when it has no correlation id.' },
                    includeRaw: { type: 'boolean', default: false }
                }
            }
        },
        {
            name: 'expand',
            description: 'Fetch the next slice of a previous truncated result. Pass the `handle` returned by any tool whose result had truncated:true. Returns the next window within the token budget, plus a new `handle` if more remains. Handles expire after a few minutes; entries dropped by the history cap since the original call are reported in `dropped`.',
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                required: ['handle'],
                properties: {
                    handle: { type: 'string', description: 'The handle from a truncated result.' },
                    offset: { type: 'integer', minimum: 0, description: 'Start index into the original result set. Defaults to where the previous slice ended.' },
                    count: { type: 'integer', minimum: 1, maximum: MAX_ENTRIES, description: 'Max entries to return in this slice.' }
                }
            }
        }
    ];

    function getRecentLogs(args: Record<string, unknown>): McpToolResult {
        const count = readInt(args, 'count', 50, 1, MAX_ENTRIES);
        const level = readLevel(args, 'level');
        const source = readString(args, 'source')?.toLowerCase();
        const includeRaw = readBool(args, 'includeRaw', false);

        const matching = opts.store.getAll().filter(e =>
            (!level || e.level === level) &&
            (!source || (e.source || '').toLowerCase().includes(source))
        );
        const entries = matching.slice(-count).map(e => toWireEntry(e, { includeRaw }));
        return ok({ total: matching.length, returned: entries.length, entries });
    }

    function searchLogs(args: Record<string, unknown>): McpToolResult {
        const query = readString(args, 'query');
        if (!query || !query.trim()) {
            return fail('Argument "query" is required. ' + SEARCH_GRAMMAR);
        }
        const limit = readInt(args, 'limit', 100, 1, MAX_ENTRIES);
        const includeRaw = readBool(args, 'includeRaw', false);

        const parsed = parseQuery(query);
        const matching = opts.store.getAll().filter(e => matchesQuery(e, parsed));
        const entries = matching.slice(-limit).map(e => toWireEntry(e, { includeRaw }));
        const payload: Record<string, unknown> = { total: matching.length, returned: entries.length, entries };
        if (parsed.error) {
            payload.queryWarning = parsed.error;
        }
        return ok(payload);
    }

    function getErrorsSince(args: Record<string, unknown>): McpToolResult {
        const since = readString(args, 'since');
        if (!since || !since.trim()) {
            return fail('Argument "since" is required — an ISO date-time, YYYY-MM-DD, HH:mm(:ss), or a relative duration like "30s", "5m", "2h", "1d".');
        }
        const t = parseSinceValue(since, now());
        if (t === null) {
            return fail(`Could not parse "${since}" — use an ISO date-time, YYYY-MM-DD, HH:mm(:ss), or a relative duration like "30s", "5m", "2h", "1d".`);
        }
        const levels = readLevels(args, 'levels', ['ERROR']);
        const limit = readInt(args, 'limit', 200, 1, MAX_ENTRIES);
        const includeRaw = readBool(args, 'includeRaw', false);

        const matching = opts.store.getAll().filter(e => {
            if (!levels.includes(e.level)) { return false; }
            const et = new Date(e.timestamp).getTime();
            return !isNaN(et) && et >= t;
        });
        const entries = matching.slice(-limit).map(e => toWireEntry(e, { includeRaw }));
        return ok({
            sinceResolved: new Date(t).toISOString(),
            total: matching.length,
            returned: entries.length,
            entries
        });
    }

    /** All entries sharing the anchor's correlation/trace id, scoped to a session when known. */
    function collectCorrelated(all: LogEntry[], anchor: LogEntry): LogEntry[] {
        const cid = anchor.correlationId;
        const tid = anchor.traceId;
        return all.filter(e => {
            if (anchor.sessionId !== undefined && e.sessionId !== anchor.sessionId) { return false; }
            return (cid !== undefined && e.correlationId === cid) ||
                (tid !== undefined && e.traceId === tid);
        });
    }

    function getErrorContext(args: Record<string, unknown>): McpToolResult {
        const errorId = readString(args, 'errorId');
        const since = readString(args, 'since');
        if (!errorId && !since) {
            return fail('Provide either "errorId" (from a prior result) or "since" (ISO date-time, YYYY-MM-DD, HH:mm(:ss), or a relative duration like "30s","5m","2h","1d").');
        }
        const before = readInt(args, 'before', 20, 0, 200);
        const after = readInt(args, 'after', 20, 0, 200);
        const includeRaw = readBool(args, 'includeRaw', false);

        const all = opts.store.getAll();

        // Resolve the anchor entry.
        let anchor: LogEntry | undefined;
        if (errorId) {
            anchor = all.find(e => e.id === errorId);
            if (!anchor) {
                return fail(`No entry with id "${errorId}" — it may have been dropped by the history cap. Call get_errors_since or search_logs to get a current id.`);
            }
        } else {
            const t = parseSinceValue(since as string, now());
            if (t === null) {
                return fail(`Could not parse "${since}" — use an ISO date-time, YYYY-MM-DD, HH:mm(:ss), or a relative duration like "30s","5m","2h","1d".`);
            }
            const errorsInWindow = all.filter(e => {
                if (e.level !== 'ERROR') { return false; }
                const et = new Date(e.timestamp).getTime();
                return !isNaN(et) && et >= t;
            });
            anchor = errorsInWindow.length > 0
                ? errorsInWindow[errorsInWindow.length - 1]
                : [...all].reverse().find(e => e.level === 'ERROR');
            if (!anchor) {
                return fail('No ERROR-level entries found. Try get_recent_logs or widen the time window.');
            }
        }

        // Correlation mode, else time-adjacency fallback.
        const hasCorrelation = anchor.correlationId !== undefined || anchor.traceId !== undefined;
        let story: LogEntry[];
        let mode: 'correlation' | 'adjacency';
        if (hasCorrelation) {
            story = collectCorrelated(all, anchor)
                .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
            mode = 'correlation';
        } else {
            const sameSession = anchor.sessionId !== undefined
                ? all.filter(e => e.sessionId === anchor!.sessionId)
                : all;
            const idx = sameSession.findIndex(e => e.id === anchor!.id);
            const from = Math.max(0, idx - before);
            const to = Math.min(sameSession.length, idx + after + 1);
            story = sameSession.slice(from, to);
            mode = 'adjacency';
        }

        const slice = budgetSlice(story, 0, { includeRaw, includeId: true }, 'get_error_context', MAX_ENTRIES);
        const payload: Record<string, unknown> = {
            // Cap the anchor like any other entry so a single huge line can't
            // blow the budget the rest of the response respects.
            anchor: capEntryTokens(toWireEntry(anchor, { includeRaw, includeId: true }), maxEntryTokens),
            mode,
            total: story.length,
            returned: slice.returned.length,
            entries: slice.returned
        };
        if (anchor.correlationId !== undefined) { payload.correlationId = anchor.correlationId; }
        if (anchor.traceId !== undefined) { payload.traceId = anchor.traceId; }
        if (slice.truncated) { payload.truncated = true; payload.handle = slice.handle; payload.nextOffset = slice.nextOffset; }
        return ok(payload);
    }

    function expand(args: Record<string, unknown>): McpToolResult {
        const key = readString(args, 'handle');
        if (!key || !key.trim()) {
            return fail('Argument "handle" is required — pass the handle from a truncated result.');
        }
        const handle = handles.get(key);
        if (!handle) {
            return fail(`Handle "${key}" is unknown or expired. Re-run the original tool to get a fresh result.`);
        }
        const offset = readInt(args, 'offset', handle.nextOffset, 0, handle.ids.length);
        const countCap = readInt(args, 'count', MAX_ENTRIES, 1, MAX_ENTRIES);
        const wireOpts: WireOptions = { includeRaw: handle.includeRaw, includeId: handle.includeId };

        // Walk the frozen id list in its ORIGINAL index space so `nextOffset`
        // stays stable across calls. Re-fetch each id from the live store; ids
        // evicted by the history cap since the snapshot are counted in `dropped`
        // but still consume an index (they don't shift the offset math).
        const byId = new Map(opts.store.getAll().map(e => [e.id, e] as const));
        const returned: WireEntry[] = [];
        let dropped = 0;
        let tokens = 0;
        let i = offset;
        for (; i < handle.ids.length && returned.length < countCap; i++) {
            const entry = byId.get(handle.ids[i]);
            if (!entry) { dropped++; continue; }
            const wire = capEntryTokens(toWireEntry(entry, wireOpts), maxEntryTokens);
            const cost = estimateTokens(wire);
            if (returned.length > 0 && tokens + cost > maxResponseTokens) { break; }
            returned.push(wire);
            tokens += cost;
        }

        // Remember where to resume so a bare expand(handle) keeps paginating.
        handle.nextOffset = i;

        const payload: Record<string, unknown> = {
            total: handle.ids.length,
            offset,
            returned: returned.length,
            entries: returned
        };
        if (dropped > 0) { payload.dropped = dropped; }
        if (i < handle.ids.length) {
            payload.truncated = true;
            payload.handle = key;
            payload.nextOffset = i;
        }
        return ok(payload);
    }

    function getLogStats(): McpToolResult {
        const all = opts.store.getAll();
        const byLevel: Record<string, number> = {};
        const bySourceMap = new Map<string, number>();
        let oldest: string | undefined;
        let newest: string | undefined;
        let oldestMs = Infinity;
        let newestMs = -Infinity;

        for (const e of all) {
            byLevel[e.level] = (byLevel[e.level] ?? 0) + 1;
            const source = e.source || '(unknown)';
            bySourceMap.set(source, (bySourceMap.get(source) ?? 0) + 1);
            const t = new Date(e.timestamp).getTime();
            if (!isNaN(t)) {
                if (t < oldestMs) { oldestMs = t; oldest = e.timestamp; }
                if (t > newestMs) { newestMs = t; newest = e.timestamp; }
            }
        }

        const bySource: Record<string, number> = {};
        [...bySourceMap.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .forEach(([source, count]) => { bySource[source] = count; });

        return ok({
            totalEntries: all.length,
            historyLimit: opts.historyLimit(),
            oldestTimestamp: oldest,
            newestTimestamp: newest,
            byLevel,
            bySource,
            activeCaptures: opts.registry.getAll().map(s => ({
                kind: s.kind,
                label: s.label,
                status: s.status,
                startedAt: new Date(s.startedAt).toISOString()
            }))
        });
    }

    function listCaptures(): McpToolResult {
        const nowMs = now().getTime();
        return ok({
            captures: opts.registry.getAll().map(s => ({
                id: s.id,
                kind: s.kind,
                label: s.label,
                status: s.status,
                startedAt: new Date(s.startedAt).toISOString(),
                uptimeMs: Math.max(0, nowMs - s.startedAt)
            }))
        });
    }

    function waitForLogs(args: Record<string, unknown>): Promise<McpToolResult> {
        const queryText = readString(args, 'query');
        const level = readLevel(args, 'level');
        const timeoutMs = readInt(args, 'timeoutMs', 25_000, 100, maxWaitMs);
        const includeRaw = readBool(args, 'includeRaw', false);

        if (waiters.size >= maxWaiters) {
            return Promise.resolve(fail(`Too many concurrent wait_for_logs calls (max ${maxWaiters}). Retry after one resolves.`));
        }

        const parsed: ParsedQuery | null = queryText && queryText.trim() ? parseQuery(queryText) : null;

        return new Promise<McpToolResult>(resolve => {
            const collected: LogEntry[] = [];
            let batchTimer: ReturnType<typeof setTimeout> | null = null;
            let done = false;

            const timeoutTimer = setTimeout(() => waiter.finish(true), timeoutMs);

            const waiter: Waiter = {
                matches(entry: LogEntry): boolean {
                    if (level && entry.level !== level) { return false; }
                    if (parsed && !matchesQuery(entry, parsed)) { return false; }
                    return true;
                },
                push(entry: LogEntry): void {
                    if (done) { return; }
                    collected.push(entry);
                    if (collected.length >= MAX_WAIT_BATCH) {
                        waiter.finish(false);
                        return;
                    }
                    if (!batchTimer) {
                        batchTimer = setTimeout(() => waiter.finish(false), debounceMs);
                    }
                },
                finish(timedOut: boolean): void {
                    if (done) { return; }
                    done = true;
                    clearTimeout(timeoutTimer);
                    if (batchTimer) { clearTimeout(batchTimer); }
                    waiters.delete(waiter);
                    resolve(ok({
                        timedOut: timedOut && collected.length === 0,
                        matched: collected.length,
                        entries: collected.map(e => toWireEntry(e, { includeRaw }))
                    }));
                }
            };

            waiters.add(waiter);
        });
    }

    return {
        definitions,

        async call(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
            try {
                switch (name) {
                    case 'get_log_stats': return getLogStats();
                    case 'get_recent_logs': return getRecentLogs(args);
                    case 'search_logs': return searchLogs(args);
                    case 'get_errors_since': return getErrorsSince(args);
                    case 'get_error_context': return getErrorContext(args);
                    case 'expand': return expand(args);
                    case 'list_captures': return listCaptures();
                    case 'wait_for_logs': return await waitForLogs(args);
                    default: return fail(`Unknown tool: ${name}`);
                }
            } catch (err) {
                if (err instanceof ArgError) {
                    return fail(err.message);
                }
                throw err;
            }
        },

        dispose(): void {
            busSubscription.dispose();
            handles.clear();
            for (const waiter of [...waiters]) {
                waiter.finish(true);
            }
        }
    };
}
