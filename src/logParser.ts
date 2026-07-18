import { LogEntry, LogLevel } from './models/logEntry';
import { randomUUID } from 'crypto';

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

function numericLevelToString(n: number): LogLevel | null {
    return NUMERIC_LEVEL_MAP[n] ?? null;
}

function normalizeLevel(value: unknown): LogLevel {
    // Numeric level (Pino/Bunyan style)
    if (typeof value === 'number') {
        const numeric = numericLevelToString(value);
        if (numeric) { return numeric; }
    }
    const candidate = String(value ?? 'INFO').toUpperCase();
    if (candidate === 'ERROR' || candidate === 'WARN' || candidate === 'INFO' || candidate === 'DEBUG' || candidate === 'TRACE') {
        return candidate;
    }
    return 'INFO';
}

/**
 * The single level-detection heuristic, shared by the parser fallback and the
 * pseudoterminal coloring in CaptureManager. Tries a JSON `level` field first,
 * then keyword matching, then the caller-provided fallback.
 */
export function detectLevel(line: string, fallback: LogLevel = 'INFO'): LogLevel {
    try {
        const parsed = JSON.parse(line) as Record<string, unknown> | null;
        if (parsed && typeof parsed === 'object' && parsed['level'] !== undefined) {
            // Numeric level (Pino/Bunyan)
            if (typeof parsed['level'] === 'number') {
                const numeric = numericLevelToString(parsed['level']);
                if (numeric) { return numeric; }
            }
            const exact = String(parsed['level']).toUpperCase();
            if (exact === 'ERROR' || exact === 'WARN' || exact === 'INFO' || exact === 'DEBUG' || exact === 'TRACE') {
                return exact;
            }
        }
    } catch {
        // not JSON — fall through to keywords
    }

    const upper = line.toUpperCase();

    if (upper.includes('ERROR') || upper.includes('EXCEPTION') || upper.includes('FAIL')) {
        return 'ERROR';
    }
    if (upper.includes('WARN') || upper.includes('AVISO')) {
        return 'WARN';
    }
    if (upper.includes('INFO')) {
        return 'INFO';
    }
    if (upper.includes('DEBUG')) {
        return 'DEBUG';
    }
    if (upper.includes('TRACE')) {
        return 'TRACE';
    }

    return fallback;
}

export class LogParser {
    public static parseLine(line: string): LogEntry | null {
        const trimmed = line.trim();

        if (!trimmed) {
            return null;
        }

        try {
            // check for injected level marker from preload: [LVL:INFO] ...
            const lvlMatch = trimmed.match(/^\[LVL:(ERROR|WARN|INFO|DEBUG|TRACE)\]\s*(.*)$/i);
            if (lvlMatch) {
                const level = normalizeLevel(lvlMatch[1] || 'INFO');
                const rest = lvlMatch[2] || '';
                // treat rest as the message (avoid JSON parse since console prints values)
                return {
                    id: generateUUID(),

                    timestamp: new Date().toISOString(),

                    level,

                    source: 'terminal',

                    message: rest,

                    raw: { message: rest, __hasLevelMarker: true }
                };
            }

            const json = JSON.parse(trimmed) as Record<string, unknown>;

            const level = normalizeLevel(
                json['level'] ?? json['status'] ?? 'INFO'
            );

            const { correlationId, traceId } = extractCorrelation(json);

            return {
                id: generateUUID(),

                timestamp: String(
                    json['timestamp'] ??
                    json['time'] ??
                    new Date().toISOString()
                ),

                level,

                source: String(
                    json['service'] ??
                    json['source'] ??
                    'terminal'
                ),

                message: String(
                    json['message'] ??
                    json['msg'] ??
                    trimmed
                ),

                raw: json,

                correlationId,

                traceId
            };
        } catch {
            const level = detectLevel(trimmed, 'INFO');

            return {
                id: generateUUID(),

                timestamp: new Date().toISOString(),

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