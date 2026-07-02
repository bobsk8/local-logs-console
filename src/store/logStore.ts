import { LogEntry } from '../models/logEntry';

/**
 * Extension-host log history — the single source of truth consumed by the
 * dashboard (and later the exporter/sidebar). FIFO-capped; the limit provider
 * is injected so the store stays pure while reading the
 * `localLogViewer.historyLimit` setting live.
 */
export class LogStore {
    private logs: LogEntry[] = [];

    constructor(private readonly limitProvider: () => number = () => 10000) { }

    add(log: LogEntry): void {
        this.logs.push(log);

        const limit = Math.max(1, this.limitProvider());
        while (this.logs.length > limit) {
            this.logs.shift();
        }
    }

    getAll(): LogEntry[] {
        return [...this.logs];
    }

    clear(): void {
        this.logs = [];
    }

    count(): number {
        return this.logs.length;
    }
}
