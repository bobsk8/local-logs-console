export type LogLevel =
    | 'ERROR'
    | 'WARN'
    | 'INFO'
    | 'DEBUG'
    | 'TRACE';

export interface LogEntry {
    id: string;
    timestamp: string;
    level: LogLevel;
    source: string;
    message: string;
    raw: Record<string, unknown>;

    correlationId?: string;
    traceId?: string;
}
