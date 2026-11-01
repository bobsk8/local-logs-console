import * as vscode from 'vscode';
import { LogEntry } from '../models/logEntry';
import { LogEventBus } from '../events/logEventBus';
import { LogStore } from '../store/logStore';
import { SessionRegistry } from './sessionRegistry';
import { SourceResolver } from './sourceResolver';
import { firstAppFrame, isLibraryFrame } from '../shared/stackFrames';
import * as config from './config';

const MAX_FILES = 100;
const MAX_PER_FILE = 20;
const MAX_MESSAGE = 300;

interface Reported {
    diagnostic: vscode.Diagnostic;
    sessionId?: string;
}

/**
 * Turns runtime errors into Problems-panel entries: an ERROR whose stack has a
 * frame in the user's own code becomes a diagnostic on that line. Cleared with
 * the dashboard's Clear and when the same capture runs again.
 */
export class ProblemsReporter implements vscode.Disposable {
    private readonly collection = vscode.languages.createDiagnosticCollection('Local Logs Console');
    private readonly byFile = new Map<string, Reported[]>();
    /** session id → label, for "same command ran again" detection. */
    private readonly sessionLabels = new Map<string, string>();
    private readonly knownSessions = new Set<string>();
    private readonly disposables: { dispose(): void }[] = [];

    constructor(
        bus: LogEventBus,
        store: LogStore,
        private readonly registry: SessionRegistry,
        private readonly resolver: SourceResolver
    ) {
        this.disposables.push(
            this.collection,
            bus.onLogReceived(entry => this.onEntry(entry)),
            store.onDidClear(() => this.clearAll()),
            registry.onDidChangeSessions(() => this.onSessionsChanged())
        );
    }

    clearAll(): void {
        this.byFile.clear();
        this.collection.clear();
    }

    private onEntry(entry: LogEntry): void {
        if (entry.level !== 'ERROR' || !entry.stack || entry.stack.length === 0 || !config.problemsEnabled()) {
            return;
        }
        const frame = firstAppFrame(entry.stack);
        if (!frame || isLibraryFrame(frame)) { return; }
        const session = entry.sessionId ? this.registry.get(entry.sessionId) : undefined;
        const file = this.resolver.resolve(frame.file, session?.cwd);
        if (!file) { return; }

        const reported = this.byFile.get(file) ?? [];
        if (!this.byFile.has(file) && this.byFile.size >= MAX_FILES) { return; }
        const line = frame.line - 1;
        const message = firstLine(entry.message).slice(0, MAX_MESSAGE);
        if (reported.some(r => r.diagnostic.range.start.line === line && r.diagnostic.message === message)) {
            return; // the same error firing in a loop is one problem
        }
        if (reported.length >= MAX_PER_FILE) { return; }

        const column = Math.max(0, (frame.column ?? 1) - 1);
        const diagnostic = new vscode.Diagnostic(
            new vscode.Range(line, column, line, Number.MAX_SAFE_INTEGER),
            message,
            vscode.DiagnosticSeverity.Error
        );
        diagnostic.source = 'Local Logs';
        if (session) {
            diagnostic.code = session.label.length > 60 ? session.label.slice(0, 57) + '…' : session.label;
            this.sessionLabels.set(session.id, session.label);
        }
        reported.push({ diagnostic, sessionId: entry.sessionId });
        this.byFile.set(file, reported);
        this.collection.set(vscode.Uri.file(file), reported.map(r => r.diagnostic));
    }

    /** A capture that starts again replaces the problems its previous run reported. */
    private onSessionsChanged(): void {
        for (const session of this.registry.getRunning()) {
            if (this.knownSessions.has(session.id)) { continue; }
            this.knownSessions.add(session.id);
            const stale = [...this.sessionLabels].filter(([id, label]) => id !== session.id && label === session.label).map(([id]) => id);
            if (stale.length > 0) {
                this.clearSessions(new Set(stale));
            }
        }
    }

    private clearSessions(ids: Set<string>): void {
        for (const [file, reported] of this.byFile) {
            const kept = reported.filter(r => !r.sessionId || !ids.has(r.sessionId));
            if (kept.length === reported.length) { continue; }
            if (kept.length === 0) {
                this.byFile.delete(file);
                this.collection.delete(vscode.Uri.file(file));
            } else {
                this.byFile.set(file, kept);
                this.collection.set(vscode.Uri.file(file), kept.map(r => r.diagnostic));
            }
        }
        for (const id of ids) { this.sessionLabels.delete(id); }
    }

    dispose(): void {
        for (const d of this.disposables) { d.dispose(); }
        this.byFile.clear();
    }
}

function firstLine(text: string): string {
    const nl = text.indexOf('\n');
    return nl === -1 ? text : text.slice(0, nl);
}
