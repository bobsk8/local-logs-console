import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { LogEntry } from './models/logEntry';
import { LogStore } from './store/logStore';
import { LogEventBus } from './events/logEventBus';
import { SessionRegistry } from './core/sessionRegistry';
import { ExtensionToWebviewMessage, WebviewToExtensionMessage, SessionSummary } from './shared/protocol';

function getNonce(): string {
    return randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, 'x');
}

/** Live entries are flushed to the webview at most this often... */
const FLUSH_INTERVAL_MS = 50;
/** ...or immediately once this many are queued. */
const FLUSH_MAX_BATCH = 500;

/**
 * Singleton webview panel. Pure view: history lives in LogStore (owned by the
 * extension, survives panel dispose) and live entries arrive via LogEventBus.
 */
export class LogDashboard {
    public static currentPanel: LogDashboard | undefined;
    /** Called when the user closes the panel (captures keep running). */
    public static onUserDispose: (() => void) | undefined;
    /** Called when the panel becomes visible or hidden (status-bar error badge). */
    public static onVisibilityChange: ((visible: boolean) => void) | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _pendingVisibleIds = new Map<number, (ids: string[]) => void>();
    private _nextRequestId = 1;
    private _pending: LogEntry[] = [];
    private _flushTimer: ReturnType<typeof setTimeout> | undefined;

    public static createOrShow(extensionUri: vscode.Uri, store: LogStore, bus: LogEventBus, registry: SessionRegistry) {
        if (LogDashboard.currentPanel) {
            // keep the panel in whatever column the user moved it to
            LogDashboard.currentPanel._panel.reveal();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            LogDashboard.viewType,
            'Local Logs Console',
            vscode.ViewColumn.One,
            {
                ...LogDashboard.webviewOptions(extensionUri),
                retainContextWhenHidden: true
            }
        );

        LogDashboard.currentPanel = new LogDashboard(panel, extensionUri, store, bus, registry);
    }

    public static readonly viewType = 'logDashboard';

