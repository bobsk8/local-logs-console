import { LogEntry } from '../models/logEntry';

/** What the webview needs to know about a capture session (no functions — it is posted). */
export interface SessionSummary {
    id: string;
    kind: 'command' | 'file' | 'debug';
    label: string;
    status: 'running' | 'exited' | 'stopped';
    startedAt: number;
    endedAt?: number;
    exitCode?: number | null;
}

/**
 * The postMessage protocol between the extension host and the webview.
 * Both sides import these types — change them here and the compiler flags
 * every producer/consumer that needs updating.
 */
export type ExtensionToWebviewMessage =
    /** Live entries, batched by the host (never one message per line). */
    | { command: 'addLogs'; logs: LogEntry[] }
    /** Full history snapshot; `limit` is the history cap the webview mirrors. */
    | { command: 'loadHistory'; logs: LogEntry[]; limit: number }
    /** Every capture session (running and ended), sent whenever one changes. */
    | { command: 'sessions'; sessions: SessionSummary[] }
    | { command: 'requestVisibleIds'; requestId: number };

export type WebviewToExtensionMessage =
    | { command: 'ready' }
    | { command: 'stopAll' }
    | { command: 'clearLogs' }
    | { command: 'runCommandRequest' }
    | { command: 'followFileRequest' }
    | { command: 'exportRequest' }
    | { command: 'pasteLogs'; text: string; label?: string }
    | { command: 'visibleIds'; requestId: number; ids: string[] }
    /** Open a stack-frame location in the editor (the host resolves and validates the path). */
    | { command: 'openSource'; file: string; line: number; column?: number; sessionId?: string }
    | { command: 'stopSession'; id: string }
    | { command: 'restartSession'; id: string };
