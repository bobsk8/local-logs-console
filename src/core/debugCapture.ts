import * as vscode from 'vscode';
import { LogPipeline, LineSink } from './logPipeline';
import { LineSplitter } from './lineSplitter';
import { SessionRegistry } from './sessionRegistry';
import * as config from './config';

/** Debug Adapter Protocol output categories that carry the program's own output. */
const PROGRAM_CATEGORIES = new Set(['stdout', 'stderr']);

interface DebugCapture {
    id: string;
    root: vscode.DebugSession;
    streams: Map<'stdout' | 'stderr', { splitter: LineSplitter; sink: LineSink }>;
    exitCode?: number;
    stoppedByUser: boolean;
}

interface DapMessage {
    type?: string;
    event?: string;
    body?: { category?: string; output?: string; exitCode?: number };
}

let nextDebugId = 1;

/**
 * Captures what a program prints while it runs under the debugger (F5): the
 * Debug Console's stdout/stderr output events become a capture session, with
 * no command to configure. Uses the stable DebugAdapterTracker API.
 */
export class DebugCaptureManager implements vscode.Disposable {
    /** Keyed by the top-level debug session id (child sessions share it). */
    private readonly captures = new Map<string, DebugCapture>();
    private readonly disposables: vscode.Disposable[] = [];

    constructor(
        private readonly pipeline: LogPipeline,
        private readonly registry: SessionRegistry
    ) {
        this.disposables.push(
            vscode.debug.registerDebugAdapterTrackerFactory('*', {
                createDebugAdapterTracker: session => {
                    if (!config.captureDebugSessions()) { return undefined; }
                    return {
                        onDidSendMessage: (message: DapMessage) => this.onMessage(session, message)
                    };
                }
            }),
            vscode.debug.onDidTerminateDebugSession(session => this.onTerminated(session))
        );
    }

    private onMessage(session: vscode.DebugSession, message: DapMessage): void {
        if (message?.type !== 'event') { return; }
        if (message.event === 'exited' && typeof message.body?.exitCode === 'number') {
            const capture = this.captures.get(rootOf(session).id);
            if (capture) { capture.exitCode = message.body.exitCode; }
            return;
        }
        if (message.event !== 'output') { return; }
        const category = message.body?.category ?? 'console';
        const output = message.body?.output;
        if (!PROGRAM_CATEGORIES.has(category) || typeof output !== 'string' || output === '') { return; }
        const stream = this.streamFor(session, category as 'stdout' | 'stderr');
        stream.splitter.push(output);
    }

    private streamFor(session: vscode.DebugSession, name: 'stdout' | 'stderr') {
        const root = rootOf(session);
        let capture = this.captures.get(root.id);
        if (!capture) {
            capture = this.start(root);
        }
        let stream = capture.streams.get(name);
        if (!stream) {
            const sink = this.pipeline.openStream({
                source: root.name,
                sessionId: capture.id,
                stream: name,
                defaultLevel: 'INFO'
            });
            stream = { sink, splitter: new LineSplitter(line => { sink.push(line); }) };
            capture.streams.set(name, stream);
        }
        return stream;
    }

    private start(root: vscode.DebugSession): DebugCapture {
        const capture: DebugCapture = {
            id: `debug-${nextDebugId++}`,
            root,
            streams: new Map(),
            stoppedByUser: false
        };
        this.captures.set(root.id, capture);
        const folder = root.workspaceFolder;
        const configuration = root.configuration;
        this.registry.register({
            id: capture.id,
            kind: 'debug',
            label: root.name,
            startedAt: Date.now(),
            status: 'running',
            cwd: typeof configuration.cwd === 'string' ? configuration.cwd : folder?.uri.fsPath,
            stop: () => {
                capture.stoppedByUser = true;
                void vscode.debug.stopDebugging(root);
            },
            restart: () => { void vscode.debug.startDebugging(folder, configuration); }
        });
        return capture;
    }

    private onTerminated(session: vscode.DebugSession): void {
        // only the top-level session ends the capture; children come and go
        if (session.parentSession) { return; }
        const capture = this.captures.get(session.id);
        if (!capture) { return; }
        this.captures.delete(session.id);
        for (const { splitter, sink } of capture.streams.values()) {
            splitter.end();
            sink.end();
        }
        this.registry.end(capture.id, capture.stoppedByUser ? 'stopped' : 'exited', capture.exitCode);
    }

    dispose(): void {
        for (const capture of this.captures.values()) {
            for (const { splitter, sink } of capture.streams.values()) {
                splitter.end();
                sink.end();
            }
        }
        this.captures.clear();
        for (const d of this.disposables) { d.dispose(); }
    }
}

function rootOf(session: vscode.DebugSession): vscode.DebugSession {
    let current = session;
    while (current.parentSession) {
        current = current.parentSession;
    }
    return current;
}
