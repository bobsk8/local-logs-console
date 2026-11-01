// Pure, DOM-free formatting helpers — unit-testable with plain Node.

export function escapeHtml(str: unknown): string {
    return String(str).replace(/[&<>"']/g, m => (
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[m]
    ));
}

export function pad(n: number, width = 2): string {
    const s = String(n);
    return s.length >= width ? s : new Array(width - s.length + 1).join('0') + s;
}

/** Full date+time with milliseconds — shown on hover via the title attribute. */
export function formatTimestamp(input: string | number): string {
    try {
        const d = new Date(input);
        if (isNaN(d.getTime())) { return ''; }
        const Y = d.getFullYear();
        const M = pad(d.getMonth() + 1);
        const D = pad(d.getDate());
        const hh = pad(d.getHours());
        const mm = pad(d.getMinutes());
        const ss = pad(d.getSeconds());
        const ms = pad(d.getMilliseconds(), 3);
        return `${Y}-${M}-${D} ${hh}:${mm}:${ss}.${ms}`;
    } catch {
        return '';
    }
}

/** Event time shown in the list column — clock with milliseconds. */
export function formatClock(input: string | number): string {
    try {
        const d = new Date(input);
        if (isNaN(d.getTime())) { return String(input || ''); }
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    } catch {
        return String(input || '');
    }
}

/** Short clock (no ms) for compact labels like the time-range chip. */
export function formatClockShort(input: string | number): string {
    try {
        const d = new Date(input);
        if (isNaN(d.getTime())) { return String(input || ''); }
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    } catch {
        return String(input || '');
    }
}

/** Time between two entries for the delta column: +0ms, +12ms, +1.4s, +2m05s, +3h. */
export function formatDelta(ms: number): string {
    if (!Number.isFinite(ms)) { return ''; }
    const sign = ms < 0 ? '-' : '+';
    const a = Math.abs(ms);
    if (a < 1000) { return `${sign}${Math.round(a)}ms`; }
    if (a < 10000) { return `${sign}${(a / 1000).toFixed(1)}s`; }
    if (a < 60000) { return `${sign}${Math.round(a / 1000)}s`; }
    if (a < 3600000) {
        const m = Math.floor(a / 60000);
        return `${sign}${m}m${pad(Math.floor((a % 60000) / 1000))}s`;
    }
    const h = Math.floor(a / 3600000);
    return `${sign}${h}h${pad(Math.floor((a % 3600000) / 60000))}m`;
}

/** Keys the row already shows (or that are noise) — never repeated as inline attributes. */
const STANDARD_KEYS = new Set([
    'level', 'lvl', 'severity', 'levelname', '@l', 'log.level', 'status_text',
    'msg', 'message', '@m', '@mt', 'text',
    'time', 'timestamp', 'ts', '@timestamp', '@t', 't', 'date',
    'pid', 'hostname', 'host', 'v', 'name', 'logger', 'context', 'source',
    'stack', 'err', 'error', 'exception', '__hasLevelMarker',
    'correlationId', 'traceId', 'spanId', 'trace_id', 'span_id'
]);

/**
 * Up to `max` short scalar attributes from the entry's raw object, shown dimmed
 * after the message ("userId=42 route=/users"). Long values are skipped rather
 * than truncated so the row never shows misleading fragments.
 */
export function inlineAttributes(raw: unknown, max = 3, maxValueLength = 40): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return out; }
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (out.length >= max) { break; }
        if (STANDARD_KEYS.has(key)) { continue; }
        if (value === null || value === undefined) { continue; }
        const t = typeof value;
        if (t !== 'string' && t !== 'number' && t !== 'boolean') { continue; }
        const text = String(value);
        if (text === '' || text.length > maxValueLength || /[\r\n]/.test(text)) { continue; }
        out.push([key, text]);
    }
    return out;
}

/**
 * Character ranges of `needles` (already lowercased) inside `text`, merged and
 * sorted — the message renderer wraps them in <mark> via text nodes.
 */
export function highlightRanges(text: string, needles: readonly string[], maxRanges = 50): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    if (!text || needles.length === 0) { return ranges; }
    const lower = text.toLowerCase();
    for (const needle of needles) {
        if (!needle) { continue; }
        let from = 0;
        while (ranges.length < maxRanges * 2) {
            const at = lower.indexOf(needle, from);
            if (at === -1) { break; }
            ranges.push([at, at + needle.length]);
            from = at + needle.length;
        }
    }
    ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const merged: Array<[number, number]> = [];
    for (const r of ranges) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1]) {
            last[1] = Math.max(last[1], r[1]);
        } else {
            merged.push([r[0], r[1]]);
        }
        if (merged.length >= maxRanges) { break; }
    }
    return merged;
}
