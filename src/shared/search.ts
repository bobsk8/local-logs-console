// Pure, DOM-free advanced-search engine — unit-testable with plain Node.
//
// Query grammar (clauses are AND-ed):
//   term            case-insensitive substring over the whole entry
//   "a phrase"      quoted phrase (spaces preserved)
//   field:value     level: / source: / correlationId: / traceId: / message:,
//                   or a dotted path into raw (e.g. user.name:alice);
//                   value may be quoted: source:"my api"
//   after:14:30     time filters (aliases: since / before / until); values:
//                   HH:mm(:ss) (today), YYYY-MM-DD, or ISO date-time
//   -clause         negation (works on any clause form)
//   /pattern/i      regular expression (guarded against ReDoS)

import { LogEntry } from '../models/logEntry';

export type ClauseType = 'term' | 'phrase' | 'field' | 'regex' | 'time';

export interface SearchClause {
    type: ClauseType;
    negated: boolean;
    /** Lowercased needle for term/phrase/field; original source for regex/time. */
    value: string;
    /** Field name (lowercased) for field clauses. */
    field?: string;
    /** Compiled pattern for regex clauses. */
    regex?: RegExp;
    /** Direction for time clauses. */
    op?: 'after' | 'before';
    /** Boundary in epoch ms for time clauses. */
    timeMs?: number;
}

export interface ParsedQuery {
    clauses: SearchClause[];
    /** Human-readable problem (e.g. unsafe regex fell back to literal), or null. */
    error: string | null;
}

// Implementation moved to regexSafety.ts; import and reexport for backward compatibility
import { compileSafeRegex, MAX_REGEX_LENGTH } from './regexSafety';
export { compileSafeRegex, MAX_REGEX_LENGTH };

const FIELD_HEAD = /^[A-Za-z_][A-Za-z0-9_.]*$/;

const TIME_FIELDS: Record<string, 'after' | 'before'> = {
    after: 'after',
    since: 'after',
    before: 'before',
    until: 'before'
};

/**
 * Parses a date/time filter value into epoch ms. Accepts `HH:mm(:ss)` (taken
 * as today, via `now`), `YYYY-MM-DD` (local midnight), `YYYY-MM-DD HH:mm(:ss)`
 * / ISO date-times, or anything Date.parse understands. Returns null when
 * unparseable. `now` is injectable for tests.
 */
export function parseDateTimeValue(value: string, now: Date = new Date()): number | null {
    const v = value.trim();
    if (!v) { return null; }

    const clock = v.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (clock) {
        const h = Number(clock[1]);
        const m = Number(clock[2]);
        const s = Number(clock[3] ?? 0);
        if (h > 23 || m > 59 || s > 59) { return null; }
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, s).getTime();
    }

    const dateOnly = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnly) {
        return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])).getTime();
    }

    // Local date-time without timezone (space or T separator)
    const local = v.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (local) {
        return new Date(
            Number(local[1]), Number(local[2]) - 1, Number(local[3]),
            Number(local[4]), Number(local[5]), Number(local[6] ?? 0)
        ).getTime();
    }

    const parsed = Date.parse(v);
    return isNaN(parsed) ? null : parsed;
}

const RELATIVE_UNIT_MS: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000
};

/**
 * Parses a "since" value into epoch ms: relative durations like "30s", "5m",
 * "2h", "1d", "500ms" (relative to `now`), or anything parseDateTimeValue
 * accepts. Returns null when unparseable. `now` is injectable for tests.
 */
export function parseSinceValue(value: string, now: Date = new Date()): number | null {
    const v = String(value || '').trim();
    const relative = v.match(/^(\d+)\s*(ms|s|m|h|d)$/i);
    if (relative) {
        const amount = Number(relative[1]);
        const unit = RELATIVE_UNIT_MS[relative[2].toLowerCase()];
        return now.getTime() - amount * unit;
    }
    return parseDateTimeValue(v, now);
}

