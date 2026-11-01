import * as vscode from 'vscode';
import { LogDashboard } from './logDashboard';
import { LogStore } from './store/logStore';
import { LogEventBus } from './events/logEventBus';
import { CommandStore } from './store/commandStore';
import { LogPipeline } from './core/logPipeline';
import { CaptureManager } from './core/captureManager';
import { FileTailManager } from './core/fileTail';
import { SessionRegistry } from './core/sessionRegistry';
import { importPastedText } from './core/pasteImport';
import * as config from './core/config';
import { pickCommand, manageSavedCommands } from './ui/commandPicker';
import { CapturesTreeProvider, CaptureItem, SavedCommandItem } from './sidebar/capturesTreeProvider';
import { exportLogsFlow } from './export/logExporter';
import { McpServerManager } from './mcp/mcpServerManager';
import { registerMcpProviderIfAvailable } from './mcp/mcpVsCodeProvider';
import { buildMcpSetupSnippets } from './mcp/mcpSetup';
import { SourceResolver } from './core/sourceResolver';
import { ProblemsReporter } from './core/problemsReporter';
import { DebugCaptureManager } from './core/debugCapture';
import * as fs from 'fs';

let stopAllForDeactivate: (() => Promise<void>) | undefined;

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('Local Logs Console');
    const store = new LogStore(config.historyLimit());
    const bus = new LogEventBus();
    const registry = new SessionRegistry();
    const pipeline = new LogPipeline(store, bus);
    const captures = new CaptureManager(pipeline, registry, outputChannel);
    const tails = new FileTailManager(pipeline, registry, outputChannel);
    const commandStore = new CommandStore(context.workspaceState);
    const resolver = new SourceResolver(() => (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath));
    const problems = new ProblemsReporter(bus, store, registry, resolver);
    const debugCaptures = new DebugCaptureManager(pipeline, registry);

    const openDashboard = () => LogDashboard.createOrShow(context.extensionUri, store, bus, registry);

    function stopAllCaptures(logMessage = true): Promise<void> {
        tails.stopAll();
        const stopped = captures.stopAll();
        if (logMessage) {
            outputChannel.appendLine('Captures stopped by user action.');
        }
        return stopped;
    }
    // On shutdown, escalate faster: the extension host will not wait long.
    stopAllForDeactivate = () => {
        tails.stopAll();
        return captures.stopAll({ term: 300, kill: 1000 });
    };

    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'local-log-viewer.openDashboard';
    // errors that arrived while the dashboard was not on screen
    let unseenErrors = 0;
    let dashboardVisible = false;
    let statusTimer: ReturnType<typeof setTimeout> | undefined;
    const updateStatusBar = () => {
        const active = registry.activeCount;
        const base = active > 0 ? `$(output) Local Logs · ${active}` : '$(output) Local Logs';
        statusBarItem.text = unseenErrors > 0 ? `${base}  $(error) ${unseenErrors}` : base;
        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown('Open the Local Logs Console dashboard\n\n');
        if (unseenErrors > 0) {
            tooltip.appendMarkdown(`${unseenErrors} new error${unseenErrors === 1 ? '' : 's'} since you last looked\n\n`);
        }
        tooltip.appendMarkdown(mcp.running && mcp.endpoint
            ? `MCP server: \`${mcp.endpoint}\``
            : 'MCP server: off');
        statusBarItem.tooltip = tooltip;
    };

    const AUTO_PORT_KEY = 'localLogViewer.mcp.autoPort';
    const mcp = new McpServerManager({
        secrets: context.secrets,
        store,
        registry,
        bus,
        outputChannel,
        serverVersion: String(context.extension.packageJSON.version ?? '0.0.0'),
        // Remember the auto-selected port per workspace so saved agent configs
        // (Claude Code, .mcp.json, Cursor) survive VS Code restarts.
        portMemory: {
            get: () => context.workspaceState.get<number>(AUTO_PORT_KEY),
            set: port => context.workspaceState.update(AUTO_PORT_KEY, port)
        },
        onPortDrift: (previousPort, currentPort) => {
            void vscode.window.showWarningMessage(
                `Local Logs Console: MCP port changed from ${previousPort} to ${currentPort} ` +
                `(the previous port was unavailable). Re-copy the setup so your coding agent can reconnect.`,
                'Copy MCP Setup'
            ).then(choice => {
                if (choice === 'Copy MCP Setup') {
                    void vscode.commands.executeCommand('local-log-viewer.copyMcpSetup');
                }
            });
        },
        onStateChange: () => {
            updateStatusBar();
            mcpProvider?.refresh();
        }
    });
    const mcpProvider = registerMcpProviderIfAvailable(context, mcp);
    void mcp.syncWithConfig(); // never blocks activation; errors go to the output channel

    updateStatusBar();
    statusBarItem.show();

    LogDashboard.onVisibilityChange = visible => {
        dashboardVisible = visible;
        if (visible && unseenErrors > 0) {
            unseenErrors = 0;
            updateStatusBar();
        }
    };
    const errorWatcher = bus.onLogReceived(entry => {
        if (entry.level !== 'ERROR' || dashboardVisible) { return; }
        unseenErrors++;
        // a crash loop logs hundreds of errors — repaint at most 4×/s
        statusTimer ??= setTimeout(() => { statusTimer = undefined; updateStatusBar(); }, 250);
    });
    const clearWatcher = store.onDidClear(() => {
        unseenErrors = 0;
        updateStatusBar();
    });

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
        const picked = await pickCommand(commandStore);
        if (!picked) { return; }
        captures.runAndCapture(picked.command, picked.cwd);
    }

    /** Opens a stack-frame location; only files inside the workspace (or the capture's cwd) open directly. */
    async function openSource(target?: { file?: unknown; line?: unknown; column?: unknown; sessionId?: unknown }) {
        if (!target || typeof target.file !== 'string' || typeof target.line !== 'number') { return; }
        const file = target.file;
        const line = Math.max(1, Math.floor(target.line));
        const column = typeof target.column === 'number' ? Math.max(1, Math.floor(target.column)) : 1;
        const cwd = typeof target.sessionId === 'string' ? registry.get(target.sessionId)?.cwd : undefined;

        let resolved = await resolver.resolveAsync(file, cwd, async name => {
            if (!/^[\w.$-]+$/.test(name)) { return []; }
            const uris = await vscode.workspace.findFiles(`**/${name}`, '**/node_modules/**', 5);
            return uris.map(u => u.fsPath);
        });
        if (!resolved) {
            const exists = (() => { try { return fs.statSync(file).isFile(); } catch { return false; } })();
            if (!exists) {
                vscode.window.showInformationMessage(`Local Logs Console: couldn't find "${file}" in this workspace.`);
                return;
            }
            const choice = await vscode.window.showWarningMessage(
                `"${file}" is outside this workspace. Open it anyway?`,
                'Open'
            );
            if (choice !== 'Open') { return; }
            resolved = file;
        }
        const position = new vscode.Position(line - 1, column - 1);
        await vscode.window.showTextDocument(vscode.Uri.file(resolved), {
            selection: new vscode.Range(position, position),
            preview: true,
            viewColumn: vscode.ViewColumn.Beside
        });
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
        new vscode.Disposable(() => {
            LogDashboard.onUserDispose = undefined;
            LogDashboard.onVisibilityChange = undefined;
            if (statusTimer) { clearTimeout(statusTimer); }
        }),
        errorWatcher,
        clearWatcher,
        problems,
        debugCaptures,
        vscode.workspace.onDidCreateFiles(() => resolver.reset()),
        vscode.workspace.onDidDeleteFiles(() => resolver.reset()),
        vscode.workspace.onDidChangeWorkspaceFolders(() => resolver.reset()),
        // bring the dashboard back after a VS Code restart
        vscode.window.registerWebviewPanelSerializer(LogDashboard.viewType, {
            deserializeWebviewPanel: async (panel: vscode.WebviewPanel) => {
                LogDashboard.revive(panel, context.extensionUri, store, bus, registry);
            }
        }),
        mcp,
        registry.onDidChangeSessions(updateStatusBar),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (config.affectsConfiguration(e)) {
                pipeline.refreshConfig();
                store.setLimit(config.historyLimit());
                if (e.affectsConfiguration('localLogViewer.problems.enabled') && !config.problemsEnabled()) {
                    problems.clearAll();
                }
                if (e.affectsConfiguration('localLogViewer.mcp')) {
                    void mcp.syncWithConfig();
                }
            }
        }),
        new vscode.Disposable(() => { void stopAllCaptures(false); }),

        vscode.commands.registerCommand('local-log-viewer.openDashboard', async () => {
            openDashboard();
            // Only ask for a source when there is nothing to show yet — the
            // status bar and sidebar use this command just to open the view.
            if (store.count() > 0 || registry.activeCount > 0) { return; }

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
                `Copied MCP setup for ${workspaceName} — port ${mcp.port}. This port is remembered for this workspace, so the config keeps working across restarts.`
            );
        }),

        // Sidebar item actions (hidden from the Command Palette — they take tree args)
        vscode.commands.registerCommand('local-log-viewer.stopCapture', (item?: CaptureItem) => {
            if (item?.session) {
                try { item.session.stop(); } catch { /* already gone */ }
            }
        }),

        vscode.commands.registerCommand('local-log-viewer.restartCapture', (item?: CaptureItem) => {
            if (item?.session?.restart) {
                openDashboard();
                void registry.restart(item.session.id);
            }
        }),

        // Stop (if needed) and start again the most recent capture — the edit → rerun loop.
        vscode.commands.registerCommand('local-log-viewer.restartLastCapture', () => {
            const latest = registry.latestRestartable();
            if (!latest) {
                vscode.window.showInformationMessage('Nothing to restart yet — run a command or follow a file first.');
                return;
            }
            openDashboard();
            void registry.restart(latest.id);
        }),

        vscode.commands.registerCommand('local-log-viewer.openSource', openSource),

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
            void stopAllCaptures();
            vscode.window.showInformationMessage('Captures stopped.');
        }),

        vscode.commands.registerCommand('local-log-viewer.pasteLogs', (text?: string, label?: string) => {
            if (!text || !text.trim()) { return; }
            const { imported, skipped } = importPastedText(pipeline, text, label);
            vscode.window.showInformationMessage(
                imported > 0
                    ? `Imported ${imported} log line${imported === 1 ? '' : 's'}${skipped ? ` (${skipped} blank line${skipped === 1 ? '' : 's'} skipped)` : ''}.`
                    : 'No log lines found in the pasted text.'
            );
        }),

        vscode.commands.registerCommand('local-log-viewer.pasteLogsFromClipboard', async () => {
            const text = await vscode.env.clipboard.readText();
            if (!text || !text.trim()) {
                vscode.window.showInformationMessage('Clipboard is empty or has no text.');
                return;
            }
            const label = await vscode.window.showInputBox({
                prompt: 'Label for this paste (optional)',
                placeHolder: 'pasted',
                validateInput: () => null
            });
            if (label === undefined) { return; } // cancelled
            openDashboard();
            const { imported, skipped } = importPastedText(pipeline, text, label.trim() || 'pasted');
            vscode.window.showInformationMessage(
                imported > 0
                    ? `Imported ${imported} log line${imported === 1 ? '' : 's'}${skipped ? ` (${skipped} line${skipped === 1 ? '' : 's'} skipped)` : ''}.`
                    : 'No log lines found on the clipboard.'
            );
        }),

        vscode.commands.registerCommand('local-log-viewer.addNewCommand', async () => {
            const command = await vscode.window.showInputBox({
                prompt: 'Enter a new command',
                placeHolder: 'e.g., npm test, npm run dev, python script.py',
                validateInput: (value) => {
                    if (!value.trim()) {
                        return 'Command cannot be empty';
                    }
                    return null;
                }
            });
            if (command && command.trim()) {
                commandStore.add(command);
                vscode.window.showInformationMessage(`Command saved: ${command}`);
            }
        })
    );
}

export function deactivate(): Promise<void> | undefined {
    return stopAllForDeactivate?.();
}
