import * as vscode from 'vscode';
import { LogParser } from './logParser';
import { LogEntry, LogLevel } from './models/logEntry';

export class LogDashboard {
    public static currentPanel: LogDashboard | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    
    private _allLogs: LogEntry[] = [];
    private readonly MAX_HISTORY_RECORDS = 10000;

    public static createOrShow(extensionUri: vscode.Uri) {
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
                localResourceRoots: [extensionUri]
            }
        );

        LogDashboard.currentPanel = new LogDashboard(panel, extensionUri);
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._panel.webview.html = this._getHtmlForWebview(extensionUri);

        this._panel.webview.onDidReceiveMessage(
            message => {
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
                        this._allLogs = [];
                        return;
                }
            },
            null,
            this._disposables
        );

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public addLogLine(rawLine: string, overrideLevel?: LogLevel) {
        const parsed = LogParser.parseLine(rawLine);
        if (parsed) {
            // If parser detected an explicit level marker, do not override
            const hasMarker = parsed.raw && (parsed.raw as any).__hasLevelMarker;
            if (overrideLevel && !hasMarker) {
                parsed.level = overrideLevel;
            }

            this._allLogs.push(parsed);
            
            if (this._allLogs.length > this.MAX_HISTORY_RECORDS) {
                this._allLogs.shift();
            }
            
            this._panel.webview.postMessage({ command: 'addLog', log: parsed });
        }
    }

    private sendHistoryToWebview() {
        this._panel.webview.postMessage({ command: 'loadHistory', logs: this._allLogs });
    }

    public dispose() {
        void vscode.commands.executeCommand('local-log-viewer.stopAllCaptures');
        LogDashboard.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) { x.dispose(); }
        }
    }

    private _getHtmlForWebview(extensionUri: vscode.Uri): string {
        const webview = this._panel.webview;

        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'webview', 'style.css'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'webview', 'script.js'));

        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src ${webview.cspSource}; font-src ${webview.cspSource}; base-uri 'none'; connect-src 'none';">
                <link rel="stylesheet" href="${styleUri}">
                <title>Local Log Viewer</title>
            </head>
            <body>
                <div class="dashboard">
                    <div id="log-section" class="log-section">
                        <div class="header-container">
                            <h2>Local Log Console</h2>
                            <div class="badge-container">
                                <button id="load-more-btn" class="btn btn-primary">Load Initial Logs</button>
                                <span id="log-counter" class="log-counter">0 visible / 0 total</span>
                                <div class="counts-container">
                                    <div id="count-error" class="log-count" title="Errors">Error: 0</div>
                                    <div id="count-warn" class="log-count" title="Warnings">Warn: 0</div>
                                    <div id="count-info" class="log-count" title="Info">Info: 0</div>
                                    <div id="count-debug" class="log-count" title="Debug">Debug: 0</div>
                                </div>
                            </div>
                        </div>
                        
                        <div class="toolbar">
                            <input type="text" id="search-input" class="search-input" placeholder="Search logs... (e.g. correlationId)" />
                            
                            <div class="severity-filters">
                                <div class="filter-badge badge-error" data-level="error">Error</div>
                                <div class="filter-badge badge-warn" data-level="warn">Warn</div>
                                <div class="filter-badge badge-info" data-level="info">Info</div>
                                <div class="filter-badge badge-debug" data-level="debug">Debug</div>
                            </div>
                            
                            <button id="clear-btn" class="btn btn-danger">Clear</button>
                            <button id="stop-btn" class="btn">Stop</button>
                            <label class="truncate-label" for="truncate-select">Truncate:</label>
                            <select id="truncate-select" class="truncate-select" aria-label="Maximum message length">
                                <option value="2000">2000</option>
                                <option value="1000">1000</option>
                                <option value="500">500</option>
                                <option value="0">None</option>
                            </select>
                        </div>

                        <div id="log-container" class="log-container"></div>
                    </div>
                    
                    <div id="detail-panel" class="detail-panel">
                        <div class="detail-header">
                            <span class="detail-title">Log Asset Attributes</span>
                            <button class="close-btn" id="close-panel-btn">✕</button>
                        </div>
                        <div class="detail-content">
                            <div class="section-title">Attributes</div>
                            <table class="attributes-table" id="attributes-table"></table>
                            <div class="section-title">JSON Raw</div>
                            <pre id="json-content" class="json-raw"></pre>
                        </div>
                    </div>
                </div>

                <script src="${scriptUri}"></script>
            </body>
            </html>
        `;
    }
}