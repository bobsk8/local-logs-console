import * as vscode from 'vscode';

export type SessionKind = 'command' | 'file';
/** running → exited (process ended on its own) | stopped (ended by the user). */
export type SessionStatus = 'running' | 'exited' | 'stopped';

export interface CaptureSession {
    readonly id: string;
    readonly kind: SessionKind;
    readonly label: string;
    readonly startedAt: number;
    status: SessionStatus;
    /** When the session ended (epoch ms). */
    endedAt?: number;
    /** Process exit code (commands); null when killed by a signal. */
    exitCode?: number | null;
    stop(): void;
    /** Starts the same capture again (re-run the command / re-follow the file). */
    restart?(): void;
}

/**
 * Tracks every capture session (command or file tail) so the status bar,
 * stop-all, the sidebar, the dashboard and the MCP tools share one view.
 * Ended sessions stay listed — with their outcome and a restart action —
 * until `pruneEnded()` (the dashboard's Clear).
 */
export class SessionRegistry {
    private readonly sessions = new Map<string, CaptureSession>();
    private readonly emitter = new vscode.EventEmitter<void>();
    public readonly onDidChangeSessions = this.emitter.event;

    register(session: CaptureSession): void {
        this.sessions.set(session.id, session);
        this.emitter.fire();
    }

    /** Marks a session as ended, keeping it listed. */
    end(id: string, status: Exclude<SessionStatus, 'running'>, exitCode?: number | null): void {
        const session = this.sessions.get(id);
        if (!session || session.status !== 'running') {
            return;
        }
        session.status = status;
        session.endedAt = Date.now();
        if (exitCode !== undefined) {
            session.exitCode = exitCode;
        }
        this.emitter.fire();
    }

    remove(id: string): void {
        if (this.sessions.delete(id)) {
            this.emitter.fire();
        }
    }

    /** Drops every session that is no longer running. */
    pruneEnded(): void {
        let changed = false;
        for (const [id, session] of this.sessions) {
            if (session.status !== 'running') {
                this.sessions.delete(id);
                changed = true;
            }
        }
        if (changed) {
            this.emitter.fire();
        }
    }

    /** Fire the change event after mutating a session's status in place. */
    notifyChanged(): void {
        this.emitter.fire();
    }

    get(id: string): CaptureSession | undefined {
        return this.sessions.get(id);
    }

    getAll(): CaptureSession[] {
        return [...this.sessions.values()];
    }

    getRunning(): CaptureSession[] {
        return this.getAll().filter(s => s.status === 'running');
    }

    /** Number of sessions still running (status bar, stop-all). */
    get activeCount(): number {
        let n = 0;
        for (const session of this.sessions.values()) {
            if (session.status === 'running') { n++; }
        }
        return n;
    }

    stopAll(): void {
        for (const session of this.getRunning()) {
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
