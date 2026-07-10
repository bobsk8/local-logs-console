import * as vscode from 'vscode';
import { LogStore } from './store/logStore';
import { LogEventBus } from './events/logEventBus';
import { ExtensionToWebviewMessage, WebviewToExtensionMessage } from './shared/protocol';

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

/**
 * Singleton webview panel. Pure view: history lives in LogStore (owned by the
 * extension, survives panel dispose) and live entries arrive via LogEventBus.
 */
export class LogDashboard {
    public static currentPanel: LogDashboard | undefined;
    /** Called when the user closes the panel (captures keep running). */
    public static onUserDispose: (() => void) | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _pendingVisibleIds = new Map<number, (ids: string[]) => void>();
    private _nextRequestId = 1;

    public static createOrShow(extensionUri: vscode.Uri, store: LogStore, bus: LogEventBus) {
        if (LogDashboard.currentPanel) {
            LogDashboard.currentPanel._panel.reveal(vscode.ViewColumn.One);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'logDashboard',
            'Local Log Viewer',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        LogDashboard.currentPanel = new LogDashboard(panel, extensionUri, store, bus);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        private readonly _store: LogStore,
        bus: LogEventBus
    ) {
        this._panel = panel;
        this._panel.webview.html = this._getHtmlForWebview(extensionUri);

        this._disposables.push(
            bus.onLogReceived(log => {
                this.post({ command: 'addLog', log });
            })
        );

        this._panel.webview.onDidReceiveMessage(
            (message: WebviewToExtensionMessage) => {
                switch (message.command) {
                    case 'loadMore':
                        this.sendHistoryToWebview();
                        return;
                    case 'ready':
                        // webview is ready, send history so it can render persisted logs
                        this.sendHistoryToWebview();
                        return;
                    case 'stopAll':
                        // ask extension to stop any running captures
                        vscode.commands.executeCommand('local-log-viewer.stopAllCaptures');
                        return;
                    case 'clearLogs':
                        this._store.clear();
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
    }

    private post(message: ExtensionToWebviewMessage) {
        this._panel.webview.postMessage(message);
    }

    private sendHistoryToWebview() {
        this.post({ command: 'loadHistory', logs: this._store.getAll() });
    }

    /** Asks the webview for the ids of the currently visible (filtered) entries. */
    public requestVisibleIds(): Promise<string[] | null> {
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
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) { x.dispose(); }
        }
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
                <title>Local Log Viewer</title>
            </head>
            <body>
                <div class="dashboard">
                    <div id="log-section" class="log-section">
                        <div class="toolbar" role="toolbar" aria-label="Log filters and actions">
                            <div class="search-wrap">
                                <input type="text" id="search-input" class="search-input"
                                    placeholder='Search…  level:error  after:14:30  "phrase"  -term  /regex/i'
                                    aria-label="Search logs" aria-describedby="search-help" autocomplete="off" spellcheck="false" />
                                <div id="search-hint" class="search-hint" role="alert" hidden></div>
                                <div id="search-help" class="search-help" hidden>
                                    <div class="search-help-title">Search syntax</div>
                                    <div><code>error timeout</code> — every term must match</div>
                                    <div><code>"exact phrase"</code> &nbsp;·&nbsp; <code>-exclude</code></div>
                                    <div><code>level:error</code> &nbsp;·&nbsp; <code>source:api</code> &nbsp;·&nbsp; <code>user.name:alice</code></div>
                                    <div><code>after:14:30</code> &nbsp;·&nbsp; <code>before:2026-07-02T15:00</code> — time filters</div>
                                    <div><code>/regex/i</code> — safe regular expressions</div>
                                </div>
                            </div>

                            <div class="severity-filters" role="group" aria-label="Severity filters">
                                <button type="button" class="filter-badge badge-error" data-level="error" aria-pressed="false">Error<span class="pill-count" id="count-error">0</span></button>
                                <button type="button" class="filter-badge badge-warn" data-level="warn" aria-pressed="false">Warn<span class="pill-count" id="count-warn">0</span></button>
                                <button type="button" class="filter-badge badge-info" data-level="info" aria-pressed="false">Info<span class="pill-count" id="count-info">0</span></button>
                                <button type="button" class="filter-badge badge-debug" data-level="debug" aria-pressed="false">Debug<span class="pill-count" id="count-debug">0</span></button>
                                <button type="button" class="filter-badge badge-trace" data-level="trace" aria-pressed="false">Trace<span class="pill-count" id="count-trace">0</span></button>
                            </div>

                            <span id="log-counter" class="log-counter" title="Visible / total logs">0 / 0</span>

                            <span class="toolbar-divider" aria-hidden="true"></span>
                            <div class="toolbar-action-group">
                                <span class="toolbar-group-label" aria-hidden="true">Add</span>
                                <button id="paste-btn" class="icon-btn icon-btn-text" type="button" aria-label="Paste logs from clipboard" title="Paste logs">📋 Paste</button>
                            </div>
                            <span class="toolbar-divider" aria-hidden="true"></span>
                            <div class="toolbar-action-group">
                                <span class="toolbar-group-label" aria-hidden="true">Actions</span>
                                <button id="export-btn" class="icon-btn icon-btn-text" type="button" aria-label="Export visible logs to file" title="Export logs">💾 Export</button>
                                <button id="clear-btn" class="icon-btn icon-btn-text" type="button" aria-label="Clear log history" title="Clear logs">🗑 Clear</button>
                                <button id="stop-btn" class="icon-btn icon-btn-text" type="button" aria-label="Stop all active captures" title="Stop all">⏹ Stop</button>
                            </div>
                            <span class="toolbar-divider" aria-hidden="true"></span>
                            <button id="density-btn" class="icon-btn" type="button" aria-pressed="false" aria-label="Toggle compact row height" title="Compact rows">▦</button>
                        </div>

                        <div id="log-histogram" class="log-histogram" role="group" aria-label="Log volume timeline — click a bar to filter, drag to select a range"></div>
                        <div id="time-filter-label" class="time-chip" hidden>
                            <span id="time-filter-text"></span>
                            <button id="time-filter-clear" class="time-chip-clear" type="button" aria-label="Clear time filter">✕</button>
                        </div>

                        <div class="log-col-header" aria-hidden="true">
                            <span>Time</span>
                            <span>Level</span>
                            <span>Source</span>
                            <span>Message</span>
                        </div>

                        <div class="log-body">
                            <div id="log-container" class="log-container" role="listbox" aria-label="Log entries" tabindex="0"></div>

                            <div id="loading-state" class="state-overlay" aria-hidden="true">
                                <div class="skeleton-rows">
                                    <div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div>
                                    <div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div>
                                </div>
                            </div>

                            <div id="empty-state" class="state-overlay" hidden>
                                <div class="state-card">
                                    <div class="state-icon" aria-hidden="true">▤</div>
                                    <h3>No logs yet</h3>
                                    <p>Run a command and stream its output, or follow a log file on disk.<br/>Logs never leave your machine.</p>
                                    <div class="state-actions">
                                        <button id="empty-run-btn" class="btn btn-primary" type="button">Run a command</button>
                                        <button id="empty-follow-btn" class="btn" type="button">Follow a log file</button>
                                        <button id="empty-paste-btn" class="btn" type="button">Paste logs</button>
                                    </div>
                                    <p class="state-tip">Tip: press <kbd>/</kbd> to search, <kbd>↑</kbd><kbd>↓</kbd> to navigate, <kbd>Enter</kbd> for details.</p>
                                </div>
                            </div>

                            <div id="no-results-state" class="state-overlay" hidden>
                                <div class="state-card">
                                    <div class="state-icon" aria-hidden="true">⌕</div>
                                    <h3>No results for this query</h3>
                                    <p>No log entries match the current search, severity or time filters.</p>
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

                    <div id="detail-panel" class="detail-panel" role="complementary" aria-label="Log details">
                        <div class="detail-header">
                            <span class="detail-title">Log details</span>
                            <span id="redacted-badge" class="redacted-badge" title="One or more secret values in this entry were masked before display" hidden>🛡 redacted</span>
                            <button class="close-btn" id="close-panel-btn" type="button" aria-label="Close details">✕</button>
                        </div>
                        <div class="detail-content">
                            <div class="section-title">Attributes</div>
                            <table class="attributes-table" id="attributes-table"></table>
                            <div class="json-header">
                                <div class="section-title">Message</div>
                                <div class="json-actions">
                                    <button id="copy-message-btn" class="json-action-btn" type="button">Copy</button>
                                </div>
                            </div>
                            <pre id="message-content" class="message-code"></pre>
                            <div class="json-header">
                                <div class="section-title">JSON Raw</div>
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

                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>
        `;
    }
}
