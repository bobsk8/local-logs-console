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

    /** True when the redactor masked at least one secret in this line. */
    redacted?: boolean;
    /** Capture session (command run or file tail) this entry came from. */
    sessionId?: string;
}
