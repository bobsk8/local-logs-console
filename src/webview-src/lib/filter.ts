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

/** Webview-only narrowing that the shared search grammar does not know about. */
export interface ViewFilterExtras {
    /** Only entries from these capture sessions (session chips); null/empty = all. */
    sessions?: ReadonlySet<string> | null;
    /** Only bookmarked entry ids (`is:bookmarked`); null = no bookmark filter. */
    bookmarks?: ReadonlySet<string> | null;
}

/**
 * Level + search query (+ session / bookmark narrowing). Drives the histogram
 * (the volume timeline shows the queried set, independent of the time-range
 * click filter).
 */
export function matchesBaseFilter(log: LogEntry, query: ParsedQuery, activeLevels: LevelFilters, extras?: ViewFilterExtras): boolean {
    const anyLevelActive = Object.values(activeLevels).some(v => v === true);
    const level = (log.level || '').toLowerCase();
    const matchesLevel = !anyLevelActive || !!activeLevels[level];
    if (!matchesLevel) { return false; }
    if (extras) {
        if (extras.sessions && extras.sessions.size > 0 && !(log.sessionId && extras.sessions.has(log.sessionId))) { return false; }
        if (extras.bookmarks && !extras.bookmarks.has(log.id)) { return false; }
    }
    return matchesQuery(log, query);
}

const BOOKMARK_FLAG = /(^|\s)is:bookmark(?:ed)?(?=\s|$)/gi;
/** `level:` / `-source:"` with no value yet — the user is still typing it. */
const INCOMPLETE_FIELD = /(^|\s)-?[A-Za-z_@][A-Za-z0-9_.@-]*:"?(?=\s|$)/g;

/**
 * Splits webview-only flags out of the search text before it reaches the
 * shared grammar (which would read `is:bookmarked` as a raw field lookup),
 * and drops field tokens that have no value yet so the list does not empty
 * out while a filter is being typed.
 */
export function extractViewFlags(input: string): { query: string; bookmarked: boolean } {
    let bookmarked = false;
    const query = input
        .replace(BOOKMARK_FLAG, (_m, lead: string) => {
            bookmarked = true;
            return lead;
        })
        .replace(INCOMPLETE_FIELD, (_m, lead: string) => lead)
        .trim();
    return { query, bookmarked };
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
    timeFilter: TimeFilter | null,
    extras?: ViewFilterExtras
): boolean {
    if (!matchesBaseFilter(log, query, activeLevels, extras)) { return false; }
    if (timeFilter) {
        const t = new Date(log.timestamp).getTime();
        if (isNaN(t) || t < timeFilter.start || t >= timeFilter.end) { return false; }
    }
    return true;
}
