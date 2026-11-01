// Pure timestamp normalization — vscode-free, shared by the parser and tests.

/** Field names checked, in order, for an entry's event time. */
export const TIMESTAMP_FIELDS = ['timestamp', 'time', 'ts', '@timestamp', 't', 'date'] as const;

/** `2026-11-01 10:00:00,123` (Python logging / log4j) — comma millis, space separator. */
const SPACE_DATETIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:[.,](\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Epoch number → milliseconds, inferring the unit from its magnitude
 * (seconds, milliseconds, microseconds or nanoseconds). Pino emits ms,
 * structlog/zap often emit fractional seconds, OTel emits nanoseconds.
 */
function epochToMs(n: number): number | null {
    if (!isFinite(n) || n <= 0) { return null; }
    if (n < 1e11) { return n * 1000; }   // seconds (until year 5138)
    if (n < 1e14) { return n; }          // milliseconds
    if (n < 1e17) { return n / 1e3; }    // microseconds
    return n / 1e6;                      // nanoseconds
}

/**
 * Converts a timestamp value of any common shape to epoch milliseconds, or
 * null when it cannot be interpreted.
 */
export function timestampToMs(value: unknown): number | null {
    if (typeof value === 'number') {
        return epochToMs(value);
    }
    if (typeof value !== 'string') {
        return null;
    }
    const v = value.trim();
    if (!v) { return null; }
    if (/^\d+(\.\d+)?$/.test(v)) {
        return epochToMs(Number(v));
    }
    const spaced = SPACE_DATETIME.exec(v);
    if (spaced) {
        const frac = spaced[3] ? '.' + spaced[3].slice(0, 3).padEnd(3, '0') : '';
        const zone = spaced[4] ? (spaced[4] === 'Z' ? 'Z' : spaced[4].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')) : '';
        const ms = Date.parse(`${spaced[1]}T${spaced[2]}${frac}${zone}`);
        return isNaN(ms) ? null : ms;
    }
    const ms = Date.parse(v);
    return isNaN(ms) ? null : ms;
}

/** Normalizes any supported timestamp to an ISO-8601 UTC string, or null. */
export function normalizeTimestamp(value: unknown): string | null {
    const ms = timestampToMs(value);
    if (ms === null) { return null; }
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Leading date-time on a plain-text line: ISO / "YYYY-MM-DD HH:mm:ss,SSS", optionally in brackets. */
const TEXT_ISO_PREFIX = /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)\]?(?=\s|$)/;
/** NestJS default logger: "[Nest] 123  - 11/1/2026, 12:53:23 PM   LOG …" */
const TEXT_NEST_PREFIX = /^\[Nest\]\s+\d+\s+-\s+(\d{1,2}\/\d{1,2}\/\d{4}),?\s+(\d{1,2}:\d{2}:\d{2}\s*[AP]M)/i;
/** Clock-only prefix "HH:mm:ss(.SSS)" — taken as today, local time. */
const TEXT_CLOCK_PREFIX = /^\[?(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?\]?(?=\s)/;

/**
 * Event time printed at the start of a plain-text line, as ISO, or null.
 * `now` anchors clock-only prefixes to today (injectable for tests).
 */
export function extractTextTimestamp(line: string, now: Date = new Date()): string | null {
    const iso = TEXT_ISO_PREFIX.exec(line);
    if (iso) {
        return normalizeTimestamp(iso[1]);
    }
    const nestMatch = TEXT_NEST_PREFIX.exec(line);
    if (nestMatch) {
        const ms = Date.parse(`${nestMatch[1]} ${nestMatch[2]}`);
        return isNaN(ms) ? null : new Date(ms).toISOString();
    }
    const clock = TEXT_CLOCK_PREFIX.exec(line);
    if (clock) {
        const [h, m, s] = [Number(clock[1]), Number(clock[2]), Number(clock[3])];
        if (h > 23 || m > 59 || s > 59) { return null; }
        const ms = clock[4] ? Number(clock[4].padEnd(3, '0')) : 0;
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, s, ms).toISOString();
    }
    return null;
}

/** First timestamp field of a parsed JSON log line that normalizes cleanly. */
export function extractTimestamp(json: Record<string, unknown>): string | null {
    for (const field of TIMESTAMP_FIELDS) {
        if (json[field] !== undefined && json[field] !== null) {
            const iso = normalizeTimestamp(json[field]);
            if (iso) { return iso; }
        }
    }
    return null;
}
