import { LogEntry, LogLevel } from './models/logEntry';
import { randomUUID } from 'crypto';
import { extractTimestamp, extractTextTimestamp } from './shared/timestamp';
import { parseLogfmt } from './shared/logfmt';

function generateUUID(): string {
    try {
        return randomUUID();
    } catch {
        // fall through to Math-based fallback
    }

    // Fallback UUID v4 generator (not cryptographically strong, but sufficient here)
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

const NUMERIC_LEVEL_MAP: Record<number, LogLevel> = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'ERROR' };

/** Level names seen across loggers (Pino, Winston, Python, Serilog, log4j, syslog, NestJS). */
const LEVEL_ALIASES: Record<string, LogLevel> = {
    error: 'ERROR', err: 'ERROR', fatal: 'ERROR', critical: 'ERROR', crit: 'ERROR', panic: 'ERROR',
    emerg: 'ERROR', emergency: 'ERROR', alert: 'ERROR', severe: 'ERROR',
    warn: 'WARN', warning: 'WARN', aviso: 'WARN',
    info: 'INFO', information: 'INFO', notice: 'INFO', log: 'INFO',
    debug: 'DEBUG', verbose: 'DEBUG', fine: 'DEBUG',
    trace: 'TRACE', silly: 'TRACE', finest: 'TRACE'
};

/**
 * Pulls request/trace correlation ids out of a parsed JSON log line, recognizing
 * the field names the Node/Nest ecosystem actually emits — not just literal
 * `correlationId`/`traceId`. Precedence is first-present-wins.
 *
 * `correlationId` maps from (in order): correlationId, correlationID, reqId,
 * requestId, request_id, nested req.id (what nestjs-pino / pino-http emit by
 * default, so correlation works with zero app instrumentation), x-request-id.
 * `traceId` maps from traceId, then trace_id.
 *
 * Deliberately does NOT read spanId/span_id: a span is a *child* of a trace, so
 * folding it into traceId would give every line in one request a different id
 * and shatter request grouping.
 */
export function extractCorrelation(json: Record<string, unknown>): { correlationId?: string; traceId?: string } {
    const result: { correlationId?: string; traceId?: string } = {};

    const nestedReqId = (() => {
        const req = json['req'];
        if (req && typeof req === 'object' && !Array.isArray(req)) {
            const id = (req as Record<string, unknown>)['id'];
            if (id !== undefined && id !== null) { return id; }
        }
        return undefined;
    })();

    const correlationCandidates = [
        json['correlationId'],
        json['correlationID'],
        json['reqId'],
        json['requestId'],
        json['request_id'],
        nestedReqId,
        json['x-request-id']
    ];
    for (const candidate of correlationCandidates) {
        if (candidate !== undefined && candidate !== null) {
            result.correlationId = String(candidate);
            break;
        }
    }

    const traceCandidates = [json['traceId'], json['trace_id']];
    for (const candidate of traceCandidates) {
        if (candidate !== undefined && candidate !== null) {
            result.traceId = String(candidate);
            break;
        }
    }

    return result;
}

/** Fields that may carry a JSON line's level, in precedence order. */
function levelFieldValue(json: Record<string, unknown>): unknown {
    for (const key of ['level', 'severity', 'levelname', 'lvl', '@l']) {
        if (json[key] !== undefined && json[key] !== null) { return json[key]; }
    }
    const log = json['log'];
    if (log && typeof log === 'object' && !Array.isArray(log)) {
        const nested = (log as Record<string, unknown>)['level'];
        if (nested !== undefined && nested !== null) { return nested; }
    }
    // `status` doubles as an HTTP status code — only a non-numeric string counts.
    const status = json['status'];
    if (typeof status === 'string' && !/^\d+$/.test(status.trim())) { return status; }
    return undefined;
}

/** Maps a level value (name in any case, or Pino/Bunyan number) to a LogLevel. */
function levelFromValue(value: unknown): LogLevel | null {
    if (typeof value === 'number') {
        return NUMERIC_LEVEL_MAP[value] ?? null;
    }
    if (typeof value === 'string') {
        const key = value.trim().toLowerCase();
        if (/^\d+$/.test(key)) { return NUMERIC_LEVEL_MAP[Number(key)] ?? null; }
        return LEVEL_ALIASES[key] ?? null;
    }
    return null;
}

/**
 * A level token near the start of a line: `[warn]`, `<error>`, `level=debug`,
 * `error: …`, or an uppercase word like NestJS's `  LOG ` / `ERROR `.
 */
const PREFIX_DELIMITED = /(?:^|[[<(]|\b(?:level|lvl|severity)=)(error|err|fatal|critical|crit|panic|warn|warning|aviso|info|notice|log|debug|verbose|trace)(?=[\]>):\s]|$)/i;
const PREFIX_UPPER = /(?:^|[\s|])(ERROR|ERR|FATAL|CRITICAL|PANIC|WARN|WARNING|INFO|NOTICE|LOG|DEBUG|VERBOSE|TRACE)(?=[\s:|\]]|$)/;
/** Phrases that mention a level word while reporting the absence of problems. */
const NEGATED_PROBLEMS = /\b(?:0|no|zero|without)\s+(?:errors?|failures?|failed|warnings?|exceptions?)\b/gi;

