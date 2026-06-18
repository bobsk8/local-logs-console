import * as vscode from 'vscode';
import { LogDashboard } from './logDashboard';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { LogLevel } from './models/logEntry';

let stopAllCapturesGlobal: (() => void) | undefined;

export function activate(context: vscode.ExtensionContext) {
    const runningChildren = new Set<ChildProcess>();
    const activeWatchers = new Set<fs.FSWatcher>();
    const mutedProcessPids = new Set<number>();
    const outputChannel = vscode.window.createOutputChannel('Local Log Viewer');

    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = 'local-log-viewer.openDashboard';
    statusBarItem.text = '$(output) Local Logs';
    statusBarItem.tooltip = 'Open Local Log Viewer Dashboard';
    statusBarItem.show();

    const disposable = vscode.commands.registerCommand(
        'local-log-viewer.openDashboard',
        async () => {
            LogDashboard.createOrShow(context.extensionUri);

            const pick = await vscode.window.showQuickPick([
                { label: 'Follow log file' },
                { label: 'Run and capture command' },
                { label: 'Cancel' }
            ], { placeHolder: 'Choose the log source' });

            if (!pick || pick.label === 'Cancel') return;

            if (pick.label === 'Follow log file') {
                const uris = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Log files': ['log', 'txt', '*'] } });
                if (!uris || uris.length === 0) return;
                const filePath = uris[0].fsPath;
                startTailFile(filePath);
                return;
            }

            if (pick.label === 'Run and capture command') {
                const cmd = await vscode.window.showInputBox({ prompt: 'Command to run (e.g. npm run dev)', placeHolder: 'Shell command' });
                if (!cmd) return;
                runAndCapture(cmd);
                return;
            }
        }
    );

    context.subscriptions.push(disposable);
    context.subscriptions.push(outputChannel);
    context.subscriptions.push(statusBarItem);

    context.subscriptions.push(vscode.commands.registerCommand('local-log-viewer.runAndCapture', async () => {
        LogDashboard.createOrShow(context.extensionUri);
        const cmd = await vscode.window.showInputBox({ prompt: 'Command to run (e.g. npm run dev)', placeHolder: 'Shell command' });
        if (!cmd) {
            return;
        }
        runAndCapture(cmd);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('local-log-viewer.stopAllCaptures', async () => {
        if (runningChildren.size === 0 && activeWatchers.size === 0) {
            vscode.window.showInformationMessage('No active process to stop.');
            return;
        }

        stopAllCaptures();
        vscode.window.showInformationMessage('Captures stopped.');
    }));

    context.subscriptions.push(new vscode.Disposable(() => {
        stopAllCaptures(false);
    }));

    stopAllCapturesGlobal = () => stopAllCaptures(false);

    function getChildPidsPosix(parentPid: number): number[] {
        const pids: number[] = [];
        const queue: number[] = [parentPid];

        while (queue.length > 0) {
            const current = queue.shift();
            if (!current) {
                continue;
            }

            const out = spawnSync('ps', ['-o', 'pid=', '--ppid', String(current)], {
                encoding: 'utf8'
            });

            if (out.status !== 0 || !out.stdout) {
                continue;
            }

            const children = out.stdout
                .split(/\r?\n/)
                .map(s => s.trim())
                .filter(Boolean)
                .map(n => Number(n))
                .filter(n => Number.isInteger(n) && n > 0);

            for (const childPid of children) {
                pids.push(childPid);
                queue.push(childPid);
            }
        }

        return pids;
    }

    function signalPosixProcessTree(rootPid: number, signal: NodeJS.Signals) {
        // First try process-group signaling when available.
        try {
            process.kill(-rootPid, signal);
            return;
        } catch {
            // fall back to recursive PPID traversal
        }

        const descendants = getChildPidsPosix(rootPid);

        // Signal children first, then root process.
        for (const pid of descendants.reverse()) {
            try {
                process.kill(pid, signal);
            } catch {
                // ignore dead/unreachable child
            }
        }

        try {
            process.kill(rootPid, signal);
        } catch {
            // ignore dead/unreachable process
        }
    }

    function terminateProcessTree(proc: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
        const pid = proc.pid;
        if (!pid) {
            return;
        }

        if (process.platform === 'win32') {
            try {
                // /T also terminates child processes on Windows.
                spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
            } catch {
                try {
                    proc.kill(signal);
                } catch {
                    // ignore
                }
            }
            return;
        }

        signalPosixProcessTree(pid, signal);
    }

    function stopChildProcess(proc: ChildProcess) {
        if (proc.pid) {
            mutedProcessPids.add(proc.pid);
        }
        terminateProcessTree(proc, 'SIGINT');
        setTimeout(() => terminateProcessTree(proc, 'SIGTERM'), 500);
        setTimeout(() => terminateProcessTree(proc, 'SIGKILL'), 1500);
    }

    function interruptChildProcess(proc: ChildProcess) {
        if (proc.pid) {
            mutedProcessPids.add(proc.pid);
        }
        terminateProcessTree(proc, 'SIGINT');
    }

    function stopAllCaptures(showMessage = true) {
        for (const watcher of Array.from(activeWatchers)) {
            try {
                watcher.close();
            } catch {
                // ignore
            }
            activeWatchers.delete(watcher);
        }

        for (const c of Array.from(runningChildren)) {
            stopChildProcess(c);
        }

        if (showMessage) {
            outputChannel.appendLine('Captures stopped by user action.');
        }
    }

    async function runAndCapture(command: string) {
        if (!LogDashboard.currentPanel) {
            LogDashboard.createOrShow(context.extensionUri);
        }

        const workspaceCwd = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
            ? vscode.workspace.workspaceFolders[0].uri.fsPath
            : undefined;

        // Create a pseudoterminal so the output is visible in an integrated terminal
        const writeEmitter = new vscode.EventEmitter<string>();
        const closeEmitter = new vscode.EventEmitter<void>();
        let child: ChildProcess | undefined;

        const pty: vscode.Pseudoterminal = {
            onDidWrite: writeEmitter.event,
            onDidClose: closeEmitter.event,
            open: () => {
                // spawn the child process and forward output
                child = spawn(command, {
                    shell: true,
                    cwd: workspaceCwd,
                    env: process.env,
                    detached: process.platform !== 'win32'
                });
                outputChannel.appendLine(`Starting command: ${command}`);
                writeEmitter.fire('Press Ctrl+C in this terminal to interrupt the process.\r\n');
                if (workspaceCwd) {
                    outputChannel.appendLine(`Working directory: ${workspaceCwd}`);
                }

                if (!child) {
                    writeEmitter.fire('\n[error] Could not start the process.\n');
                    closeEmitter.fire();
                    return;
                }

                const spawnedChild = child;
                if (spawnedChild.pid) {
                    mutedProcessPids.delete(spawnedChild.pid);
                }

                runningChildren.add(spawnedChild);

                spawnedChild.on('close', () => {
                    if (spawnedChild.pid) {
                        mutedProcessPids.delete(spawnedChild.pid);
                    }
                    runningChildren.delete(spawnedChild);
                });

                function cleanLine(raw: string): string {
                    try {
                        let s = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
                        s = s.replace(/\x1B\][0-9]*;[^\x07]*\x07/g, '');
                        s = s.replace(/\]633;[^\x07]*\x07/g, '');
                        s = s.replace(/\]133;[^\x07]*\x07/g, '');
                        s = s.replace(/\x1B\[\?2004[hl]/g, '');
                        s = s.replace(/\[\?2004[hl]/g, '');
                        s = s.replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/g, '');
                        return s.trimEnd();
                    } catch {
                        return raw;
                    }
                }

                function detectLevel(line: string, fallback: LogLevel): LogLevel {
                    // 1. Tenta fazer o parse da linha como JSON
                    try {
                        const parsedData = JSON.parse(line);

                        if (parsedData && parsedData?.level) {
                            const exactLevel = parsedData?.level.toUpperCase();

                            if (['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'].includes(exactLevel)) {
                                return exactLevel as LogLevel;
                            }
                        }
                    } catch (e) {
                    }

                    const upper = line.toUpperCase();

                    if (upper.includes('ERROR') || upper.includes('EXCEPTION') || upper.includes('FAIL')) {
                        return 'ERROR';
                    }
                    if (upper.includes('WARN') || upper.includes('WARNING') || upper.includes('AVISO')) {
                        return 'WARN';
                    }
                    if (upper.includes('INFO')) {
                        return 'INFO';
                    }
                    if (upper.includes('DEBUG')) {
                        return 'DEBUG';
                    }
                    if (upper.includes('TRACE')) {
                        return 'TRACE';
                    }

                    return fallback;
                }

                function terminalColor(level: LogLevel): string {
                    switch (level) {
                        case 'ERROR': return '\x1b[31m';
                        case 'WARN': return '\x1b[33m';
                        case 'DEBUG': return '\x1b[36m';
                        case 'TRACE': return '\x1b[90m';
                        default: return '\x1b[32m';
                    }
                }

                function formatTerminalLine(line: string, level: LogLevel): string {
                    const now = new Date();
                    const hh = String(now.getHours()).padStart(2, '0');
                    const mm = String(now.getMinutes()).padStart(2, '0');
                    const ss = String(now.getSeconds()).padStart(2, '0');
                    const timestamp = `${hh}:${mm}:${ss}`;
                    const color = terminalColor(level);
                    const reset = '\x1b[0m';
                    return `${timestamp} ${color}[${level}]${reset} ${line}\r\n`;
                }

                function forward(stream: NodeJS.ReadableStream, overrideLevel?: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'TRACE') {
                    let buffer = '';
                    const consumeLine = (line: string) => {
                        if (line.endsWith('\r')) line = line.slice(0, -1);
                        if (line.includes('\r')) line = line.substring(line.lastIndexOf('\r') + 1);
                        const cleaned = cleanLine(line);
                        if (!cleaned.trim()) {
                            return;
                        }

                        const lineLevel = detectLevel(cleaned, overrideLevel ?? 'INFO');
                        writeEmitter.fire(formatTerminalLine(cleaned, lineLevel));
                        try { outputChannel.appendLine(`[${lineLevel}] ${cleaned}`); } catch { }
                        const pid = spawnedChild.pid;
                        const isMuted = pid ? mutedProcessPids.has(pid) : false;
                        if (!isMuted) {
                            LogDashboard.currentPanel?.addLogLine(cleaned, lineLevel);
                        }
                    };

                    stream.on('data', (chunk) => {
                        const text = String(chunk).replace(/\r(?!\n)/g, '\n');
                        buffer += text;

                        while (buffer.includes('\n')) {
                            const idx = buffer.indexOf('\n');
                            const line = buffer.substring(0, idx);
                            buffer = buffer.substring(idx + 1);
                            consumeLine(line);
                        }
                    });

                    stream.on('end', () => {
                        const rest = buffer.trim();
                        if (rest) {
                            consumeLine(rest);
                        }
                        buffer = '';
                    });
                }

                if (spawnedChild.stdout) {
                    forward(spawnedChild.stdout, 'INFO');
                }

                if (spawnedChild.stderr) {
                    forward(spawnedChild.stderr, 'ERROR');
                }

                spawnedChild.on('error', (err) => {
                    writeEmitter.fire('\n[error] ' + String(err.message || err) + '\n');
                });

                spawnedChild.on('close', (code) => {
                    outputChannel.appendLine(`Command finished with exit code ${code}`);
                    writeEmitter.fire(`\nProcess finished with exit code ${code}\n`);
                    closeEmitter.fire();
                });
            },
            handleInput: (data: string) => {
                if (!child) {
                    return;
                }

                // Ctrl+C
                if (data === '\x03') {
                    writeEmitter.fire('^C\r\n');
                    interruptChildProcess(child);
                    return;
                }

                if (child.stdin && !child.stdin.destroyed) {
                    try {
                        child.stdin.write(data);
                    } catch {
                        // ignore write errors
                    }
                }
            },
            close: () => {
                if (child && !child.killed) {
                    stopChildProcess(child);
                }
            }
        };

        const terminal = vscode.window.createTerminal({ name: `Run: ${command}`, pty });
        terminal.show();
        try { outputChannel.show(true); } catch { }
    }

    function startTailFile(filePath: string) {
        if (!LogDashboard.currentPanel) {
            LogDashboard.createOrShow(context.extensionUri);
        }

        let buffer = '';
        let lastSize = 0;

        const readRange = (start: number, endExclusive: number) => {
            if (endExclusive <= start) {
                return;
            }

            const rs = fs.createReadStream(filePath, {
                encoding: 'utf8',
                start,
                end: endExclusive - 1
            });

            rs.on('data', chunk => processData(String(chunk)));
            rs.on('error', () => {
                // ignore stream read errors
            });
        };

        fs.stat(filePath, (err, stats) => {
            if (err) {
                vscode.window.showErrorMessage('Could not access file: ' + err.message);
                return;
            }

            const start = Math.max(0, stats.size - 10 * 1024);
            lastSize = stats.size;
            readRange(start, stats.size);
        });

        const watcher = fs.watch(filePath, (eventType) => {
            if (eventType !== 'change') return;

            fs.stat(filePath, (err, stats) => {
                if (err) return;

                if (stats.size < lastSize) {
                    lastSize = 0;
                }

                if (stats.size > lastSize) {
                    readRange(lastSize, stats.size);
                    lastSize = stats.size;
                }
            });
        });

        activeWatchers.add(watcher);
        watcher.on('error', () => {
            activeWatchers.delete(watcher);
        });

        function processData(chunk: string) {
            buffer += chunk;
            while (buffer.includes('\n')) {
                const idx = buffer.indexOf('\n');
                let line = buffer.substring(0, idx);
                buffer = buffer.substring(idx + 1);
                if (line.endsWith('\r')) line = line.slice(0, -1);
                if (line.includes('\r')) line = line.substring(line.lastIndexOf('\r') + 1);
                const clean = line.trimEnd();
                if (clean && LogDashboard.currentPanel) {
                    LogDashboard.currentPanel.addLogLine(clean);
                }
            }
        }

        outputChannel.appendLine(`Following file: ${path.basename(filePath)}`);
        outputChannel.show(true);
    }
}

export function deactivate() {
    if (stopAllCapturesGlobal) {
        stopAllCapturesGlobal();
    }
}