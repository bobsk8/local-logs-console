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
