import { LogEntry, LogLevel } from '../models/logEntry';
import { LogParser } from '../logParser';
import { LogStore } from '../store/logStore';
import { LogEventBus } from '../events/logEventBus';
import { Redactor, RedactionResult } from './redactor';
import { cleanLine } from './lineCleaner';
import * as config from './config';

export interface IngestOptions {
    source?: string;
    overrideLevel?: LogLevel;
    sessionId?: string;
    redacted?: boolean;
}

/**
 * The single ingest path for every captured line: clean → redact → parse →
 * store + broadcast. Capture sources never write to the dashboard directly —
 * they feed this pipeline and views subscribe to the event bus. Redaction
 * happens here, on the raw line, so secrets never reach the store, the
 * webview or an export.
 */
export class LogPipeline {
    private redactor: Redactor;

    constructor(
        private readonly store: LogStore,
        private readonly bus: LogEventBus
    ) {
        this.redactor = buildRedactorFromConfig();
    }

    /** Re-reads the `localLogViewer.redaction.*` settings. */
    refreshConfig(): void {
        this.redactor = buildRedactorFromConfig();
    }

    /** Exposed so capture sources can redact before echoing to a terminal. */
    redact(text: string): RedactionResult {
        return this.redactor.redact(text);
    }

    /** Full path for raw lines (file tail): clean + redact + ingest. */
    ingest(rawLine: string, opts: IngestOptions = {}): LogEntry | null {
        const cleaned = cleanLine(rawLine);
        if (!cleaned.trim()) {
            return null;
        }
        const { text, redacted } = this.redactor.redact(cleaned);
        return this.ingestPrepared(text, { ...opts, redacted: redacted || opts.redacted });
    }

    /** For sources that already cleaned and redacted the line (command capture). */
    ingestPrepared(text: string, opts: IngestOptions = {}): LogEntry | null {
        const parsed = LogParser.parseLine(text);
        if (!parsed) {
            return null;
        }

        // An explicit [LVL:x] marker always wins over the stream default.
        const hasMarker = Boolean((parsed.raw as Record<string, unknown>)['__hasLevelMarker']);
        if (opts.overrideLevel && !hasMarker) {
            parsed.level = opts.overrideLevel;
        }
        if (opts.source && parsed.source === 'terminal') {
            parsed.source = opts.source;
        }
        if (opts.sessionId) {
            parsed.sessionId = opts.sessionId;
        }
        if (opts.redacted) {
            parsed.redacted = true;
        }

        this.store.add(parsed);
        this.bus.emit(parsed);
        return parsed;
    }
}

function buildRedactorFromConfig(): Redactor {
    return new Redactor({
        enabled: config.redactionEnabled(),
        useDefaultPatterns: config.redactionUseDefaultPatterns(),
        customPatterns: config.redactionPatterns()
    });
}
