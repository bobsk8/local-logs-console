import { StringDecoder } from 'string_decoder';

/** Lines longer than this are flushed as-is so a newline-free stream can't grow forever. */
export const MAX_LINE_LENGTH = 64 * 1024;

/**
 * Turns a byte stream into complete lines. Pure — no vscode, unit-testable.
 *
 * - Decodes UTF-8 with a StringDecoder, so a multi-byte character split
 *   across two chunks is reassembled instead of becoming two U+FFFD.
 * - Accepts LF and CRLF terminators. A bare CR (progress bars, spinners)
 *   rewrites the current line: only the text after the last CR is kept.
 * - Flushes a line once it exceeds `maxLineLength`.
 */
export class LineSplitter {
    private decoder = new StringDecoder('utf8');
    private buffer = '';

    constructor(
        private readonly onLine: (line: string) => void,
        private readonly maxLineLength = MAX_LINE_LENGTH
    ) { }

    push(chunk: Buffer | string): void {
        this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
        let idx: number;
        while ((idx = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.substring(0, idx);
            this.buffer = this.buffer.substring(idx + 1);
            this.emit(line);
        }
        while (this.buffer.length > this.maxLineLength) {
            const head = this.buffer.substring(0, this.maxLineLength);
            this.buffer = this.buffer.substring(this.maxLineLength);
            this.emit(head);
        }
    }

    /** Emits whatever partial line is buffered (stream end). */
    end(): void {
        this.buffer += this.decoder.end();
        if (this.buffer) {
            const rest = this.buffer;
            this.buffer = '';
            this.emit(rest);
        }
    }

    /** Drops buffered text and decoder state (file truncated or rotated). */
    reset(): void {
        this.buffer = '';
        this.decoder = new StringDecoder('utf8');
    }

    private emit(line: string): void {
        if (line.endsWith('\r')) { line = line.slice(0, -1); }
        const cr = line.lastIndexOf('\r');
        if (cr !== -1) { line = line.substring(cr + 1); }
        this.onLine(line);
    }
}
