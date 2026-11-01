import { LogEntry, LogLevel } from '../models/logEntry';
import { LogParser } from '../logParser';
import { LogStore } from '../store/logStore';
import { LogEventBus } from '../events/logEventBus';
import { Redactor, RedactionResult } from './redactor';
import { cleanLine } from './lineCleaner';
import { LineAssembler, AssembledLine, continuationLevel } from './lineAssembler';
import * as config from './config';

export interface IngestOptions {
    source?: string;
    overrideLevel?: LogLevel;
    sessionId?: string;
    redacted?: boolean;
    /** Level for unstructured lines that carry no level keyword. */
    defaultLevel?: LogLevel;
    stream?: 'stdout' | 'stderr';
}

export interface StreamOptions extends IngestOptions {
    /** Close a pending multi-line event after this much silence (ms). */
    idleFlushMs?: number;
    /** Checked when an event completes; false drops it (e.g. a process being killed). */
    shouldIngest?: () => boolean;
}

/** A per-stream line sink: clean → redact → group multi-line events → ingest. */
export interface LineSink {
    /** Feeds one raw line; returns the cleaned + redacted text (for echo), or null when blank. */
    push(rawLine: string): RedactionResult | null;
    /** Flushes a pending event (end of stream). */
    end(): void;
}

const DEFAULT_IDLE_FLUSH_MS = 150;
const SEVERITY: Record<LogLevel, number> = { TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4 };
const TRACEBACK_HEAD = /^Traceback \(most recent call last\):/;

/**
 * The single ingest path for every captured line: clean → redact → parse →
 * store + broadcast. Capture sources never write to the dashboard directly —
 * they feed this pipeline and views subscribe to the event bus. Redaction
 * happens here, on the raw line, so secrets never reach the store, the
 * webview or an export.
 */
export class LogPipeline {
    private redactor: Redactor;
    private seq = 0;

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

    /** Full path for one raw line (no multi-line grouping): clean + redact + ingest. */
    ingest(rawLine: string, opts: IngestOptions = {}): LogEntry | null {
        const cleaned = cleanLine(rawLine);
        if (!cleaned.trim()) {
            return null;
        }
        const { text, redacted } = this.redactor.redact(cleaned);
        return this.ingestPrepared(text, { ...opts, redacted: redacted || opts.redacted });
    }

    /** For sources that already cleaned and redacted the line. */
    ingestPrepared(text: string, opts: IngestOptions = {}): LogEntry | null {
        return this.ingestEvent({ head: text, continuation: [], redacted: !!opts.redacted, receivedAt: Date.now() }, opts);
    }

    /**
     * Opens a streaming sink for one source (a command's stdout, a tailed
     * file, a paste). Lines are grouped into events — a stack trace becomes
     * one entry with `stack` — and a pending event is closed after a short
     * silence so the last line never waits for the next one.
     */
    openStream(opts: StreamOptions = {}): LineSink {
        const assembler = new LineAssembler(opts.defaultLevel ?? 'INFO');
        const idleMs = opts.idleFlushMs ?? DEFAULT_IDLE_FLUSH_MS;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let lastPush = 0;

        const emit = (event: AssembledLine | null) => {
            if (event && (!opts.shouldIngest || opts.shouldIngest())) {
                this.ingestEvent(event, opts);
            }
        };
        const onIdle = () => {
            timer = undefined;
            const quietFor = Date.now() - lastPush;
            if (quietFor >= idleMs) {
                emit(assembler.flush());
            } else if (assembler.hasPending) {
                timer = setTimeout(onIdle, idleMs - quietFor);
            }
        };

        return {
            push: (rawLine: string) => {
                const cleaned = cleanLine(rawLine);
                if (!cleaned.trim()) {
                    return null;
                }
                const result = this.redactor.redact(cleaned);
                for (const event of assembler.push(result.text, result.redacted)) {
                    emit(event);
                }
                lastPush = Date.now();
                if (assembler.hasPending && !timer) {
                    timer = setTimeout(onIdle, idleMs);
                }
                return result;
            },
            end: () => {
                if (timer) {
                    clearTimeout(timer);
                    timer = undefined;
                }
                emit(assembler.flush());
            }
        };
    }

    private ingestEvent(event: AssembledLine, opts: IngestOptions): LogEntry | null {
        const parsed = LogParser.parseLine(event.head, { receivedAt: event.receivedAt, defaultLevel: opts.defaultLevel });
        if (!parsed) {
            return null;
        }

        if (event.continuation.length > 0) {
            if (TRACEBACK_HEAD.test(event.head.trim())) {
                // a Python traceback's useful summary is its last line
                const last = event.continuation[event.continuation.length - 1];
                parsed.message = last;
                parsed.stack = [event.head.trim(), ...event.continuation.slice(0, -1)];
            } else {
                parsed.stack = event.continuation;
            }
            const fromStack = continuationLevel(event.continuation);
            if (fromStack && SEVERITY[fromStack] > SEVERITY[parsed.level]) {
                parsed.level = fromStack;
            }
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
        if (opts.stream) {
            parsed.stream = opts.stream;
        }
        if (opts.redacted || event.redacted) {
            parsed.redacted = true;
        }
        parsed.seq = ++this.seq;

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
