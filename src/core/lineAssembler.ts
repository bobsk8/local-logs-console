import { LogLevel } from '../models/logEntry';
import { detectLevel } from '../logParser';

/** A logical log event: a head line plus any continuation lines (stack frames, traceback…). */
export interface AssembledLine {
    head: string;
    continuation: string[];
    redacted: boolean;
    /** When the head line arrived (epoch ms) — the event time for plain-text lines. */
    receivedAt: number;
}

/** Hard cap so a runaway indented dump can't become one giant entry. */
export const MAX_GROUP_LINES = 200;

/** Lines that are always part of the event above them, whatever its level. */
const FRAME_LINE = [
    /^\s+at\s/,                                  // JS / Java / .NET stack frame
    /^\s+\.\.\.\s*\d+\s+(more|common frames)/,   // Java "... 12 more"
    /^Caused by:\s/,                             // Java cause chain
    /^\s+File ".+", line \d+/,                   // Python frame
    /^\s+\S+\.go:\d+/,                           // Go frame
    /^\s*\^+\s*$/,                               // Python/Node caret marker
    /^(During handling of the above exception|The above exception was the direct cause)/
];

/** A Python traceback ends with the exception line ("ValueError: …"), not indented. */
const PY_EXCEPTION_LINE = /^[A-Za-z_][\w.]*(Error|Exception|Exit|Interrupt|Warning)\b(:|$)/;

function isFrameLine(line: string): boolean {
    return FRAME_LINE.some(re => re.test(line));
}

const SEVERITY: Record<LogLevel, number> = { TRACE: 0, DEBUG: 1, INFO: 2, WARN: 3, ERROR: 4 };

/** Most severe level mentioned in a group's continuation lines (e.g. "ZeroDivisionError: …"). */
export function continuationLevel(lines: string[]): LogLevel | null {
    let best: LogLevel | null = null;
    for (const line of lines) {
        const level = detectLevel(line, 'TRACE');
        if (level !== 'TRACE' && (best === null || SEVERITY[level] > SEVERITY[best])) {
            best = level;
        }
    }
    return best;
}

/**
 * Turns a line stream into logical events. Pure and synchronous: the owner
 * feeds lines with `push()` and calls `flush()` when the stream goes idle
 * (the pipeline does that on a short timer) or ends.
 *
 * A line joins the open event when it is a stack frame / traceback line, the
 * closing exception line of a Python traceback, or an indented line under an
 * ERROR/WARN head (or under a line that opened a `{`/`[` dump). Anything else
 * closes the open event and starts a new one.
 */
export class LineAssembler {
    private open: AssembledLine | null = null;
    private openLevel: LogLevel = 'INFO';
    private inTraceback = false;
    private openDump = false;

    constructor(
        private readonly defaultLevel: LogLevel = 'INFO',
        private readonly now: () => number = Date.now
    ) { }

    /** Feeds one cleaned line; returns events that are now complete. */
    push(line: string, redacted = false): AssembledLine[] {
        const done: AssembledLine[] = [];
        if (this.open && this.belongsToOpen(line)) {
            this.open.continuation.push(line);
            this.open.redacted = this.open.redacted || redacted;
            if (this.inTraceback && PY_EXCEPTION_LINE.test(line)) {
                // the exception line ends a traceback
                done.push(this.close());
            } else if (this.openDump && /^[}\]]/.test(line)) {
                done.push(this.close());
            } else if (this.open.continuation.length + 1 >= MAX_GROUP_LINES) {
                done.push(this.close());
            }
            return done;
        }
        if (this.open) {
            done.push(this.close());
        }
        this.open = { head: line, continuation: [], redacted, receivedAt: this.now() };
        this.openLevel = detectLevel(line, this.defaultLevel);
        this.inTraceback = /^Traceback \(most recent call last\):/.test(line.trim());
        this.openDump = /[{[]\s*$/.test(line) && !/^\s*[{[].*[}\]]\s*$/.test(line);
        return done;
    }

    /** Closes the open event, if any (idle timeout or end of stream). */
    flush(): AssembledLine | null {
        return this.open ? this.close() : null;
    }

    get hasPending(): boolean {
        return this.open !== null;
    }

    private belongsToOpen(line: string): boolean {
        if (isFrameLine(line)) { return true; }
        if (this.inTraceback) {
            return /^\s/.test(line) || PY_EXCEPTION_LINE.test(line);
        }
        if (!/^\s/.test(line)) {
            return this.openDump && /^[}\]]/.test(line);
        }
        // indented line: part of an error report or of a multi-line object dump
        return this.openDump || this.openLevel === 'ERROR' || this.openLevel === 'WARN'
            || this.open!.continuation.some(isFrameLine);
    }

    private close(): AssembledLine {
        const event = this.open!;
        this.open = null;
        this.inTraceback = false;
        this.openDump = false;
        return event;
    }
}
