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

function normalizeLevel(value: unknown): LogLevel {
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

                correlationId:
                    json['correlationId'] !== undefined
                        ? String(json['correlationId'])
                        : json['correlationID'] !== undefined
                            ? String(json['correlationID'])
                            : undefined,

                traceId:
                    json['traceId'] !== undefined
                        ? String(json['traceId'])
                        : undefined
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