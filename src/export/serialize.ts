// Pure serialization for log export — unit-testable with plain Node.

import { LogEntry } from '../models/logEntry';

export type ExportFormat = 'json' | 'ndjson' | 'text';

function pad(n: number, width = 2): string {
    const s = String(n);
    return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

function formatTextTimestamp(input: string): string {
    const d = new Date(input);
    if (isNaN(d.getTime())) { return input; }
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * Serializes entries for export. Entries have already been through the
 * redaction pipeline at ingest time, so exports are redacted by construction.
 */
export function serializeLogs(entries: LogEntry[], format: ExportFormat): string {
    switch (format) {
        case 'json':
            return JSON.stringify(entries, null, 2) + '\n';
        case 'ndjson':
            return entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
        case 'text':
            return entries
                .map(e => `${formatTextTimestamp(e.timestamp)} [${e.level}] ${e.source} — ${e.message}`)
                .join('\n') + (entries.length ? '\n' : '');
    }
}

export function suggestedFileName(format: ExportFormat, now: Date): string {
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const ext = format === 'text' ? 'log' : format;
    return `logs-${stamp}.${ext}`;
}
