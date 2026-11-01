// Pure, DOM-free webview data model — unit-testable with plain Node.
//
// Holds the entries the dashboard shows, mirrors the host's history cap,
// keeps the filtered index list and the per-level counts incrementally, and
// resolves entry ids to indexes in O(1). It mutates the shared state object
// in place so the virtual list and histogram (which read state.logsData /
// state.filteredIndexes) need no knowledge of it.

import { LogEntry } from '../../models/logEntry';
import { rebaseFilteredIndexes } from './filter';

export const LEVEL_KEYS = ['error', 'warn', 'info', 'debug', 'trace'] as const;
export type LevelKey = (typeof LEVEL_KEYS)[number];
export type LevelCounts = Record<LevelKey, number>;

export function emptyLevelCounts(): LevelCounts {
    return { error: 0, warn: 0, info: 0, debug: 0, trace: 0 };
}

export interface ModelState {
    logsData: LogEntry[];
    /** Indexes into logsData that pass the current filter, ascending. */
    filteredIndexes: number[];
    levelCounts: LevelCounts;
    /** History cap mirrored from the host. */
    limit: number;
    totalLogsReceived: number;
    /** Index into logsData of the selected row. */
    selectedIndex: number | null;
}

export interface AppendResult {
    /** Entries dropped from the front to respect the cap. */
    dropped: number;
    /** How many of the dropped entries were visible (to keep a scrolled viewport anchored). */
    removedVisible: number;
}

function levelKey(log: LogEntry): LevelKey | null {
    const l = (log.level || '').toLowerCase();
    return (LEVEL_KEYS as readonly string[]).includes(l) ? l as LevelKey : null;
}

export class LogModel {
    /** id → absolute position (index + base); base grows as the front is trimmed. */
    private positions = new Map<string, number>();
    private base = 0;

    constructor(
        private readonly state: ModelState,
        private matches: (log: LogEntry) => boolean
    ) { }

    /** Replaces the filter predicate (call refilter() after). */
    setFilter(matches: (log: LogEntry) => boolean): void {
        this.matches = matches;
    }

    /** Replaces everything with a history snapshot. */
    load(logs: LogEntry[], limit: number): AppendResult {
        this.state.limit = Math.max(1, limit || this.state.limit);
        this.state.logsData = [];
        this.state.filteredIndexes = [];
        this.state.levelCounts = emptyLevelCounts();
        this.state.selectedIndex = null;
        this.positions = new Map();
        this.base = 0;
        return this.append(logs);
    }

    /** Appends live entries, then trims the front to the cap. */
    append(logs: LogEntry[]): AppendResult {
        const { state } = this;
        const start = state.logsData.length;
        for (let k = 0; k < logs.length; k++) {
            const log = logs[k];
            state.logsData.push(log);
            this.positions.set(log.id, this.base + start + k);
            const key = levelKey(log);
            if (key) { state.levelCounts[key]++; }
            if (this.matches(log)) {
                state.filteredIndexes.push(start + k);
            }
        }
        const result = this.trim();
        state.totalLogsReceived = state.logsData.length;
        return result;
    }

    /** Recomputes the filtered index list from scratch (filter changed). */
    refilter(): void {
        const { state } = this;
        const out: number[] = [];
        for (let i = 0; i < state.logsData.length; i++) {
            if (this.matches(state.logsData[i])) { out.push(i); }
        }
        state.filteredIndexes = out;
    }

    clear(): void {
        this.load([], this.state.limit);
    }

    /** Index of an entry by id, or -1 when it is not (or no longer) loaded. */
    indexOfId(id: string): number {
        const abs = this.positions.get(id);
        if (abs === undefined) { return -1; }
        const idx = abs - this.base;
        return idx >= 0 && idx < this.state.logsData.length && this.state.logsData[idx].id === id ? idx : -1;
    }

    visibleIds(): string[] {
        return this.state.filteredIndexes.map(i => this.state.logsData[i].id);
    }

    private trim(): AppendResult {
        const { state } = this;
        const excess = state.logsData.length - state.limit;
        if (excess <= 0) {
            return { dropped: 0, removedVisible: 0 };
        }
        const removed = state.logsData.splice(0, excess);
        for (const log of removed) {
            const key = levelKey(log);
            if (key) { state.levelCounts[key]--; }
            if (this.positions.get(log.id) !== undefined) {
                this.positions.delete(log.id);
            }
        }
        this.base += excess;
        const { indexes, removedVisible } = rebaseFilteredIndexes(state.filteredIndexes, excess);
        state.filteredIndexes = indexes;
        if (state.selectedIndex != null) {
            state.selectedIndex = state.selectedIndex >= excess ? state.selectedIndex - excess : null;
        }
        return { dropped: excess, removedVisible };
    }
}
