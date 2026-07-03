import * as vscode from 'vscode';
import { LogDashboard } from './logDashboard';
import { LogStore } from './store/logStore';
import { LogEventBus } from './events/logEventBus';
import { CommandStore } from './store/commandStore';
import { LogPipeline } from './core/logPipeline';
import { CaptureManager } from './core/captureManager';
import { FileTailManager } from './core/fileTail';
import { SessionRegistry } from './core/sessionRegistry';
import * as config from './core/config';
import { pickCommand, manageSavedCommands } from './ui/commandPicker';
import { CapturesTreeProvider, CaptureItem, SavedCommandItem } from './sidebar/capturesTreeProvider';
import { exportLogsFlow } from './export/logExporter';
import { McpServerManager } from './mcp/mcpServerManager';
import { registerMcpProviderIfAvailable } from './mcp/mcpVsCodeProvider';
import { buildMcpSetupSnippets } from './mcp/mcpSetup';

let stopAllForDeactivate: (() => void) | undefined;

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('Local Log Viewer');
    const store = new LogStore(() => config.historyLimit());
    const bus = new LogEventBus();
    const registry = new SessionRegistry();
    const pipeline = new LogPipeline(store, bus);
    const captures = new CaptureManager(pipeline, registry, outputChannel);
    const tails = new FileTailManager(pipeline, registry, outputChannel);
    const commandStore = new CommandStore(context.workspaceState);

    const openDashboard = () => LogDashboard.createOrShow(context.extensionUri, store, bus);

    function stopAllCaptures(logMessage = true) {
        tails.stopAll();
        captures.stopAll();
        if (logMessage) {
            outputChannel.appendLine('Captures stopped by user action.');
        }
    }
    stopAllForDeactivate = () => stopAllCaptures(false);

    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'local-log-viewer.openDashboard';
    const updateStatusBar = () => {
        const active = registry.activeCount;
        statusBarItem.text = active > 0 ? `$(output) Local Logs · ${active}` : '$(output) Local Logs';
        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown('Open Local Log Viewer Dashboard\n\n');
        tooltip.appendMarkdown(mcp.running && mcp.endpoint
            ? `MCP server: \`${mcp.endpoint}\``
            : 'MCP server: off');
        statusBarItem.tooltip = tooltip;
    };

    const mcp = new McpServerManager({
        secrets: context.secrets,
        store,
        registry,
        bus,
        outputChannel,
        serverVersion: String(context.extension.packageJSON.version ?? '0.0.0'),
        onStateChange: () => {
            updateStatusBar();
            mcpProvider?.refresh();
        }
    });
    const mcpProvider = registerMcpProviderIfAvailable(context, mcp);
    void mcp.syncWithConfig(); // never blocks activation; errors go to the output channel

    updateStatusBar();
    statusBarItem.show();

    async function followFileFlow(uri?: vscode.Uri) {
        if (uri?.fsPath) {
            tails.follow(uri.fsPath);
            return;
        }
        const uris = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Log files': ['log', 'txt', '*'] } });
        if (!uris || uris.length === 0) { return; }
        tails.follow(uris[0].fsPath);
    }

    async function runCommandFlow() {
        const cmd = await pickCommand(commandStore);
        if (!cmd) { return; }
        captures.runAndCapture(cmd);
    }

    // Sidebar tree (Activity Bar)
    const treeProvider = new CapturesTreeProvider(registry, commandStore);

    // Closing the dashboard no longer kills captures — explain that once.
    const NOTICE_KEY = 'local-log-viewer.backgroundCaptureNoticeShown';
    LogDashboard.onUserDispose = () => {
        if (registry.activeCount > 0 && !context.globalState.get<boolean>(NOTICE_KEY)) {
            void context.globalState.update(NOTICE_KEY, true);
            vscode.window.showInformationMessage(
                'Captures keep running in the background — manage them from the Local Logs sidebar or the status bar item.'
            );
        }
    };

    context.subscriptions.push(
        outputChannel,
        statusBarItem,
        registry,
        bus,
        treeProvider,
        vscode.window.registerTreeDataProvider('localLogsConsole.captures', treeProvider),
        new vscode.Disposable(() => { LogDashboard.onUserDispose = undefined; }),
        mcp,
        registry.onDidChangeSessions(updateStatusBar),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (config.affectsConfiguration(e)) {
                pipeline.refreshConfig();
                if (e.affectsConfiguration('localLogViewer.mcp')) {
                    void mcp.syncWithConfig();
                }
            }
        }),
        new vscode.Disposable(() => stopAllCaptures(false)),

        vscode.commands.registerCommand('local-log-viewer.openDashboard', async () => {
            openDashboard();

            const pick = await vscode.window.showQuickPick([
                { label: 'Follow log file' },
                { label: 'Run and capture command' },
                { label: 'Cancel' }
            ], { placeHolder: 'Choose the log source' });

            if (!pick || pick.label === 'Cancel') { return; }
            if (pick.label === 'Follow log file') {
                await followFileFlow();
                return;
            }
            if (pick.label === 'Run and capture command') {
                await runCommandFlow();
            }
        }),

        vscode.commands.registerCommand('local-log-viewer.runAndCapture', async () => {
            openDashboard();
            await runCommandFlow();
        }),

        // Reachable from the dashboard's empty state, the sidebar welcome view
        // and the explorer context menu on .log/.txt files.
        vscode.commands.registerCommand('local-log-viewer.followFile', async (uri?: vscode.Uri) => {
            openDashboard();
            await followFileFlow(uri);
        }),

        vscode.commands.registerCommand('local-log-viewer.exportLogs', async () => {
            await exportLogsFlow(store);
        }),

        vscode.commands.registerCommand('local-log-viewer.copyMcpSetup', async () => {
            if (!mcp.running || !mcp.endpoint || !mcp.token) {
                const choice = await vscode.window.showInformationMessage(
                    'The MCP server is off — enable "localLogViewer.mcp.enabled" to let coding agents read your logs.',
                    'Open Settings'
                );
                if (choice === 'Open Settings') {
                    void vscode.commands.executeCommand('workbench.action.openSettings', 'localLogViewer.mcp');
                }
                return;
            }

            const snippets = buildMcpSetupSnippets(mcp.endpoint, mcp.token);
            const picked = await vscode.window.showQuickPick(
                snippets.map(s => ({ label: s.label, detail: s.detail, snippet: s })),
                { placeHolder: 'Copy MCP setup for…' }
            );
            if (!picked) { return; }

            await vscode.env.clipboard.writeText(picked.snippet.text);
            const workspaceName = vscode.workspace.workspaceFolders?.[0]?.name ?? 'this window';
            vscode.window.showInformationMessage(
                `Copied MCP setup for ${workspaceName} — port ${mcp.port}. Tip: pin "localLogViewer.mcp.port" in workspace settings so saved configs survive restarts.`
            );
        }),

        // Sidebar item actions (hidden from the Command Palette — they take tree args)
        vscode.commands.registerCommand('local-log-viewer.stopCapture', (item?: CaptureItem) => {
            if (item?.session) {
                try { item.session.stop(); } catch { /* already gone */ }
            }
        }),

        vscode.commands.registerCommand('local-log-viewer.runSavedCommand', (item?: SavedCommandItem) => {
            if (item?.commandText) {
                commandStore.add(item.commandText); // move to front (MRU)
                openDashboard();
                captures.runAndCapture(item.commandText);
            }
        }),

        vscode.commands.registerCommand('local-log-viewer.editSavedCommand', async (item?: SavedCommandItem) => {
            if (!item?.commandText) { return; }
            const updated = await vscode.window.showInputBox({
                prompt: 'Edit command',
                value: item.commandText,
                placeHolder: 'Shell command'
            });
            if (updated && updated.trim()) {
                commandStore.replace(item.commandText, updated);
            }
        }),

        vscode.commands.registerCommand('local-log-viewer.deleteSavedCommand', (item?: SavedCommandItem) => {
            if (item?.commandText) {
                commandStore.remove(item.commandText);
            }
        }),

        vscode.commands.registerCommand('local-log-viewer.manageCommands', async () => {
            if (commandStore.getAll().length === 0) {
                vscode.window.showInformationMessage('No saved commands yet. Run one with "Local Logs Console: Run and Capture Command" first.');
                return;
            }
            const cmd = await manageSavedCommands(commandStore);
            if (!cmd) { return; }
            openDashboard();
            captures.runAndCapture(cmd);
        }),

        vscode.commands.registerCommand('local-log-viewer.runLastCommand', async () => {
            const last = commandStore.last();
            if (!last) {
                vscode.window.showInformationMessage('No saved command to run yet.');
                return;
            }

            // This re-executes an arbitrary stored shell command — confirm by
            // default; power users can disable via settings.
            if (config.confirmRunLastCommand()) {
                const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                const choice = await vscode.window.showWarningMessage(
                    `Run "${last}"${cwd ? ` in ${cwd}` : ''}?`,
                    { modal: true },
                    'Run'
                );
                if (choice !== 'Run') { return; }
            }

            openDashboard();
            captures.runAndCapture(last);
        }),

        vscode.commands.registerCommand('local-log-viewer.stopAllCaptures', () => {
            if (registry.activeCount === 0 && !captures.hasRunning) {
                vscode.window.showInformationMessage('No active process to stop.');
                return;
            }
            stopAllCaptures();
            vscode.window.showInformationMessage('Captures stopped.');
        })
    );
}

export function deactivate() {
    if (stopAllForDeactivate) {
        stopAllForDeactivate();
    }
}
