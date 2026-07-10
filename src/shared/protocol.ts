import { LogEntry } from '../models/logEntry';

/**
 * The postMessage protocol between the extension host and the webview.
 * Both sides import these types — change them here and the compiler flags
 * every producer/consumer that needs updating.
 */
export type ExtensionToWebviewMessage =
    | { command: 'addLog'; log: LogEntry }
    | { command: 'loadHistory'; logs: LogEntry[] }
    | { command: 'requestVisibleIds'; requestId: number };

export type WebviewToExtensionMessage =
    | { command: 'ready' }
    | { command: 'loadMore' }
    | { command: 'stopAll' }
    | { command: 'clearLogs' }
    | { command: 'runCommandRequest' }
    | { command: 'followFileRequest' }
    | { command: 'exportRequest' }
    | { command: 'pasteLogs'; text: string; label?: string }
    | { command: 'visibleIds'; requestId: number; ids: string[] };
