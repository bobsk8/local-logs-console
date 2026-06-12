import * as vscode from 'vscode';
import { LogEntry } from '../models/logEntry';

export class LogEventBus {
    private readonly emitter = new vscode.EventEmitter<LogEntry>();

    public readonly onLogReceived = this.emitter.event;

    emit(log: LogEntry): void {
        this.emitter.fire(log);
    }

    dispose(): void {
        this.emitter.dispose();
    }
}
