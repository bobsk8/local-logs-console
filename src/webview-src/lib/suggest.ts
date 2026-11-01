// Pure, DOM-free search autocomplete — unit-testable with plain Node.
//
// FieldIndex learns which fields (and which values) the captured logs actually
// contain; suggest() turns the token under the cursor into completions.

import { LogEntry } from '../../models/logEntry';
import { fieldFilterToken } from './filter';

const MAX_FIELDS = 300;
const MAX_VALUES_PER_FIELD = 50;
const MAX_VALUE_LENGTH = 60;
const FIELD_NAME = /^[A-Za-z_@][A-Za-z0-9_.@-]*$/;

const LEVEL_VALUES = ['error', 'warn', 'info', 'debug', 'trace'];
const TIME_FIELDS = ['since', 'after', 'before', 'until'];
const TIME_VALUES = ['30s', '5m', '15m', '1h', '1d'];
/** Fields every entry has, offered even before any log arrives. */
const BUILTIN_FIELDS = ['level', 'source', 'message', 'stream', 'stack', 'correlationId', 'traceId'];
const SKIP_RAW_KEYS = new Set(['msg', 'message', 'time', 'timestamp', '__hasLevelMarker', 'v']);

interface FieldStats {
    count: number;
    values: Map<string, number>;
}

export class FieldIndex {
    private readonly fieldsMap = new Map<string, FieldStats>();

    add(entry: LogEntry): void {
        this.note('level', entry.level ? entry.level.toLowerCase() : undefined);
        this.note('source', entry.source);
        if (entry.stream) { this.note('stream', entry.stream); }
        if (entry.correlationId) { this.note('correlationId', entry.correlationId); }
        const raw = entry.raw;
        if (!raw || typeof raw !== 'object') { return; }
        for (const [key, value] of Object.entries(raw)) {
            if (SKIP_RAW_KEYS.has(key) || !FIELD_NAME.test(key)) { continue; }
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                // one level of nesting: req.method, user.id
                for (const [sub, subValue] of Object.entries(value as Record<string, unknown>)) {
                    const path = key + '.' + sub;
                    if (FIELD_NAME.test(path)) { this.note(path, subValue); }
                }
            } else {
                this.note(key, value);
            }
        }
    }

    clear(): void {
        this.fieldsMap.clear();
    }

    /** Known field names, most frequent first. */
    fields(): string[] {
        return [...this.fieldsMap.entries()]
            .sort((a, b) => b[1].count - a[1].count)
            .map(([name]) => name);
    }

    /** Most frequent values of a field (case-insensitive name), filtered by prefix. */
    topValues(field: string, prefix = '', n = 8): string[] {
        const stats = this.lookup(field);
        if (!stats) { return []; }
        const p = prefix.toLowerCase();
        return [...stats.values.entries()]
            .filter(([v]) => v.toLowerCase().startsWith(p))
            .sort((a, b) => b[1] - a[1])
            .slice(0, n)
            .map(([v]) => v);
    }

    private lookup(field: string): FieldStats | undefined {
        const exact = this.fieldsMap.get(field);
        if (exact) { return exact; }
        const lower = field.toLowerCase();
        for (const [name, stats] of this.fieldsMap) {
            if (name.toLowerCase() === lower) { return stats; }
        }
        return undefined;
    }

    private note(field: string, value: unknown): void {
        if (value === undefined || value === null) { return; }
        const t = typeof value;
        if (t !== 'string' && t !== 'number' && t !== 'boolean') { return; }
        let stats = this.fieldsMap.get(field);
        if (!stats) {
            if (this.fieldsMap.size >= MAX_FIELDS) { return; }
            stats = { count: 0, values: new Map() };
            this.fieldsMap.set(field, stats);
        }
        stats.count++;
        const text = String(value);
        if (text === '' || text.length > MAX_VALUE_LENGTH || /[\r\n]/.test(text)) { return; }
        const seen = stats.values.get(text);
        if (seen !== undefined) {
            stats.values.set(text, seen + 1);
        } else if (stats.values.size < MAX_VALUES_PER_FIELD) {
            stats.values.set(text, 1);
        }
    }
}

export interface Suggestion {
    /** What the dropdown shows. */
    label: string;
    /** Text that replaces input[from, to). */
    insert: string;
    from: number;
    to: number;
    /** Dimmed hint on the right ("field", "value", "time"). */
    kind: 'field' | 'value' | 'time';
}

/** The whitespace-delimited token that ends at `cursor` (quotes keep spaces). */
export function tokenAt(input: string, cursor: number): { start: number; text: string } {
    // the token starts after the last whitespace that is not inside quotes
    let start = 0;
    let inQuotes = false;
    for (let i = 0; i < cursor; i++) {
        const ch = input[i];
        if (ch === '"') { inQuotes = !inQuotes; }
        if (!inQuotes && /\s/.test(ch)) { start = i + 1; }
    }
    return { start, text: input.slice(start, cursor) };
}

/** Completions for the token under the cursor; empty when there is nothing useful to offer. */
export function suggest(input: string, cursor: number, index: FieldIndex, max = 8): Suggestion[] {
    const { start, text } = tokenAt(input, cursor);
    if (!text || text.startsWith('/') || text.startsWith('"')) { return []; }
    const negated = text.startsWith('-');
    const body = negated ? text.slice(1) : text;
    const from = start + (negated ? 1 : 0);
    const to = cursor;
    const colon = body.indexOf(':');

    if (colon === -1) {
        if (!body) { return []; }
        const lower = body.toLowerCase();
        const names = new Set<string>([...BUILTIN_FIELDS, ...index.fields(), 'since']);
        const out: Suggestion[] = [];
        for (const name of names) {
            const n = name.toLowerCase();
            if (n.startsWith(lower) && n !== lower) {
                out.push({ label: name + ':', insert: name + ':', from, to, kind: TIME_FIELDS.includes(n) ? 'time' : 'field' });
                if (out.length >= max) { break; }
            }
        }
        return out;
    }

    const field = body.slice(0, colon);
    if (!FIELD_NAME.test(field)) { return []; }
    const valuePrefix = body.slice(colon + 1).replace(/^"/, '');
    const lowerField = field.toLowerCase();

    let values: string[];
    let kind: Suggestion['kind'] = 'value';
    if (TIME_FIELDS.includes(lowerField)) {
        values = TIME_VALUES.filter(v => v.startsWith(valuePrefix));
        kind = 'time';
    } else if (lowerField === 'level') {
        values = LEVEL_VALUES.filter(v => v.startsWith(valuePrefix.toLowerCase()));
    } else {
        values = index.topValues(field, valuePrefix, max);
    }
    return values
        .filter(v => v.toLowerCase() !== valuePrefix.toLowerCase())
        .slice(0, max)
        .map(v => {
            const token = fieldFilterToken(field, v);
            return { label: token, insert: token + ' ', from, to, kind };
        });
}
