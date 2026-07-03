// Pure, DOM-free filtering logic — unit-testable with plain Node.

import { LogEntry } from '../../models/logEntry';
import { ParsedQuery, matchesQuery } from '../../shared/search';

export interface LevelFilters {
    [level: string]: boolean;
}

export interface TimeFilter {
    start: number;
    end: number;
}

/**
 * Level + search query. Drives the histogram (the volume timeline shows the
 * queried set, independent of the time-range click filter).
 */
export function matchesBaseFilter(log: LogEntry, query: ParsedQuery, activeLevels: LevelFilters): boolean {
    const anyLevelActive = Object.values(activeLevels).some(v => v === true);
    const level = (log.level || '').toLowerCase();
    const matchesLevel = !anyLevelActive || !!activeLevels[level];
    if (!matchesLevel) { return false; }
    return matchesQuery(log, query);
}

/** Base filter + optional time-range window from the histogram. Drives the list. */
export function matchesFilter(
    log: LogEntry,
    query: ParsedQuery,
    activeLevels: LevelFilters,
    timeFilter: TimeFilter | null
): boolean {
    if (!matchesBaseFilter(log, query, activeLevels)) { return false; }
    if (timeFilter) {
        const t = new Date(log.timestamp).getTime();
        if (isNaN(t) || t < timeFilter.start || t >= timeFilter.end) { return false; }
    }
    return true;
}