export function parseQuery(input: string): ParsedQuery {
    const clauses: SearchClause[] = [];
    let error: string | null = null;
    const text = String(input || '');
    let i = 0;

    const readQuoted = (): string | null => {
        // caller guarantees text[i] === '"'
        let out = '';
        i++;
        while (i < text.length) {
            const ch = text[i];
            if (ch === '\\' && i + 1 < text.length) {
                out += text[i + 1];
                i += 2;
                continue;
            }
            if (ch === '"') {
                i++;
                return out;
            }
            out += ch;
            i++;
        }
        return out; // unterminated quote — treat the rest as the phrase
    };

    while (i < text.length) {
        while (i < text.length && /\s/.test(text[i])) { i++; }
        if (i >= text.length) { break; }

        let negated = false;
        if (text[i] === '-' && i + 1 < text.length && !/\s/.test(text[i + 1])) {
            negated = true;
            i++;
        }

        if (text[i] === '"') {
            const phrase = readQuoted();
            if (phrase && phrase.trim()) {
                clauses.push({ type: 'phrase', negated, value: phrase.toLowerCase() });
            }
            continue;
        }

        if (text[i] === '/') {
            const end = text.indexOf('/', i + 1);
            if (end > i) {
                const source = text.slice(i + 1, end);
                let flags = '';
                let j = end + 1;
                while (j < text.length && /[a-z]/i.test(text[j])) {
                    flags += text[j];
                    j++;
                }
                i = j;
                const normalizedFlags = flags.includes('i') ? 'i' : '';
                const re = compileSafeRegex(source, normalizedFlags);
                if (re) {
                    clauses.push({ type: 'regex', negated, value: source, regex: re });
                } else {
                    error = 'Invalid or unsafe regular expression — matched literally';
                    if (source.trim()) {
                        clauses.push({ type: 'term', negated, value: source.toLowerCase() });
                    }
                }
                continue;
            }
            // lone slash falls through as a term
        }

        // bare token (may be field:value)
        let token = '';
        while (i < text.length && !/\s/.test(text[i])) {
            if (text[i] === '"') {
                // field:"quoted value"
                token += readQuoted();
                continue;
            }
            token += text[i];
            i++;
        }
        if (!token) { continue; }

        const colon = token.indexOf(':');
        if (colon > 0 && colon < token.length - 1) {
            const head = token.slice(0, colon);
            const rest = token.slice(colon + 1);
            if (FIELD_HEAD.test(head)) {
                const timeOp = TIME_FIELDS[head.toLowerCase()];
                if (timeOp) {
                    const timeMs = parseDateTimeValue(rest);
                    if (timeMs === null) {
                        error = `Invalid date/time in ${head}: — use HH:mm, YYYY-MM-DD or an ISO date-time`;
                    } else {
                        clauses.push({ type: 'time', negated, value: rest, op: timeOp, timeMs });
                    }
                    continue;
                }
                clauses.push({ type: 'field', negated, field: head.toLowerCase(), value: rest.toLowerCase() });
                continue;
            }
        }
        clauses.push({ type: 'term', negated, value: token.toLowerCase() });
    }

    return { clauses, error };
}

function lookupFieldValue(log: LogEntry, field: string): unknown {
    switch (field) {
        case 'level': return log.level;
        case 'source': return log.source;
        case 'correlationid':
        // Aliases: the parser normalizes reqId/req.id/request_id/x-request-id into correlationId,
        // so let an agent query by any of those names too.
        case 'reqid':
        case 'requestid':
        case 'request_id':
            return log.correlationId;
        case 'traceid':
        case 'trace_id':
            return log.traceId;
        case 'message': return log.message;
        case 'sessionid': return log.sessionId;
        default: break;
    }
    // dotted path into raw
    let current: unknown = log.raw;
    for (const part of field.split('.')) {
        if (current === null || typeof current !== 'object') { return undefined; }
        const record = current as Record<string, unknown>;
        const key = Object.keys(record).find(k => k.toLowerCase() === part);
        if (key === undefined) { return undefined; }
        current = record[key];
    }
    return current;
}

function clauseMatches(clause: SearchClause, log: LogEntry, content: () => string): boolean {
    switch (clause.type) {
        case 'term':
        case 'phrase':
            return content().toLowerCase().includes(clause.value);
        case 'field': {
            const value = lookupFieldValue(log, clause.field || '');
            if (value === undefined || value === null) { return false; }
            const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
            return text.toLowerCase().includes(clause.value);
        }
        case 'regex':
            return clause.regex ? clause.regex.test(content()) : false;
        case 'time': {
            const t = new Date(log.timestamp).getTime();
            if (isNaN(t) || clause.timeMs === undefined) { return false; }
            return clause.op === 'after' ? t >= clause.timeMs : t < clause.timeMs;
        }
    }
}

/** True when the entry satisfies every clause (empty query matches everything). */
export function matchesQuery(log: LogEntry, query: ParsedQuery): boolean {
    if (query.clauses.length === 0) { return true; }

    let cached: string | null = null;
    const content = () => {
        if (cached === null) {
            try {
                cached = JSON.stringify(log.raw);
            } catch {
                cached = String(log.message || '');
            }
        }
        return cached;
    };

    for (const clause of query.clauses) {
        const hit = clauseMatches(clause, log, content);
        if (clause.negated ? hit : !hit) {
            return false;
        }
    }
    return true;
}
