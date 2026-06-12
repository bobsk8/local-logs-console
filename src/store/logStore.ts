import { LogEntry } from '../models/logEntry';

export class LogStore {
    private logs: LogEntry[] = [];

    private readonly maxLogs = 10000;

    add(log: LogEntry): void {
        this.logs.push(log);

        if (this.logs.length > this.maxLogs) {
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
