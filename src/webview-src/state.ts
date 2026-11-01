import { LogEntry } from '../models/logEntry';
import { LevelFilters, TimeFilter } from './lib/filter';
import { LEVEL_KEYS, LevelCounts, emptyLevelCounts } from './lib/logModel';
import { SessionSummary } from '../shared/protocol';

export { LevelCounts, emptyLevelCounts };

export const BUFFER = 10;

export type Density = 'comfortable' | 'compact';

/** Time column: wall clock, time since the previous visible line, or since the first one. */
export type TimeMode = 'clock' | 'delta' | 'relative';
export const TIME_MODES: TimeMode[] = ['clock', 'delta', 'relative'];

export const ROW_HEIGHTS: Record<Density, number> = {
    comfortable: 34,
    compact: 26
};

export const LEVELS = LEVEL_KEYS;

export interface UiState {
    logsData: LogEntry[];
    /** History cap mirrored from the host so the webview never outgrows the store. */
    limit: number;
    /** Per-level totals over logsData, maintained incrementally. */
    levelCounts: LevelCounts;
    /** Indexes into logsData that match the current filters. */
    filteredIndexes: number[];
    totalLogsReceived: number;
    activeLevels: LevelFilters;
    /** Index into logsData of the selected row (stable across virtual recycling). */
    selectedIndex: number | null;
    /** Whether the list follows new logs. */
    autoScroll: boolean;
    /** Logs arrived while auto-scroll was paused. */
    newCount: number;
    /** {start,end} ms window — set from the histogram (click or drag). */
    timeFilter: TimeFilter | null;
    /** Whether persisted state was restored on the first history load. */
    restored: boolean;
    /** Whether the first loadHistory has arrived (drives the loading skeleton). */
    historyLoaded: boolean;
    /** Capture sessions (running and ended) as last reported by the host. */
    sessions: SessionSummary[];
    /** Row density; drives rowHeight and the --row-height CSS variable. */
    density: Density;
    rowHeight: number;
    timeMode: TimeMode;
    /** Bookmarked entry ids (`b`, `is:bookmarked`). */
    bookmarks: Set<string>;
    /** Session chips the list is narrowed to; empty = every session. */
    sessionFilter: Set<string>;
    /** `is:bookmarked` is part of the current search. */
    bookmarkOnly: boolean;
}

export function defaultLevels(): LevelFilters {
    return { error: false, warn: false, info: false, debug: false, trace: false };
}

export function createInitialState(): UiState {
    return {
        logsData: [],
        limit: 10000,
        levelCounts: emptyLevelCounts(),
        filteredIndexes: [],
        totalLogsReceived: 0,
        activeLevels: defaultLevels(),
        selectedIndex: null,
        autoScroll: true,
        newCount: 0,
        timeFilter: null,
        restored: false,
        historyLoaded: false,
        sessions: [],
        density: 'comfortable',
        rowHeight: ROW_HEIGHTS.comfortable,
        timeMode: 'clock',
        bookmarks: new Set(),
        sessionFilter: new Set(),
        bookmarkOnly: false
    };
}
