import { LogEntry } from '../models/logEntry';
import { LevelFilters, TimeFilter } from './lib/filter';

export const BUFFER = 10;

export type Density = 'comfortable' | 'compact';

export const ROW_HEIGHTS: Record<Density, number> = {
    comfortable: 34,
    compact: 26
};

export const LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const;

export interface UiState {
    logsData: LogEntry[];
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
    /** Row density; drives rowHeight and the --row-height CSS variable. */
    density: Density;
    rowHeight: number;
}

export function defaultLevels(): LevelFilters {
    return { error: false, warn: false, info: false, debug: false, trace: false };
}

export function createInitialState(): UiState {
    return {
        logsData: [],
        filteredIndexes: [],
        totalLogsReceived: 0,
        activeLevels: defaultLevels(),
        selectedIndex: null,
        autoScroll: true,
        newCount: 0,
        timeFilter: null,
        restored: false,
        historyLoaded: false,
        density: 'comfortable',
        rowHeight: ROW_HEIGHTS.comfortable
    };
}
