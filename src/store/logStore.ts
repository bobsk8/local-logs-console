import { LogEntry, LogLevel } from '../models/logEntry';

/**
 * Insertion-ordered list that drops from the front in O(1) amortized —
 * eviction always removes the globally oldest entry, which is the first
 * entry of every index bucket it belongs to.
 */
class Bucket {
    private items: LogEntry[] = [];
    private start = 0;

    push(entry: LogEntry): void {
        this.items.push(entry);
    }

    dropOldest(): void {
        this.start++;
        if (this.start > 1024 && this.start * 2 > this.items.length) {
            this.items = this.items.slice(this.start);
            this.start = 0;
        }
    }

    get size(): number {
        return this.items.length - this.start;
    }

    values(): LogEntry[] {
        return this.items.slice(this.start);
    }
}

function emptyLevelCounts(): Record<LogLevel, number> {
    return { ERROR: 0, WARN: 0, INFO: 0, DEBUG: 0, TRACE: 0 };
}

/**
 * Extension-host log history — the single source of truth consumed by the
 * dashboard, the exporter and the MCP tools. A FIFO ring buffer: adding at
 * capacity overwrites the oldest entry in O(1). The limit is a plain number
 * (no settings read per line); the composition root calls `setLimit()` when
 * `localLogViewer.historyLimit` changes.
 *
 * Maintains lookup indexes (id, correlationId, traceId, sessionId) and level
 * counts alongside the ring so readers never have to scan the history.
 */
export class LogStore {
    private ring: (LogEntry | undefined)[] = [];
    /** Index of the oldest entry. */
    private head = 0;
    private size = 0;
    private limit: number;

    private byId = new Map<string, LogEntry>();
    private byCorrelationId = new Map<string, Bucket>();
    private byTraceId = new Map<string, Bucket>();
    private bySessionId = new Map<string, Bucket>();
    private levels = emptyLevelCounts();
    private readonly clearListeners = new Set<() => void>();

    constructor(limit = 10000) {
        this.limit = Math.max(1, Math.floor(limit) || 1);
    }

    add(log: LogEntry): void {
        if (this.size < this.limit) {
            this.ring[(this.head + this.size) % this.limit] = log;
            this.size++;
        } else {
            const evicted = this.ring[this.head];
            if (evicted) { this.unindex(evicted); }
            this.ring[this.head] = log;
            this.head = (this.head + 1) % this.limit;
        }
        this.index(log);
    }

    /** Applies a new cap, keeping the newest entries. */
    setLimit(limit: number): void {
        const next = Math.max(1, Math.floor(limit) || 1);
        if (next === this.limit) { return; }
        const kept = this.getAll().slice(-next);
        this.limit = next;
        this.rebuild(kept);
    }

    getLimit(): number {
        return this.limit;
    }

    /** Oldest → newest copy of the history. */
    getAll(): LogEntry[] {
        const out = new Array<LogEntry>(this.size);
        for (let i = 0; i < this.size; i++) {
            out[i] = this.ring[(this.head + i) % this.limit] as LogEntry;
        }
        return out;
    }

    findById(id: string): LogEntry | undefined {
        return this.byId.get(id);
    }

    /** Entries sharing a correlation id, oldest → newest. */
    byCorrelation(id: string): LogEntry[] {
        return this.byCorrelationId.get(id)?.values() ?? [];
    }

    /** Entries sharing a trace id, oldest → newest. */
    byTrace(id: string): LogEntry[] {
        return this.byTraceId.get(id)?.values() ?? [];
    }

    /** Entries from one capture session, oldest → newest. */
    bySession(id: string): LogEntry[] {
        return this.bySessionId.get(id)?.values() ?? [];
    }

    levelCounts(): Record<LogLevel, number> {
        return { ...this.levels };
    }

    clear(): void {
        this.rebuild([]);
        for (const listener of this.clearListeners) {
            listener();
        }
    }

    /** Plain callback (not vscode.EventEmitter) so the store stays requireable from plain Node. */
    onDidClear(listener: () => void): { dispose(): void } {
        this.clearListeners.add(listener);
        return { dispose: () => { this.clearListeners.delete(listener); } };
    }

    count(): number {
        return this.size;
    }

    private rebuild(entries: LogEntry[]): void {
        this.ring = entries.slice();
        this.head = 0;
        this.size = entries.length;
        this.byId = new Map();
        this.byCorrelationId = new Map();
        this.byTraceId = new Map();
        this.bySessionId = new Map();
        this.levels = emptyLevelCounts();
        for (const entry of entries) {
            this.index(entry);
        }
    }

    private index(entry: LogEntry): void {
        this.byId.set(entry.id, entry);
        addTo(this.byCorrelationId, entry.correlationId, entry);
        addTo(this.byTraceId, entry.traceId, entry);
        addTo(this.bySessionId, entry.sessionId, entry);
        if (this.levels[entry.level] !== undefined) {
            this.levels[entry.level]++;
        }
    }

    private unindex(entry: LogEntry): void {
        if (this.byId.get(entry.id) === entry) {
            this.byId.delete(entry.id);
        }
        dropFrom(this.byCorrelationId, entry.correlationId);
        dropFrom(this.byTraceId, entry.traceId);
        dropFrom(this.bySessionId, entry.sessionId);
        if (this.levels[entry.level] !== undefined) {
            this.levels[entry.level]--;
        }
    }
}

function addTo(map: Map<string, Bucket>, key: string | undefined, entry: LogEntry): void {
    if (key === undefined) { return; }
    let bucket = map.get(key);
    if (!bucket) {
        bucket = new Bucket();
        map.set(key, bucket);
    }
    bucket.push(entry);
}

function dropFrom(map: Map<string, Bucket>, key: string | undefined): void {
    if (key === undefined) { return; }
    const bucket = map.get(key);
    if (!bucket) { return; }
    bucket.dropOldest();
    if (bucket.size === 0) {
        map.delete(key);
    }
}
