import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import { LogLevel } from '../models/logEntry';
import { detectLevel } from '../logParser';
import { cleanLine } from './lineCleaner';
import { stopChildProcess, interruptChildProcess } from './processTree';
import { LogPipeline } from './logPipeline';
import { SessionRegistry } from './sessionRegistry';
import * as config from './config';

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
    const color = terminalColor(level);
    const reset = '\x1b[0m';
    return `${hh}:${mm}:${ss} ${color}[${level}]${reset} ${line}\r\n`;
}

// Minimal environment for when the user opts out of handing the child the
// full (potentially secret-laden) process.env.
const MINIMAL_ENV_KEYS = [
    'PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'USER', 'SHELL',
    'SystemRoot', 'ComSpec', 'USERPROFILE', 'APPDATA', 'TEMP', 'TMP'
];

function buildChildEnv(): NodeJS.ProcessEnv {
    if (config.inheritEnvironment()) {
        return process.env;
    }
    const env: NodeJS.ProcessEnv = {};
    for (const key of MINIMAL_ENV_KEYS) {
        const value = process.env[key];
        if (value !== undefined) {
            env[key] = value;
        }
    }
    return env;
}

let nextSessionId = 1;

/**
 * Runs a shell command inside a vscode.Pseudoterminal, echoing colored output
 * to the terminal while feeding cleaned + redacted lines into the LogPipeline.
 * Owns the child-process lifecycle: registration in the SessionRegistry,
 * muting during intentional kills, and cross-platform tree termination.
 */
export class CaptureManager {
    private readonly runningChildren = new Set<ChildProcess>();
    private readonly mutedProcessPids = new Set<number>();

    constructor(
        private readonly pipeline: LogPipeline,
        private readonly registry: SessionRegistry,
        private readonly outputChannel: vscode.OutputChannel
    ) { }

    get hasRunning(): boolean {
        return this.runningChildren.size > 0;
    }

    stopAll(): void {
        for (const child of [...this.runningChildren]) {
            stopChildProcess(child, this.mutedProcessPids);
        }
    }

    runAndCapture(command: string): void {
        const workspaceCwd = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
            ? vscode.workspace.workspaceFolders[0].uri.fsPath
            : undefined;

        const sessionId = `cmd-${nextSessionId++}`;
        const writeEmitter = new vscode.EventEmitter<string>();
        const closeEmitter = new vscode.EventEmitter<void>();
        let child: ChildProcess | undefined;

        const pty: vscode.Pseudoterminal = {
            onDidWrite: writeEmitter.event,
            onDidClose: closeEmitter.event,
            open: () => {
                child = spawn(command, {
                    shell: true,
                    cwd: workspaceCwd,
                    env: buildChildEnv(),
                    detached: process.platform !== 'win32'
                });
                this.outputChannel.appendLine(`Starting command: ${command}`);
                writeEmitter.fire('Press Ctrl+C in this terminal to interrupt the process.\r\n');
                if (workspaceCwd) {
                    this.outputChannel.appendLine(`Working directory: ${workspaceCwd}`);
                }

                if (!child) {
                    writeEmitter.fire('\n[error] Could not start the process.\n');
                    closeEmitter.fire();
                    return;
                }

                const spawnedChild = child;
                if (spawnedChild.pid) {
                    this.mutedProcessPids.delete(spawnedChild.pid);
                }

                this.runningChildren.add(spawnedChild);
                this.registry.register({
                    id: sessionId,
                    kind: 'command',
                    label: command,
                    startedAt: Date.now(),
                    status: 'running',
                    stop: () => {
                        if (!spawnedChild.killed) {
                            stopChildProcess(spawnedChild, this.mutedProcessPids);
                        }
                    }
                });

                const forward = (stream: NodeJS.ReadableStream, overrideLevel?: LogLevel) => {
                    let buffer = '';
                    const consumeLine = (line: string) => {
                        if (line.endsWith('\r')) { line = line.slice(0, -1); }
                        if (line.includes('\r')) { line = line.substring(line.lastIndexOf('\r') + 1); }
                        const cleaned = cleanLine(line);
                        if (!cleaned.trim()) {
                            return;
                        }

                        const { text, redacted } = this.pipeline.redact(cleaned);
                        const lineLevel = detectLevel(text, overrideLevel ?? 'INFO');
                        writeEmitter.fire(formatTerminalLine(text, lineLevel));
                        try { this.outputChannel.appendLine(`[${lineLevel}] ${text}`); } catch { }

                        const pid = spawnedChild.pid;
                        const isMuted = pid ? this.mutedProcessPids.has(pid) : false;
                        if (!isMuted) {
                            this.pipeline.ingestPrepared(text, {
                                source: command,
                                overrideLevel: lineLevel,
                                sessionId,
                                redacted
                            });
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
                };

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
                    if (spawnedChild.pid) {
                        this.mutedProcessPids.delete(spawnedChild.pid);
                    }
                    this.runningChildren.delete(spawnedChild);
                    this.registry.remove(sessionId);
                    this.outputChannel.appendLine(`Command finished with exit code ${code}`);
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
                    interruptChildProcess(child, this.mutedProcessPids);
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
                    stopChildProcess(child, this.mutedProcessPids);
                }
            }
        };

        const terminal = vscode.window.createTerminal({ name: `Run: ${command}`, pty });
        terminal.show();
        try { this.outputChannel.show(true); } catch { }
    }
}