    private static webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
        return { enableScripts: true, localResourceRoots: [extensionUri] };
    }

    /** Restores the panel after a VS Code restart (WebviewPanelSerializer). */
    public static revive(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, store: LogStore, bus: LogEventBus, registry: SessionRegistry) {
        if (LogDashboard.currentPanel) {
            panel.dispose();
            return;
        }
        panel.webview.options = LogDashboard.webviewOptions(extensionUri);
        LogDashboard.currentPanel = new LogDashboard(panel, extensionUri, store, bus, registry);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        private readonly _store: LogStore,
        bus: LogEventBus,
        private readonly _registry: SessionRegistry
    ) {
        this._panel = panel;
        this._panel.webview.html = this._getHtmlForWebview(extensionUri);

        this._disposables.push(
            bus.onLogReceived(log => this.enqueue(log)),
            _registry.onDidChangeSessions(() => this.sendSessions())
        );

        this._panel.webview.onDidReceiveMessage(
            (message: WebviewToExtensionMessage) => {
                switch (message.command) {
                    case 'ready':
                        // webview is ready, send history so it can render persisted logs
                        this.sendHistoryToWebview();
                        this.sendSessions();
                        return;
                    case 'stopAll':
                        // ask extension to stop any running captures
                        vscode.commands.executeCommand('local-log-viewer.stopAllCaptures');
                        return;
                    case 'clearLogs':
                        this.dropPending();
                        this._store.clear();
                        // finished sessions go with their logs; running ones stay
                        this._registry.pruneEnded();
                        return;
                    case 'runCommandRequest':
                        vscode.commands.executeCommand('local-log-viewer.runAndCapture');
                        return;
                    case 'followFileRequest':
                        vscode.commands.executeCommand('local-log-viewer.followFile');
                        return;
                    case 'exportRequest':
                        vscode.commands.executeCommand('local-log-viewer.exportLogs');
                        return;
                    case 'pasteLogs':
                        vscode.commands.executeCommand('local-log-viewer.pasteLogs', message.text, message.label);
                        return;
                    case 'openSource':
                        vscode.commands.executeCommand('local-log-viewer.openSource', {
                            file: message.file,
                            line: message.line,
                            column: message.column,
                            sessionId: message.sessionId
                        });
                        return;
                    case 'stopSession':
                        try { this._registry.get(message.id)?.stop(); } catch { /* already gone */ }
                        return;
                    case 'restartSession':
                        void this._registry.restart(message.id);
                        return;
                    case 'visibleIds': {
                        const resolve = this._pendingVisibleIds.get(message.requestId);
                        if (resolve) {
                            this._pendingVisibleIds.delete(message.requestId);
                            resolve(message.ids);
                        }
                        return;
                    }
                }
            },
            null,
            this._disposables
        );

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.onDidChangeViewState(e => LogDashboard.onVisibilityChange?.(e.webviewPanel.visible), null, this._disposables);
        LogDashboard.onVisibilityChange?.(this._panel.visible);
    }

    private post(message: ExtensionToWebviewMessage) {
        this._panel.webview.postMessage(message);
    }

    /** Queues a live entry; the batch is flushed on a short timer or when full. */
    private enqueue(log: LogEntry) {
        this._pending.push(log);
        if (this._pending.length >= FLUSH_MAX_BATCH) {
            this.flush();
        } else if (!this._flushTimer) {
            this._flushTimer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
        }
    }

    private flush() {
        if (this._flushTimer) {
            clearTimeout(this._flushTimer);
            this._flushTimer = undefined;
        }
        if (this._pending.length === 0) { return; }
        const logs = this._pending;
        this._pending = [];
        this.post({ command: 'addLogs', logs });
    }

    private dropPending() {
        if (this._flushTimer) {
            clearTimeout(this._flushTimer);
            this._flushTimer = undefined;
        }
        this._pending = [];
    }

    private sendSessions() {
        const sessions: SessionSummary[] = this._registry.getAll().map(s => ({
            id: s.id,
            kind: s.kind,
            label: s.label,
            status: s.status,
            startedAt: s.startedAt,
            endedAt: s.endedAt,
            exitCode: s.exitCode
        }));
        this.post({ command: 'sessions', sessions });
    }

    private sendHistoryToWebview() {
        // queued entries are already in the store — sending both would duplicate them
        this.dropPending();
        this.post({ command: 'loadHistory', logs: this._store.getAll(), limit: this._store.getLimit() });
    }

    /** Asks the webview for the ids of the currently visible (filtered) entries. */
    public requestVisibleIds(): Promise<string[] | null> {
        // deliver queued entries first so "current view" includes the latest lines
        this.flush();
        const requestId = this._nextRequestId++;
        return new Promise<string[] | null>(resolve => {
            const timeout = setTimeout(() => {
                this._pendingVisibleIds.delete(requestId);
                resolve(null);
            }, 2000);
            this._pendingVisibleIds.set(requestId, ids => {
                clearTimeout(timeout);
                resolve(ids);
            });
            this.post({ command: 'requestVisibleIds', requestId });
        });
    }

    public dispose() {
        // Closing the dashboard is closing a view — captures keep running and
        // stay manageable from the sidebar / status bar.
        LogDashboard.currentPanel = undefined;
        this.dropPending();
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) { x.dispose(); }
        }
        LogDashboard.onVisibilityChange?.(false);
        LogDashboard.onUserDispose?.();
    }

    private _getHtmlForWebview(extensionUri: vscode.Uri): string {
        const webview = this._panel.webview;

        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview.css'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview.js'));
        const nonce = getNonce();

        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; base-uri 'none'; connect-src 'none';">
                <link rel="stylesheet" href="${styleUri}">
                <title>Local Logs Console</title>
            </head>
            <body>
                <div class="dashboard">
                    <div id="log-section" class="log-section">
                        <div class="toolbar" role="toolbar" aria-label="Log filters and actions">
                            <div class="search-wrap">
                                <span class="codicon codicon-search search-icon" aria-hidden="true"></span>
                                <input type="text" id="search-input" class="search-input"
                                    placeholder="Search logs   level:error   since:5m   &quot;phrase&quot;   -term   /regex/"
                                    role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="suggest-list"
                                    aria-label="Search logs" aria-describedby="search-help" autocomplete="off" spellcheck="false" />
                                <ul id="suggest-list" class="suggest-list" role="listbox" aria-label="Search suggestions" hidden></ul>
                                <div id="search-hint" class="search-hint" role="alert" hidden></div>
                                <div id="search-help" class="search-help" hidden>
                                    <div class="search-help-title">Search syntax</div>
                                    <div><code>error timeout</code> — every term must match</div>
                                    <div><code>"exact phrase"</code> &nbsp;·&nbsp; <code>-exclude</code></div>
                                    <div><code>level:error</code> &nbsp;·&nbsp; <code>source:api</code> &nbsp;·&nbsp; <code>user.name:alice</code></div>
                                    <div><code>since:5m</code> &nbsp;·&nbsp; <code>after:14:30</code> &nbsp;·&nbsp; <code>before:2026-07-02T15:00</code></div>
                                    <div><code>/regex/i</code> &nbsp;·&nbsp; <code>is:bookmarked</code> &nbsp;·&nbsp; <code>stream:stderr</code></div>
                                    <div class="search-help-foot">Tab completes fields and values · <kbd>?</kbd> all shortcuts</div>
                                </div>
                            </div>

                            <div class="severity-filters" role="group" aria-label="Severity filters">
                                <button type="button" class="filter-badge badge-error" data-level="error" aria-pressed="false" title="Errors">Error<span class="pill-count" id="count-error">0</span></button>
                                <button type="button" class="filter-badge badge-warn" data-level="warn" aria-pressed="false" title="Warnings">Warn<span class="pill-count" id="count-warn">0</span></button>
                                <button type="button" class="filter-badge badge-info" data-level="info" aria-pressed="false" title="Info">Info<span class="pill-count" id="count-info">0</span></button>
                                <button type="button" class="filter-badge badge-debug" data-level="debug" aria-pressed="false" title="Debug">Debug<span class="pill-count" id="count-debug">0</span></button>
                                <button type="button" class="filter-badge badge-trace" data-level="trace" aria-pressed="false" title="Trace">Trace<span class="pill-count" id="count-trace">0</span></button>
                            </div>

                            <span id="log-counter" class="log-counter" title="Visible / total logs">0 / 0</span>

                            <button id="live-btn" class="live-pill live" type="button" aria-pressed="true" title="Following new logs — click to pause">
                                <span class="live-dot" aria-hidden="true"></span><span id="live-text">Live</span>
                            </button>
                            <button id="clear-btn" class="icon-btn" type="button" aria-label="Clear logs" title="Clear logs (click twice)">
                                <span class="codicon codicon-clear-all" aria-hidden="true"></span><span class="confirm-text">Clear?</span>
                            </button>
                            <div class="menu-wrap">
                                <button id="menu-btn" class="icon-btn" type="button" aria-haspopup="menu" aria-expanded="false" aria-controls="main-menu" aria-label="More actions" title="More actions">
                                    <span class="codicon codicon-ellipsis" aria-hidden="true"></span>
                                </button>
                                <div id="main-menu" class="menu-dropdown" role="menu" aria-label="More actions" hidden>
                                    <button type="button" role="menuitem" class="menu-item" data-action="paste"><span class="codicon codicon-clippy" aria-hidden="true"></span>Paste logs…</button>
                                    <button type="button" role="menuitem" class="menu-item" data-action="export"><span class="codicon codicon-save-as" aria-hidden="true"></span>Export…</button>
                                    <button type="button" role="menuitem" class="menu-item" data-action="stop" id="stop-btn"><span class="codicon codicon-debug-stop" aria-hidden="true"></span>Stop all captures</button>
                                    <div class="menu-sep" role="separator"></div>
                                    <div class="menu-label" aria-hidden="true">Time column</div>
                                    <button type="button" role="menuitemradio" class="menu-item" data-time-mode="clock" aria-checked="true"><span class="codicon codicon-check" aria-hidden="true"></span>Clock<kbd>t</kbd></button>
                                    <button type="button" role="menuitemradio" class="menu-item" data-time-mode="delta" aria-checked="false"><span class="codicon codicon-check" aria-hidden="true"></span>Since previous line</button>
                                    <button type="button" role="menuitemradio" class="menu-item" data-time-mode="relative" aria-checked="false"><span class="codicon codicon-check" aria-hidden="true"></span>Since first line</button>
                                    <div class="menu-sep" role="separator"></div>
                                    <button type="button" role="menuitemcheckbox" class="menu-item" id="density-btn" aria-checked="false"><span class="codicon codicon-check" aria-hidden="true"></span>Compact rows</button>
                                    <button type="button" role="menuitem" class="menu-item" data-action="shortcuts"><span class="codicon codicon-keyboard" aria-hidden="true"></span>Keyboard shortcuts<kbd>?</kbd></button>
                                </div>
                            </div>
                        </div>

                        <div id="session-bar" class="session-bar" role="group" aria-label="Captures — click to show only that capture" hidden></div>

                        <div id="log-histogram" class="log-histogram" role="group" aria-label="Log volume timeline — click a bar to filter, drag to select a range"></div>
                        <div id="time-filter-label" class="time-chip" hidden>
                            <span class="codicon codicon-history" aria-hidden="true"></span>
                            <span id="time-filter-text"></span>
                            <button id="time-filter-clear" class="time-chip-clear" type="button" aria-label="Clear time filter"><span class="codicon codicon-close" aria-hidden="true"></span></button>
                        </div>

                        <div class="log-col-header">
                            <button id="time-col-btn" class="col-btn" type="button" title="Switch time format (t)">Time</button>
                            <span aria-hidden="true">Level</span>
                            <span aria-hidden="true">Source</span>
                            <span aria-hidden="true">Message</span>
                        </div>

                        <div class="log-body">
                            <div id="log-container" class="log-container" role="listbox" aria-label="Log entries" tabindex="0"></div>

                            <button id="new-logs-btn" class="new-logs-btn" type="button" hidden>
                                <span class="codicon codicon-arrow-down" aria-hidden="true"></span><span id="new-logs-text">New logs</span>
                            </button>

                            <div id="loading-state" class="state-overlay" aria-hidden="true">
                                <div class="skeleton-rows">
                                    <div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div>
                                    <div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div>
                                </div>
                            </div>

                            <div id="empty-state" class="state-overlay" hidden>
                                <div class="state-card">
                                    <div class="state-icon codicon codicon-output" aria-hidden="true"></div>
                                    <h3>No logs yet</h3>
                                    <p>Run a command or a package.json script, follow a log file, or just press F5 — debug output is captured too.<br/>Logs never leave your machine.</p>
                                    <div class="state-actions">
                                        <button id="empty-run-btn" class="btn btn-primary" type="button">Run a command</button>
                                        <button id="empty-follow-btn" class="btn" type="button">Follow a log file</button>
                                        <button id="empty-paste-btn" class="btn" type="button">Paste logs</button>
                                    </div>
                                    <p class="state-tip"><kbd>/</kbd> search · <kbd>↑</kbd><kbd>↓</kbd> navigate · <kbd>Enter</kbd> details · <kbd>?</kbd> all shortcuts</p>
                                </div>
                            </div>

                            <div id="no-results-state" class="state-overlay" hidden>
                                <div class="state-card">
                                    <div class="state-icon codicon codicon-search" aria-hidden="true"></div>
                                    <h3>No results for this query</h3>
                                    <p>No log entries match the current search, severity, capture or time filters.</p>
                                    <div class="state-actions">
                                        <button id="clear-filters-btn" class="btn" type="button">Clear filters</button>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div id="aria-live" class="visually-hidden" aria-live="polite"></div>
                    </div>

                    <div id="resizer" class="resizer" aria-hidden="true"></div>

                    <div id="paste-modal" class="modal-overlay" hidden>
                        <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="paste-modal-title">
                            <h3 id="paste-modal-title" class="modal-title">Paste logs</h3>
                            <textarea id="paste-textarea" class="paste-textarea" placeholder="Paste log lines here (Cmd/Ctrl+V)…" spellcheck="false"></textarea>
                            <input type="text" id="paste-label-input" class="paste-label-input" placeholder="Source label (default: pasted)">
                            <div class="modal-actions">
                                <button id="paste-import-btn" class="btn btn-primary" type="button">Import</button>
                                <button id="paste-cancel-btn" class="btn" type="button">Cancel</button>
                            </div>
                        </div>
                    </div>

                    <div id="shortcuts-modal" class="modal-overlay" hidden>
                        <div class="modal-card shortcuts-card" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
                            <h3 id="shortcuts-title" class="modal-title">Keyboard shortcuts</h3>
                            <dl class="shortcuts">
                                <dt><kbd>/</kbd> <kbd>Ctrl</kbd>+<kbd>F</kbd></dt><dd>Search (<kbd>Tab</kbd> completes)</dd>
                                <dt><kbd>↑</kbd> <kbd>↓</kbd></dt><dd>Move selection</dd>
                                <dt><kbd>Enter</kbd></dt><dd>Open details</dd>
                                <dt><kbd>Esc</kbd></dt><dd>Close details · clear search</dd>
                                <dt><kbd>e</kbd> <kbd>Shift</kbd>+<kbd>E</kbd></dt><dd>Next / previous error</dd>
                                <dt><kbd>b</kbd></dt><dd>Bookmark the selected line (<code>is:bookmarked</code>)</dd>
                                <dt><kbd>c</kbd></dt><dd>Copy the selected line as JSON</dd>
                                <dt><kbd>t</kbd></dt><dd>Time column: clock · since previous · since first</dd>
                                <dt><kbd>Space</kbd></dt><dd>Pause / resume live follow</dd>
                                <dt><kbd>Home</kbd> <kbd>End</kbd></dt><dd>First / last line</dd>
                                <dt><kbd>Ctrl</kbd>+<kbd>End</kbd></dt><dd>Jump to newest and follow</dd>
                                <dt><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>R</kbd></dt><dd>Restart the last capture (anywhere in VS Code)</dd>
                            </dl>
                            <div class="modal-actions">
                                <button id="shortcuts-close-btn" class="btn" type="button">Close</button>
                            </div>
                        </div>
                    </div>

                    <div id="detail-panel" class="detail-panel" role="complementary" aria-label="Log details">
                        <div class="detail-header">
                            <div class="detail-tabs" role="tablist" aria-label="Detail views">
                                <button type="button" role="tab" class="detail-tab" id="tab-overview" data-tab="overview" aria-controls="pane-overview" aria-selected="true">Overview</button>
                                <button type="button" role="tab" class="detail-tab" id="tab-context" data-tab="context" aria-controls="pane-context" aria-selected="false" tabindex="-1">Context</button>
                                <button type="button" role="tab" class="detail-tab" id="tab-json" data-tab="json" aria-controls="pane-json" aria-selected="false" tabindex="-1">JSON</button>
                            </div>
                            <span id="redacted-badge" class="redacted-badge" title="One or more secret values in this entry were masked before display" hidden><span class="codicon codicon-shield" aria-hidden="true"></span>redacted</span>
                            <button class="icon-btn" id="bookmark-btn" type="button" aria-pressed="false" aria-label="Bookmark this line" title="Bookmark (b)"><span class="codicon codicon-bookmark" aria-hidden="true"></span></button>
                            <button class="icon-btn" id="close-panel-btn" type="button" aria-label="Close details" title="Close (Esc)"><span class="codicon codicon-close" aria-hidden="true"></span></button>
                        </div>
                        <div class="detail-content">
                            <div id="pane-overview" class="detail-pane" role="tabpanel" aria-labelledby="tab-overview">
                                <div class="json-header">
                                    <div class="section-title">Message</div>
                                    <div class="json-actions">
                                        <button id="copy-message-btn" class="json-action-btn" type="button">Copy</button>
                                    </div>
                                </div>
                                <pre id="message-content" class="message-code"></pre>
                                <div id="stack-section" hidden>
                                    <div class="section-title">Stack <span id="stack-count" class="section-count"></span></div>
                                    <ol id="stack-list" class="stack-list"></ol>
                                </div>
                                <div class="section-title">Attributes</div>
                                <table class="attributes-table" id="attributes-table"></table>
                            </div>
                            <div id="pane-context" class="detail-pane" role="tabpanel" aria-labelledby="tab-context" hidden>
                                <div id="correlation-box" class="correlation-box" hidden></div>
                                <div class="section-title" id="context-title">Same capture</div>
                                <ol id="context-list" class="context-list"></ol>
                            </div>
                            <div id="pane-json" class="detail-pane" role="tabpanel" aria-labelledby="tab-json" hidden>
                                <div class="json-header">
                                    <div class="section-title">Raw entry</div>
                                    <div class="json-actions">
                                        <button id="copy-json-btn" class="json-action-btn" type="button">Copy</button>
                                        <button id="json-expand-all" class="json-action-btn" type="button">Expand all</button>
                                        <button id="json-collapse-all" class="json-action-btn" type="button">Collapse all</button>
                                    </div>
                                </div>
                                <div id="json-content" class="json-tree"></div>
                            </div>
                        </div>
                    </div>
                </div>

                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>
        `;
    }
}