/**
 * The single level-detection heuristic, shared by the parser fallback and the
 * pseudoterminal coloring in CaptureManager. Tries a JSON level field first,
 * then a level token in the line prefix, then whole-word keywords (so "0
 * errors" or "failover" stay neutral), then the caller-provided fallback.
 */
export function detectLevel(line: string, fallback: LogLevel = 'INFO'): LogLevel {
    const trimmed = line.trim();
    if (trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown> | null;
            if (parsed && typeof parsed === 'object') {
                const fromJson = levelFromValue(levelFieldValue(parsed));
                if (fromJson) { return fromJson; }
            }
        } catch {
            // not JSON — fall through to keywords
        }
    }

    const prefix = trimmed.slice(0, 48);
    const delimited = PREFIX_DELIMITED.exec(prefix);
    if (delimited) { return LEVEL_ALIASES[delimited[1].toLowerCase()]; }
    const upper = PREFIX_UPPER.exec(prefix);
    if (upper) { return LEVEL_ALIASES[upper[1].toLowerCase()]; }

    const body = trimmed.replace(NEGATED_PROBLEMS, ' ');
    if (/\b(?:error|fatal|panic|exception)\b/i.test(body)
        || /[a-z](?:Error|Exception)\b/.test(body)
        || /\bfail(?:ed|ure|s)?\b/i.test(body)) {
        return 'ERROR';
    }
    if (/\b(?:warn|warning|aviso)\b/i.test(body)) { return 'WARN'; }
    if (/\binfo\b/i.test(body)) { return 'INFO'; }
    if (/\bdebug\b/i.test(body)) { return 'DEBUG'; }
    if (/\btrace\b/i.test(body)) { return 'TRACE'; }

    return fallback;
}

function messageText(value: unknown, fallback: string): string {
    if (value === undefined || value === null) { return fallback; }
    if (typeof value === 'object') {
        try { return JSON.stringify(value); } catch { return fallback; }
    }
    return String(value);
}

export interface ParseOptions {
    /** Arrival time (epoch ms) used when the line carries no timestamp of its own. */
    receivedAt?: number;
    /** Level for unstructured lines with no level keyword (the stream's default). */
    defaultLevel?: LogLevel;
}

export class LogParser {
    public static parseLine(line: string, options: ParseOptions = {}): LogEntry | null {
        const trimmed = line.trim();
        const arrived = new Date(options.receivedAt ?? Date.now());

        if (!trimmed) {
            return null;
        }

        try {
            // check for injected level marker from preload: [LVL:INFO] ...
            const lvlMatch = trimmed.match(/^\[LVL:(ERROR|WARN|INFO|DEBUG|TRACE)\]\s*(.*)$/i);
            if (lvlMatch) {
                const level = levelFromValue(lvlMatch[1]) ?? 'INFO';
                const rest = lvlMatch[2] || '';
                // treat rest as the message (avoid JSON parse since console prints values)
                return {
                    id: generateUUID(),

                    timestamp: arrived.toISOString(),

                    level,

                    source: 'terminal',

                    message: rest,

                    raw: { message: rest, __hasLevelMarker: true }
                };
            }

            const json = JSON.parse(trimmed) as Record<string, unknown>;
            if (!json || typeof json !== 'object' || Array.isArray(json)) {
                throw new Error('not a JSON object');
            }

            const level = levelFromValue(levelFieldValue(json)) ?? 'INFO';

            const { correlationId, traceId } = extractCorrelation(json);

            return {
                id: generateUUID(),

                timestamp: extractTimestamp(json) ?? arrived.toISOString(),

                level,

                source: String(
                    json['service'] ??
                    json['source'] ??
                    'terminal'
                ),

                message: messageText(json['message'] ?? json['msg'], trimmed),

                raw: json,

                correlationId,

                traceId
            };
        } catch {
            // logfmt (key=value) lines are structured too: level, msg, time, ids
            const fields = parseLogfmt(trimmed);
            if (fields) {
                const { correlationId, traceId } = extractCorrelation(fields);
                return {
                    id: generateUUID(),
                    timestamp: extractTimestamp(fields) ?? extractTextTimestamp(trimmed, arrived) ?? arrived.toISOString(),
                    level: levelFromValue(levelFieldValue(fields)) ?? detectLevel(trimmed, options.defaultLevel ?? 'INFO'),
                    source: String(fields['service'] ?? fields['source'] ?? 'terminal'),
                    message: fields['msg'] ?? fields['message'] ?? trimmed,
                    raw: fields,
                    correlationId,
                    traceId
                };
            }

            const level = detectLevel(trimmed, options.defaultLevel ?? 'INFO');

            return {
                id: generateUUID(),

                timestamp: extractTextTimestamp(trimmed, arrived) ?? arrived.toISOString(),

                level,

                source: 'terminal',

                message: trimmed,

                raw: {
                    message: trimmed
                }
            };
        }
    }
}
