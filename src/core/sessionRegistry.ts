import * as vscode from 'vscode';

export type SessionKind = 'command' | 'file';
export type SessionStatus = 'running' | 'exited';

export interface CaptureSession {
    readonly id: string;
    readonly kind: SessionKind;
    readonly label: string;
    readonly startedAt: number;
    status: SessionStatus;
    stop(): void;
}

/**
 * Tracks every live capture (command or file tail) so the status bar,
 * stop-all command and (later) the sidebar tree share one view of what is
 * running. Sessions register on start and are removed when they end.
 */
export class SessionRegistry {
    private readonly sessions = new Map<string, CaptureSession>();
    private readonly emitter = new vscode.EventEmitter<void>();
    public readonly onDidChangeSessions = this.emitter.event;

    register(session: CaptureSession): void {
        this.sessions.set(session.id, session);
        this.emitter.fire();
    }

    remove(id: string): void {
        if (this.sessions.delete(id)) {
            this.emitter.fire();
        }
    }

    /** Fire the change event after mutating a session's status in place. */
    notifyChanged(): void {
        this.emitter.fire();
    }

    getAll(): CaptureSession[] {
        return [...this.sessions.values()];
    }

    get activeCount(): number {
        return this.sessions.size;
    }

    stopAll(): void {
        for (const session of [...this.sessions.values()]) {
            try {
                session.stop();
            } catch {
                // session already gone
            }
        }
    }

    dispose(): void {
        this.emitter.dispose();
    }
}
