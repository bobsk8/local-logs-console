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
    timestamp: string;
    level: LogLevel;
    source: string;
    message: string;
    correlationId?: string;
    traceId?: string;
    sessionId?: string;
    redacted?: boolean;
    raw?: Record<string, unknown>;
}

function toWireEntry(e: LogEntry, includeRaw: boolean): WireEntry {
    const wire: WireEntry = {
        timestamp: e.timestamp,
        level: e.level,
        source: e.source,
        message: e.message
    };
    if (e.correlationId !== undefined) { wire.correlationId = e.correlationId; }
    if (e.traceId !== undefined) { wire.traceId = e.traceId; }
    if (e.sessionId !== undefined) { wire.sessionId = e.sessionId; }
    if (e.redacted) { wire.redacted = true; }
    if (includeRaw) { wire.raw = e.raw; }
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

    const waiters = new Set<Waiter>();
    const busSubscription = opts.bus.onLogReceived(entry => {
        for (const waiter of [...waiters]) {
            if (waiter.matches(entry)) {
                waiter.push(entry);
            }
        }
    });

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
        const entries = matching.slice(-count).map(e => toWireEntry(e, includeRaw));
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
        const entries = matching.slice(-limit).map(e => toWireEntry(e, includeRaw));
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
        const entries = matching.slice(-limit).map(e => toWireEntry(e, includeRaw));
        return ok({
            sinceResolved: new Date(t).toISOString(),
            total: matching.length,
            returned: entries.length,
            entries
        });
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
                        entries: collected.map(e => toWireEntry(e, includeRaw))
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
            for (const waiter of [...waiters]) {
                waiter.finish(true);
            }
        }
    };
}
