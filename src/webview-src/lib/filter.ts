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

/** Same field-name shape the search grammar accepts as `field:value`. */
const FIELD_NAME = /^[A-Za-z_@][A-Za-z0-9_.@-]*$/;

function quoteSearchValue(value: string): string {
    return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * The search token for "filter by this attribute" (detail panel click).
 * Values are quoted when they contain whitespace, quotes or JSON brackets;
 * keys the grammar can't express fall back to a phrase search on the value.
 */
export function fieldFilterToken(key: string, value: string): string {
    const needsQuotes = value === '' || /[\s"\\]/.test(value) || /^[[{]/.test(value);
    const v = needsQuotes ? quoteSearchValue(value) : value;
    if (!FIELD_NAME.test(key)) {
        return quoteSearchValue(value);
    }
    return `${key}:${v}`;
}

/**
 * After dropping `dropped` entries from the front of logsData, rebases the
 * sorted filtered-index list. `removedVisible` is how many filtered rows
 * vanished (to keep a scrolled-up viewport anchored).
 */
export function rebaseFilteredIndexes(filtered: number[], dropped: number): { indexes: number[]; removedVisible: number } {
    let firstKept = 0;
    while (firstKept < filtered.length && filtered[firstKept] < dropped) {
        firstKept++;
    }
    const indexes = new Array<number>(filtered.length - firstKept);
    for (let i = firstKept; i < filtered.length; i++) {
        indexes[i - firstKept] = filtered[i] - dropped;
    }
    return { indexes, removedVisible: firstKept };
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
