import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LogPipeline } from './logPipeline';
import { SessionRegistry } from './sessionRegistry';
import * as config from './config';

let nextSessionId = 1;

/**
 * Follows files with fs.watch + ranged createReadStream so only newly
 * appended bytes are read. Handles truncation/rotation by resetting the
 * read offset when the file shrinks.
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
        const tail = new TailSession(filePath, this.pipeline, id, () => {
            this.sessions.delete(id);
            this.registry.remove(id);
        });

        this.sessions.set(id, tail);
        this.registry.register({
            id,
            kind: 'file',
            label: path.basename(filePath),
            startedAt: Date.now(),
            status: 'running',
            stop: () => tail.dispose()
        });

        tail.start();
        this.outputChannel.appendLine(`Following file: ${path.basename(filePath)}`);
        this.outputChannel.show(true);
    }

    stopAll(): void {
        for (const tail of [...this.sessions.values()]) {
            tail.dispose();
        }
    }
}

class TailSession {
    private buffer = '';
    private lastSize = 0;
    private watcher: fs.FSWatcher | undefined;
    private disposed = false;

    constructor(
        private readonly filePath: string,
        private readonly pipeline: LogPipeline,
        private readonly sessionId: string,
        private readonly onDispose: () => void
    ) { }

    start(): void {
        fs.stat(this.filePath, (err, stats) => {
            if (this.disposed) {
                return;
            }
            if (err) {
                vscode.window.showErrorMessage('Could not access file: ' + err.message);
                this.dispose();
                return;
            }

            const start = Math.max(0, stats.size - config.tailSeedBytes());
            this.lastSize = stats.size;
            this.readRange(start, stats.size);
        });

        try {
            this.watcher = fs.watch(this.filePath, (eventType) => {
                if (eventType !== 'change' || this.disposed) {
                    return;
                }

                fs.stat(this.filePath, (err, stats) => {
                    if (err || this.disposed) {
                        return;
                    }

                    if (stats.size < this.lastSize) {
                        this.lastSize = 0;
                    }

                    if (stats.size > this.lastSize) {
                        this.readRange(this.lastSize, stats.size);
                        this.lastSize = stats.size;
                    }
                });
            });
            this.watcher.on('error', () => this.dispose());
        } catch (err) {
            vscode.window.showErrorMessage('Could not watch file: ' + String(err instanceof Error ? err.message : err));
            this.dispose();
        }
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        try {
            this.watcher?.close();
        } catch {
            // ignore
        }
        this.onDispose();
    }

    private readRange(start: number, endExclusive: number): void {
        if (endExclusive <= start) {
            return;
        }

        const rs = fs.createReadStream(this.filePath, {
            encoding: 'utf8',
            start,
            end: endExclusive - 1
        });

        rs.on('data', chunk => this.processData(String(chunk)));
        rs.on('error', () => {
            // ignore stream read errors
        });
    }

    private processData(chunk: string): void {
        this.buffer += chunk;
        while (this.buffer.includes('\n')) {
            const idx = this.buffer.indexOf('\n');
            let line = this.buffer.substring(0, idx);
            this.buffer = this.buffer.substring(idx + 1);
            if (line.endsWith('\r')) { line = line.slice(0, -1); }
            if (line.includes('\r')) { line = line.substring(line.lastIndexOf('\r') + 1); }
            this.pipeline.ingest(line, {
                source: path.basename(this.filePath),
                sessionId: this.sessionId
            });
        }
    }
}
