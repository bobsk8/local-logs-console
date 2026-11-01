import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LogPipeline, LineSink } from './logPipeline';
import { SessionRegistry } from './sessionRegistry';
import { LineSplitter } from './lineSplitter';
import * as config from './config';

let nextSessionId = 1;

/** Polling interval of the fs.watchFile safety net (rotation, flaky fs.watch). */
const POLL_INTERVAL_MS = 1000;

/**
 * Follows files with fs.watch (plus a fs.watchFile polling safety net) and
 * ranged reads of only the newly-appended bytes. Handles truncation, and
 * rotation (rename/delete + recreate) by reopening the new file from offset 0.
 */
export class FileTailManager {
    private readonly sessions = new Map<string, TailSession>();

    constructor(
        private readonly pipeline: LogPipeline,
        private readonly registry: SessionRegistry,
        private readonly outputChannel: vscode.OutputChannel
    ) { }

    get hasActive(): boolean {
        return this.sessions.size > 0;
    }

    follow(filePath: string): void {
        const id = `file-${nextSessionId++}`;
        const sink = this.pipeline.openStream({ source: path.basename(filePath), sessionId: id });
        const tail = new TailSession(filePath, sink, config.tailSeedBytes(), {
            onError: message => vscode.window.showErrorMessage(message),
            onDispose: () => {
                this.sessions.delete(id);
                this.registry.end(id, 'stopped');
            }
        });

        this.sessions.set(id, tail);
        this.registry.register({
            id,
            kind: 'file',
            cwd: path.dirname(filePath),
            label: path.basename(filePath),
            startedAt: Date.now(),
            status: 'running',
            stop: () => tail.dispose(),
            restart: () => this.follow(filePath)
        });

        tail.start();
        this.outputChannel.appendLine(`Following file: ${filePath}`);
    }

    stopAll(): void {
        for (const tail of [...this.sessions.values()]) {
            tail.dispose();
        }
    }
}

export interface TailCallbacks {
    onError(message: string): void;
    onDispose(): void;
}

/**
 * One followed file. Reads are serialized (one ranged stream at a time; a
 * change during a read schedules exactly one follow-up), so lines can never
 * interleave or arrive out of order.
 */
export class TailSession {
    private offset = 0;
    private inode: number | undefined;
    private reading = false;
    private readAgain = false;
    private watcher: fs.FSWatcher | undefined;
    private activeStream: fs.ReadStream | undefined;
    private dropNextLine = false;
    private disposed = false;
    private readonly splitter: LineSplitter;
    private readonly onPoll = (curr: fs.Stats, prev: fs.Stats) => {
        if (curr.size !== prev.size || curr.mtimeMs !== prev.mtimeMs || curr.ino !== prev.ino) {
            this.scheduleRead();
        }
    };

    constructor(
        private readonly filePath: string,
        /** Structural, so tests can pass a fake that just collects lines. */
        private readonly sink: Pick<LineSink, 'push' | 'end'>,
        private readonly seedBytes: number,
        private readonly callbacks: TailCallbacks
    ) {
        this.splitter = new LineSplitter(line => {
            if (this.dropNextLine) {
                // the seed read started mid-file: its first line is a fragment
                this.dropNextLine = false;
                return;
            }
            this.sink.push(line);
        });
    }

    start(): void {
        // stat first, watch second — a write landing in between must not make
        // the first change event read the whole file from offset 0
        fs.stat(this.filePath, (err, stats) => {
            if (this.disposed) {
                return;
            }
            if (err) {
                this.callbacks.onError('Could not access file: ' + err.message);
                this.dispose();
                return;
            }

            this.inode = stats.ino || undefined;
            this.offset = Math.max(0, stats.size - this.seedBytes);
            this.dropNextLine = this.offset > 0;
            this.attachWatcher();
            fs.watchFile(this.filePath, { interval: POLL_INTERVAL_MS, persistent: false }, this.onPoll);
            this.scheduleRead();
        });
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.detachWatcher();
        fs.unwatchFile(this.filePath, this.onPoll);
        this.activeStream?.destroy();
        this.activeStream = undefined;
        this.sink.end();
        this.callbacks.onDispose();
    }

    private attachWatcher(): void {
        if (this.watcher || this.disposed) {
            return;
        }
        try {
            const watcher = fs.watch(this.filePath, () => this.scheduleRead());
            // fs.watch can die on rename/delete; polling keeps the session alive
            watcher.on('error', () => this.detachWatcher());
            this.watcher = watcher;
        } catch {
            // polling alone still works
        }
    }

    private detachWatcher(): void {
        try {
            this.watcher?.close();
        } catch {
            // ignore
        }
        this.watcher = undefined;
    }

    private scheduleRead(): void {
        if (this.disposed) {
            return;
        }
        if (this.reading) {
            this.readAgain = true;
            return;
        }
        this.reading = true;

        fs.stat(this.filePath, (err, stats) => {
            if (this.disposed) {
                return;
            }
            if (err) {
                // rotated away or deleted: wait for the file to come back
                this.detachWatcher();
                this.finishRead();
                return;
            }

            const inode = stats.ino || undefined;
            if (inode !== undefined && this.inode !== undefined && inode !== this.inode) {
                // a new file now lives at this path (rotation) — start over
                this.splitter.end();
                this.splitter.reset();
                this.detachWatcher();
                this.inode = inode;
                this.offset = 0;
            } else if (stats.size < this.offset) {
                // truncated in place
                this.splitter.reset();
                this.offset = 0;
            }
            this.inode = this.inode ?? inode;
            this.attachWatcher();

            if (stats.size <= this.offset) {
                this.finishRead();
                return;
            }

            const stream = fs.createReadStream(this.filePath, { start: this.offset, end: stats.size - 1 });
            this.activeStream = stream;
            stream.on('data', (chunk: Buffer | string) => {
                if (this.disposed) {
                    return;
                }
                this.offset += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
                this.splitter.push(chunk);
            });
            stream.on('error', () => {
                // the next change event / poll retries from the current offset
            });
            stream.on('close', () => {
                this.activeStream = undefined;
                this.finishRead();
            });
        });
    }

    private finishRead(): void {
        this.reading = false;
        if (this.readAgain && !this.disposed) {
            this.readAgain = false;
            this.scheduleRead();
        }
    }
}
