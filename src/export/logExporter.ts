import * as vscode from 'vscode';
import { LogStore } from '../store/logStore';
import { LogDashboard } from '../logDashboard';
import { serializeLogs, suggestedFileName, ExportFormat } from './serialize';

interface FormatPick extends vscode.QuickPickItem {
    format: ExportFormat;
}

/**
 * Export flow: format → scope (all / current dashboard view) → save dialog.
 * Entries were redacted at ingest, so exports never contain raw secrets.
 */
export async function exportLogsFlow(store: LogStore): Promise<void> {
    if (store.count() === 0) {
        vscode.window.showInformationMessage('There are no logs to export yet.');
        return;
    }

    const formatPick = await vscode.window.showQuickPick<FormatPick>([
        { label: 'NDJSON', description: 'one JSON object per line — best for tooling', format: 'ndjson' },
        { label: 'JSON', description: 'pretty-printed JSON array', format: 'json' },
        { label: 'Plain text', description: 'timestamp [level] source — message', format: 'text' }
    ], { placeHolder: 'Export format' });
    if (!formatPick) { return; }

    let entries = store.getAll();

    // Offer the filtered view only when the dashboard is open to answer.
    const dashboard = LogDashboard.currentPanel;
    if (dashboard) {
        const scope = await vscode.window.showQuickPick([
            { label: `All logs (${entries.length})`, id: 'all' },
            { label: 'Current view (search/severity/time filters applied)', id: 'view' }
        ], { placeHolder: 'Which logs?' });
        if (!scope) { return; }
        if (scope.id === 'view') {
            const ids = await dashboard.requestVisibleIds();
            if (ids === null) {
                vscode.window.showWarningMessage('Could not read the current view — exporting all logs instead.');
            } else {
                const visible = new Set(ids);
                entries = entries.filter(e => visible.has(e.id));
            }
        }
    }

    const defaultDir = vscode.workspace.workspaceFolders?.[0]?.uri;
    const fileName = suggestedFileName(formatPick.format, new Date());
    const target = await vscode.window.showSaveDialog({
        defaultUri: defaultDir ? vscode.Uri.joinPath(defaultDir, fileName) : vscode.Uri.file(fileName),
        filters: formatPick.format === 'text'
            ? { 'Log files': ['log', 'txt'] }
            : { 'JSON files': [formatPick.format === 'ndjson' ? 'ndjson' : 'json'] }
    });
    if (!target) { return; }

    const content = serializeLogs(entries, formatPick.format);
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(content));

    const open = await vscode.window.showInformationMessage(
        `Exported ${entries.length} log entries to ${target.fsPath}`,
        'Open File'
    );
    if (open === 'Open File') {
        void vscode.window.showTextDocument(target);
    }
}
